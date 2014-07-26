"""Feature tests for the sqlite-pyo3 bindings.

Run inside a clean virtual environment that has the wheel installed:

    python -m unittest discover -s projects/sqlite.ts/packages/sqlite-harness/stages/python -v

Every assertion is made against an external truth source: CPython's standard
library `sqlite3` (including `PRAGMA integrity_check`), never against the
binding that produced the file.
"""

import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from sqlite_format3 import SqliteDatabase, SqliteWriter


def integrity_check(path: Path) -> str:
    connection = sqlite3.connect(path)
    try:
        return connection.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        connection.close()


def count_rows(path: Path, table: str) -> int:
    connection = sqlite3.connect(path)
    try:
        return connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    finally:
        connection.close()


class FeatureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="sqlite-format3-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_write_read_roundtrip_1000(self) -> None:
        path = self.directory / "bench.sqlite3"
        writer = SqliteWriter.create(4096)
        writer.create_table(
            "bench",
            [
                {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                {"name": "label", "declaredType": "TEXT", "notNull": True},
                {"name": "score", "declaredType": "REAL"},
            ],
        )
        for index in range(1, 1001):
            writer.insert("bench", [index, f"row-{index}", index / 10])
        writer.save(str(path))

        self.assertEqual(integrity_check(path), "ok")
        self.assertEqual(count_rows(path, "bench"), 1000)

        database = SqliteDatabase.open(str(path))
        self.assertGreater(database.ping(), 0)
        self.assertTrue(database.sqlite_version().startswith("3."))
        rows = database.table("bench")
        self.assertEqual(len(rows), 1000)
        self.assertEqual(rows[0]["rowid"], 1)
        # `INTEGER PRIMARY KEY` is a rowid alias, so the stored payload has no
        # value for it and the rowid carries the identity.
        self.assertEqual([cell["kind"] for cell in rows[0]["columns"]], ["null", "text", "real"])
        self.assertEqual(rows[0]["columns"][1]["value"], "row-1")
        self.assertAlmostEqual(rows[0]["columns"][2]["value"], 0.1)

    def test_wal_visible(self) -> None:
        source = self.directory / "wal-source.sqlite3"
        connection = sqlite3.connect(source, isolation_level=None)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE wal_t (id INTEGER PRIMARY KEY, label TEXT)")
        connection.executemany("INSERT INTO wal_t (label) VALUES (?)", [(f"r{index}",) for index in range(500)])
        connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
        fixture = self.directory / "wal-fixture.sqlite3"
        shutil.copyfile(source, fixture)
        wal = Path(str(source) + "-wal")
        self.assertTrue(wal.is_file(), "the WAL sidecar must exist while the writer is open")
        shutil.copyfile(wal, Path(str(fixture) + "-wal"))
        connection.close()

        database = SqliteDatabase.open(str(fixture))
        rows = database.table("wal_t")
        self.assertEqual(len(rows), 500)
        self.assertEqual(rows[-1]["columns"][1]["value"], "r499")

    def test_hot_journal_rollback(self) -> None:
        source = self.directory / "journal-source.sqlite3"
        connection = sqlite3.connect(source, isolation_level=None)
        connection.execute("CREATE TABLE journal_t (id INTEGER PRIMARY KEY, label TEXT)")
        connection.executemany("INSERT INTO journal_t (label) VALUES (?)", [(f"keep-{index}",) for index in range(1000)])
        connection.execute("BEGIN")
        connection.executemany("INSERT INTO journal_t (label) VALUES (?)", [(f"rolled-{index}",) for index in range(500)])
        fixture = self.directory / "journal-fixture.sqlite3"
        shutil.copyfile(source, fixture)
        journal = Path(str(source) + "-journal")
        self.assertTrue(journal.is_file(), "a rollback journal must exist inside the transaction")
        shutil.copyfile(journal, Path(str(fixture) + "-journal"))
        connection.execute("ROLLBACK")
        connection.close()

        database = SqliteDatabase.open(str(fixture))
        rows = database.table("journal_t")
        self.assertEqual(len(rows), 1000)
        self.assertEqual(rows[0]["columns"][1]["value"], "keep-0")
        self.assertNotIn("rolled-0", [row["columns"][1]["value"] for row in rows])

    def test_without_rowid(self) -> None:
        path = self.directory / "without-rowid.sqlite3"
        connection = sqlite3.connect(path)
        connection.execute("CREATE TABLE wr (id INTEGER PRIMARY KEY, label TEXT) WITHOUT ROWID")
        connection.executemany("INSERT INTO wr (id, label) VALUES (?, ?)", [(index, f"wr-{index}") for index in range(1, 5)])
        connection.commit()
        connection.close()

        self.assertEqual(integrity_check(path), "ok")
        database = SqliteDatabase.open(str(path))
        rows = database.table_without_rowid("wr")
        self.assertEqual([[cell["value"] for cell in row] for row in rows], [[1, "wr-1"], [2, "wr-2"], [3, "wr-3"], [4, "wr-4"]])

    def test_utf16(self) -> None:
        path = self.directory / "utf16.sqlite3"
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA encoding='UTF-16le'")
        connection.execute("CREATE TABLE u (id INTEGER PRIMARY KEY, label TEXT)")
        connection.execute("INSERT INTO u (label) VALUES ('中文标注')")
        connection.commit()
        connection.close()

        self.assertEqual(integrity_check(path), "ok")
        database = SqliteDatabase.open(str(path))
        self.assertEqual(database.encoding(), "utf-16le")
        rows = database.table("u")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["columns"][1]["value"], "中文标注")


if __name__ == "__main__":
    unittest.main()
