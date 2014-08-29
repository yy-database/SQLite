"""WAL and rollback-journal recovery cases executed from Python."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import unittest

from support import Workspace, build, columns, insert, native_rows, table


def seed(path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute("create table j (id integer primary key, label text)")
        connection.executemany("insert into j (label) values (?)", [("committed-one",), ("committed-two",)])
        connection.commit()
    finally:
        connection.close()


class WalJournalTest(unittest.TestCase):
    def test_committed_wal_frames_are_visible(self) -> None:
        with Workspace("wal") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute("pragma journal_mode = wal")
                connection.execute("create table w (id integer primary key, label text)")
                connection.executemany("insert into w (label) values (?)", [(f"w-{i}",) for i in range(1, 6)])
                connection.commit()

                wal_path = f"{space.path}-wal"
                self.assertTrue(os.path.exists(wal_path))
                self.assertGreater(os.path.getsize(wal_path), 32)

                rows = native_rows(space.path, "w")
                self.assertEqual(len(rows), 5)
                self.assertEqual(rows[-1]["rowid"], "5")
                self.assertEqual(connection.execute("select count(*) from w").fetchone()[0], 5)
            finally:
                connection.close()

    def test_hot_journal_rolls_partial_pages_back(self) -> None:
        with Workspace("journal") as space:
            seed(space.path)

            script = (
                "import os, sqlite3, sys\n"
                "connection = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
                "connection.execute('pragma journal_mode = delete')\n"
                "connection.execute('begin immediate')\n"
                "connection.execute(\"insert into j (label) values ('uncommitted')\")\n"
                "os._exit(9)\n"
            )
            result = subprocess.run([sys.executable, "-c", script, str(space.path)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

            journal_path = f"{space.path}-journal"
            self.assertTrue(os.path.exists(journal_path))
            self.assertGreaterEqual(os.path.getsize(journal_path), 512)

            rows = native_rows(space.path, "j")
            self.assertEqual(len(rows), 2)
            self.assertEqual([row["columns"][1]["value"] for row in rows], ["committed-one", "committed-two"])

            connection = sqlite3.connect(space.path)
            try:
                self.assertEqual(connection.execute("select count(*) from j").fetchone()[0], 2)
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
