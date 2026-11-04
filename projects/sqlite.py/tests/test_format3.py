"""SQLite format-3 acceptance cases executed from Python.

Every assertion is made against an external reader (Python `sqlite3` or
`better-sqlite3`) or against the native decoder through `bridge.mjs`.
"""

from __future__ import annotations

import sqlite3
import unittest

from support import Workspace, build, columns, insert, native_rows, native_schema, oracle, table


def query(path, sql: str):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def integrity(path) -> str:
    return query(path, "pragma integrity_check")[0][0]


class Format3Test(unittest.TestCase):
    def test_page_header_and_page_size(self) -> None:
        with Workspace("header") as space:
            build(space.path, [table("h", columns()), insert("h", [{"$omit": True}, "one", 1.25, None])])
            self.assertEqual(query(space.path, "pragma page_size")[0][0], 4096)
            self.assertEqual(query(space.path, "pragma journal_mode")[0][0], "delete")
            self.assertEqual(query(space.path, "select count(*) from sqlite_master")[0][0], 1)
            self.assertEqual(integrity(space.path), "ok")

    def test_leaf_split_divider_and_rowid_order(self) -> None:
        with Workspace("split") as space:
            steps = [table("s", columns())]
            steps += [insert("s", [{"$omit": True}, f"row-{i}", i / 2, None]) for i in range(1, 1201)]
            build(space.path, steps, page_size=1024)

            self.assertEqual(query(space.path, "select count(*) from s")[0][0], 1200)
            self.assertEqual([row[0] for row in query(space.path, "select rowid from s order by rowid limit 3")], [1, 2, 3])
            self.assertEqual(query(space.path, "select rowid, label from s order by rowid desc limit 1")[0], (1200, "row-1200"))
            self.assertEqual(integrity(space.path), "ok")

            rows = native_rows(space.path, "s")
            self.assertEqual(len(rows), 1200)
            self.assertEqual(rows[0]["rowid"], "1")
            self.assertEqual(rows[-1]["rowid"], "1200")

    def test_overflow_payload_round_trip(self) -> None:
        with Workspace("overflow") as space:
            blob = "07" * 3000
            build(space.path, [table("o", columns()), insert("o", [{"$omit": True}, "big", 1, {"$blob": blob}])], page_size=512)

            self.assertEqual(oracle(space.path, "select length(payload) as n from o"), [{"n": 3000}])
            self.assertEqual(integrity(space.path), "ok")

            rows = native_rows(space.path, "o")
            self.assertEqual(rows[0]["columns"][0]["kind"], "null")
            self.assertEqual(rows[0]["columns"][3]["kind"], "blob")
            self.assertEqual(len(rows[0]["columns"][3]["value"]), 3000 * 2)

    def test_serial_types_preserve_storage_class(self) -> None:
        with Workspace("serial") as space:
            payloads = [
                ["null", None],
                ["empty-text", ""],
                ["min-int", {"$i64": "-9223372036854775808"}],
                ["max-int", {"$i64": "9223372036854775807"}],
                ["real", 2.5],
                ["unicode", "案例-明"],
                ["empty-blob", {"$blob": ""}],
                ["blob", {"$blob": "010203"}],
            ]
            steps = [
                table(
                    "v",
                    [
                        {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                        {"name": "kind", "declaredType": "TEXT"},
                        {"name": "value", "declaredType": "BLOB"},
                    ],
                )
            ]
            steps += [insert("v", [{"$omit": True}, kind, value]) for kind, value in payloads]
            build(space.path, steps)

            kinds = [row[0] for row in query(space.path, "select typeof(value) from v order by rowid")]
            self.assertEqual(kinds, ["null", "text", "integer", "integer", "real", "text", "blob", "blob"])
            self.assertEqual(
                [row[0] for row in query(space.path, "select value from v where rowid in (3, 4) order by rowid")],
                [-9223372036854775808, 9223372036854775807],
            )
            self.assertEqual(integrity(space.path), "ok")

            rows = native_rows(space.path, "v")
            self.assertEqual([row["columns"][2]["kind"] for row in rows], kinds)
            self.assertEqual(rows[5]["columns"][2]["value"], "案例-明")

    def test_real_affinity_on_numeric_text(self) -> None:
        with Workspace("affinity") as space:
            build(
                space.path,
                [
                    table(
                        "r",
                        [
                            {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                            {"name": "score", "declaredType": "REAL"},
                            {"name": "maybe", "declaredType": "NUMERIC"},
                        ],
                    ),
                    insert("r", [{"$omit": True}, 7, 3]),
                    insert("r", [{"$omit": True}, "7.5", "3.5"]),
                ],
            )

            self.assertEqual(
                oracle(space.path, "select typeof(score) as s, typeof(maybe) as m, score, maybe from r order by rowid"),
                [
                    {"s": "real", "m": "integer", "score": 7, "maybe": 3},
                    {"s": "real", "m": "real", "score": 7.5, "maybe": 3.5},
                ],
            )

    def test_integer_primary_key_is_rowid_alias(self) -> None:
        with Workspace("rowid") as space:
            result = build(
                space.path,
                [
                    table("a", columns()),
                    insert("a", [{"$omit": True}, "auto", 1, None]),
                    insert("a", [100, "explicit", 2, None]),
                ],
            )
            self.assertEqual(result["rowids"], [1, 100])
            self.assertEqual(
                query(space.path, "select rowid, id from a order by rowid"),
                [(1, 1), (100, 100)],
            )
            rows = native_rows(space.path, "a")
            self.assertEqual(rows[0]["columns"][0]["kind"], "null")

    def test_sqlite_master_index_and_autoindex(self) -> None:
        with Workspace("schema") as space:
            build(
                space.path,
                [
                    table(
                        "m",
                        [
                            {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                            {"name": "slug", "declaredType": "TEXT", "unique": True},
                            {"name": "name", "declaredType": "TEXT"},
                        ],
                    ),
                    {"kind": "createIndex", "name": "m_name", "table": "m", "columns": ["name"]},
                    {"kind": "createIndex", "name": "m_name_unique", "table": "m", "columns": ["name"], "unique": True},
                    insert("m", [{"$omit": True}, "a", "alpha"]),
                ],
            )

            self.assertEqual(
                query(space.path, "select name, type from sqlite_master order by name"),
                [
                    ("m", "table"),
                    ("m_name", "index"),
                    ("m_name_unique", "index"),
                    ("sqlite_autoindex_m_1", "index"),
                ],
            )
            self.assertEqual(
                query(space.path, "select name, origin from pragma_index_list('m') order by name"),
                [("m_name", "c"), ("m_name_unique", "c"), ("sqlite_autoindex_m_1", "u")],
            )

            names = sorted(f"{item['kind']}:{item['name']}" for item in native_schema(space.path))
            self.assertEqual(names, ["index:m_name", "index:m_name_unique", "index:sqlite_autoindex_m_1", "table:m"])

    def test_update_delete_rollback(self) -> None:
        with Workspace("mutate") as space:
            steps = [table("u", columns())]
            steps += [insert("u", [{"$omit": True}, f"r{i}", i, None]) for i in range(1, 21)]
            steps += [
                {"kind": "begin"},
                insert("u", [{"$omit": True}, "rolled-back", 0, None]),
                {"kind": "rollback"},
                {"kind": "update", "table": "u", "rowid": 5, "slots": [{"keep": True}, {"set": "updated"}, {"set": 5.5}, {"keep": True}]},
                {"kind": "delete", "table": "u", "rowid": 7},
            ]
            build(space.path, steps)

            self.assertEqual(query(space.path, "select count(*) from u")[0][0], 19)
            self.assertEqual(query(space.path, "select label, score from u where rowid = 5"), [("updated", 5.5)])
            self.assertEqual(query(space.path, "select count(*) from u where rowid = 7")[0][0], 0)
            self.assertEqual(query(space.path, "select count(*) from u where label = 'rolled-back'")[0][0], 0)
            self.assertEqual(integrity(space.path), "ok")

    def test_without_rowid_is_rejected_explicitly(self) -> None:
        with Workspace("without-rowid") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute("create table wo (k text primary key, v integer) without rowid")
                connection.execute("insert into wo values ('a', 1)")
                connection.commit()
            finally:
                connection.close()

            with self.assertRaisesRegex(Exception, "WITHOUT ROWID|without rowid|index b-tree|unsupported"):
                native_rows(space.path, "wo")


if __name__ == "__main__":
    unittest.main()
