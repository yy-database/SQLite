"""Edge-case migration from the former `yydb` SQLite acceptance suite.

External truth: Python `sqlite3` writes or replays every corpus and every case
asserts `PRAGMA integrity_check`, `PRAGMA page_size`, `PRAGMA page_count`, or
`PRAGMA freelist_count` against the file this bridge produced.
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path

from support import call, columns, insert, table, Workspace


def query(path: Path, sql: str) -> list[tuple]:
    connection = sqlite3.connect(path)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def header_page_size(data: bytes) -> int:
    raw = int.from_bytes(data[16:18], "big")
    return 65536 if raw == 1 else raw


class EdgeCaseTest(unittest.TestCase):
    def test_page_size_65536_round_trips(self) -> None:
        with Workspace("65536") as space:
            steps = [table("t", columns())]
            steps += [insert("t", [{"$omit": True}, f"row-{i}", i / 2, None]) for i in range(1, 101)]
            built = call("build", {"path": str(space.path), "pageSize": 65536, "steps": steps})
            self.assertEqual(len(built["rowids"]), 100)

            meta = call("meta", {"path": str(space.path)})
            self.assertEqual(meta["pageSize"], 65536)
            self.assertEqual(meta["bytes"] % 65536, 0)
            self.assertEqual(meta["databasePages"], meta["bytes"] // 65536)
            self.assertEqual(query(space.path, "pragma page_size")[0][0], 65536)
            self.assertEqual(query(space.path, "pragma page_count")[0][0], meta["databasePages"])
            self.assertEqual(query(space.path, "pragma integrity_check")[0][0], "ok")
            self.assertEqual(query(space.path, "select count(*) from t")[0][0], 100)

            rows = call("read", {"path": str(space.path), "table": "t"})
            self.assertEqual([row["rowid"] for row in rows], [str(i) for i in range(1, 101)])
            self.assertEqual(rows[0]["columns"][1]["value"], "row-1")

    def test_composite_primary_key_without_rowid_is_read_in_key_order(self) -> None:
        with Workspace("composite") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute(
                    "create table pairs (a text not null, b integer not null, note text, "
                    "primary key (a, b)) without rowid"
                )
                connection.executemany(
                    "insert into pairs (a, b, note) values (?, ?, ?)",
                    [("b", 2, "b-2"), ("a", 3, "a-3"), ("a", 1, "a-1"), ("c", 2, "c-2"), ("b", 1, "b-1")],
                )
                connection.commit()
                self.assertEqual(query(space.path, "pragma integrity_check")[0][0], "ok")
            finally:
                connection.close()

            expected = query(space.path, "select a, b, note from pairs order by a, b")
            rows = call("readWithoutRowid", {"path": str(space.path), "table": "pairs"})
            self.assertEqual([(row[0]["value"], int(row[1]["value"]), row[2]["value"]) for row in rows], expected)
            self.assertEqual([value["kind"] for value in rows[0]], ["text", "integer", "text"])

            connection = sqlite3.connect(space.path)
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute("insert into pairs values ('a', 1, 'dup')")
            finally:
                connection.close()

    def test_header_page_count_stays_exact_across_deletes(self) -> None:
        with Workspace("pages") as space:
            steps = [table("t", columns())]
            steps += [insert("t", [{"$omit": True}, f"row-{i}", i / 2, None]) for i in range(1, 1001)]
            steps += [{"kind": "delete", "table": "t", "rowid": i} for i in range(1, 1001, 2)]
            call("build", {"path": str(space.path), "pageSize": 512, "steps": steps})

            meta = call("meta", {"path": str(space.path)})
            self.assertEqual(meta["pageSize"], 512)
            self.assertEqual(meta["bytes"] // 512, meta["databasePages"])
            self.assertEqual(header_page_size(space.path.read_bytes()), 512)
            self.assertGreater(meta["bytes"] // 512, 1)
            self.assertEqual(query(space.path, "pragma page_count")[0][0], meta["databasePages"])
            self.assertEqual(query(space.path, "pragma integrity_check")[0][0], "ok")
            self.assertEqual(query(space.path, "select count(*) from t")[0][0], 500)

    def test_seeded_operation_stream_matches_external_sqlite(self) -> None:
        with Workspace("stream") as space:
            def lcg(seed: int):
                state = [seed]

                def next_value() -> float:
                    state[0] = (state[0] * 1664525 + 1013904223) & 0xFFFFFFFF
                    return state[0] / 0x100000000

                return next_value

            random = lcg(0x5EED)
            ids = list(range(1, 401))
            for index in range(len(ids) - 1, 0, -1):
                swap = int(random() * (index + 1))
                ids[index], ids[swap] = ids[swap], ids[index]
            updates = [{"rowid": ((n * 5 + 3) % 400) + 1, "n": (n * 7919) % 100003} for n in range(80)]
            deletes = [((n * 7 + 11) % 400) + 1 for n in range(80)]

            steps = [
                table(
                    "t",
                    [
                        {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                        {"name": "label", "declaredType": "TEXT"},
                        {"name": "n", "declaredType": "INTEGER"},
                    ],
                )
            ]
            steps += [insert("t", [rowid, f"k-{(rowid * 37) % 1000:04d}", (rowid * 31) % 997]) for rowid in ids]
            steps += [
                {"kind": "update", "table": "t", "rowid": item["rowid"], "slots": [{"keep": True}, {"keep": True}, {"set": item["n"]}]}
                for item in updates
            ]
            steps += [{"kind": "delete", "table": "t", "rowid": rowid} for rowid in deletes]
            call("build", {"path": str(space.path), "pageSize": 1024, "steps": steps})

            mirror = space.path.parent / "mirror.sqlite3"
            connection = sqlite3.connect(mirror)
            try:
                connection.execute("pragma page_size = 1024")
                connection.execute("create table t (id integer primary key, label text, n integer)")
                connection.executemany(
                    "insert into t (id, label, n) values (?, ?, ?)",
                    [(rowid, f"k-{(rowid * 37) % 1000:04d}", (rowid * 31) % 997) for rowid in ids],
                )
                connection.executemany("update t set n = ? where id = ?", [(item["n"], item["rowid"]) for item in updates])
                connection.executemany("delete from t where id = ?", [(rowid,) for rowid in deletes])
                connection.commit()
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()

            self.assertEqual(
                query(space.path, "select id, label, n from t order by id"),
                query(mirror, "select id, label, n from t order by id"),
            )
            rows = call("read", {"path": str(space.path), "table": "t"})
            self.assertEqual(
                [(int(row["rowid"]), row["columns"][1]["value"], int(row["columns"][2]["value"])) for row in rows],
                [(rowid, label, n) for rowid, label, n in query(space.path, "select id, label, n from t order by id")],
            )

    def test_rejects_non_sqlite_bytes_and_reads_the_blank_asset(self) -> None:
        root = Path(__file__).resolve().parents[3]
        asset = root / "projects" / "sqlite.ts" / "packages" / "sqlite-fixtures" / "fixtures" / "blank.sqlite"
        self.assertTrue(asset.exists())
        self.assertEqual(len(asset.read_bytes()), 4096)
        meta = call("meta", {"path": str(asset)})
        self.assertEqual(meta["pageSize"], 4096)
        self.assertEqual(meta["databasePages"], 1)
        self.assertEqual(meta["textEncoding"], 1)
        self.assertEqual(call("schema", {"path": str(asset)}), [])

        with Workspace("garbage") as space:
            space.path.write_bytes(b"not a sqlite database")
            with self.assertRaises(RuntimeError):
                call("meta", {"path": str(space.path)})
            space.path.write_bytes(b"SQLite format 3\x00" + b"\x00" * 84)
            with self.assertRaises(RuntimeError):
                call("meta", {"path": str(space.path)})


if __name__ == "__main__":
    unittest.main()
