"""SQLite format-3 acceptance cases executed from Python.

Capability evidence comes from external engines only: the Python `sqlite3`
module, `better-sqlite3` through `bridge.mjs`, and `PRAGMA integrity_check`.
Each capability is exercised in both directions: bytes we write are read by an
external engine, and bytes an external engine writes are read by our reader.
"""

from __future__ import annotations

import sqlite3
import unittest

from support import (
    Workspace,
    build,
    call,
    columns,
    insert,
    native_index,
    native_rows,
    native_schema,
    oracle,
    table,
)


def query(path, sql: str):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def integrity(path) -> str:
    return query(path, "pragma integrity_check")[0][0]


def page_size(path) -> int:
    return query(path, "pragma page_size")[0][0]


def python_value(value):
    """Converts one tagged writer value into a value the stdlib module accepts."""
    if isinstance(value, dict):
        if "$i64" in value:
            return int(value["$i64"])
        if "$blob" in value:
            return bytes.fromhex(value["$blob"])
    return value


class Format3Test(unittest.TestCase):
    def test_page_header_and_page_size(self) -> None:
        with Workspace("header") as space:
            build(space.path, [table("h", columns()), insert("h", [{"$omit": True}, "one", 1.25, None])])
            self.assertEqual(page_size(space.path), 4096)
            self.assertEqual(query(space.path, "pragma journal_mode")[0][0], "delete")
            self.assertEqual(query(space.path, "select count(*) from sqlite_master")[0][0], 1)
            self.assertEqual(integrity(space.path), "ok")

            external = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(external)
            try:
                connection.execute("pragma page_size = 2048")
                connection.execute("create table e (id integer primary key, label text)")
                connection.execute("insert into e (label) values ('external-one')")
                connection.commit()
            finally:
                connection.close()

            expected = page_size(external)
            meta = call("meta", {"path": str(external)})
            self.assertEqual(meta["pageSize"], expected)
            self.assertEqual(meta["bytes"] % expected, 0)
            rows = native_rows(external, "e")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["columns"][1]["value"], "external-one")

    def test_leaf_split_divider_and_rowid_order(self) -> None:
        with Workspace("split") as space:
            steps = [table("s", columns())]
            steps += [insert("s", [{"$omit": True}, f"row-{i}", i / 2, None]) for i in range(1, 1201)]
            build(space.path, steps, page_size=1024)

            external_rowids = [row[0] for row in query(space.path, "select rowid from s order by rowid")]
            self.assertEqual(len(external_rowids), 1200)
            self.assertEqual(query(space.path, "select rowid, label from s order by rowid desc limit 1")[0], (1200, "row-1200"))
            self.assertEqual(integrity(space.path), "ok")

            rows = native_rows(space.path, "s")
            self.assertEqual([int(row["rowid"]) for row in rows], external_rowids)

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("pragma page_size = 1024")
                connection.execute("create table s (id integer primary key, label text, score real, payload blob)")
                connection.executemany("insert into s (label, score) values (?, ?)", [(f"row-{i}", i / 2) for i in range(1, 1201)])
                connection.commit()
            finally:
                connection.close()

            external_rowids = [row[0] for row in query(mirrored_path, "select rowid from s order by rowid")]
            mirrored = native_rows(mirrored_path, "s")
            self.assertEqual(len(mirrored), 1200)
            self.assertEqual([int(row["rowid"]) for row in mirrored], external_rowids)

    def test_overflow_payload_round_trip(self) -> None:
        with Workspace("overflow") as space:
            blob = "07" * 3000
            build(space.path, [table("o", columns()), insert("o", [{"$omit": True}, "big", 1, {"$blob": blob}])], page_size=512)

            expected = oracle(space.path, "select length(payload) as n, hex(payload) as body from o")
            self.assertEqual(integrity(space.path), "ok")

            rows = native_rows(space.path, "o")
            self.assertEqual(rows[0]["columns"][3]["kind"], "blob")
            self.assertEqual(len(rows[0]["columns"][3]["value"]), expected[0]["n"] * 2)
            self.assertEqual(rows[0]["columns"][3]["value"], expected[0]["body"])

            mirrored_path = space.path.parent / "external.sqlite3"
            external_blob = bytes([9]) * 3000
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("pragma page_size = 512")
                connection.execute("create table o (id integer primary key, label text, score real, payload blob)")
                connection.execute("insert into o (label, score, payload) values ('external-big', 1, ?)", (external_blob,))
                connection.commit()
            finally:
                connection.close()

            mirrored = native_rows(mirrored_path, "o")
            self.assertEqual(mirrored[0]["columns"][3]["kind"], "blob")
            self.assertEqual(bytes.fromhex(mirrored[0]["columns"][3]["value"]), external_blob)

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

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("create table v (id integer primary key, kind text, value blob)")
                connection.executemany(
                    "insert into v (kind, value) values (?, ?)",
                    [(kind, python_value(value)) for kind, value in payloads],
                )
                connection.commit()
            finally:
                connection.close()

            external_kinds = [row[0] for row in query(mirrored_path, "select typeof(value) from v order by rowid")]
            mirrored = native_rows(mirrored_path, "v")
            self.assertEqual([row["columns"][2]["kind"] for row in mirrored], external_kinds)
            self.assertEqual(mirrored[5]["columns"][2]["value"], "案例-明")

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

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("create table r (id integer primary key, score real, maybe numeric)")
                connection.execute("insert into r (score, maybe) values (7, 3)")
                connection.execute("insert into r (score, maybe) values ('7.5', '3.5')")
                connection.commit()
            finally:
                connection.close()

            external_values = query(mirrored_path, "select score, maybe from r order by rowid")
            external_kinds = query(mirrored_path, "select typeof(maybe) from r order by rowid")
            mirrored = native_rows(mirrored_path, "r")
            # SQLite stores integral REAL values as integers on disk, so the record-level
            # reader sees `integer` where a SQL read reports `real`. Values must agree.
            self.assertEqual(
                [
                    (
                        float(row["columns"][1]["value"]),
                        float(row["columns"][2]["value"]),
                    )
                    for row in mirrored
                ],
                [(float(score), float(maybe)) for score, maybe in external_values],
            )
            self.assertEqual([row["columns"][2]["kind"] for row in mirrored], [kind for (kind,) in external_kinds])

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
            external_rowids = query(space.path, "select rowid from a order by rowid")
            self.assertEqual(external_rowids, [(1,), (100,)])
            self.assertEqual(query(space.path, "select rowid, id from a order by rowid"), [(1, 1), (100, 100)])

            rows = native_rows(space.path, "a")
            self.assertEqual([int(row["rowid"]) for row in rows], [row[0] for row in external_rowids])

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("create table a (id integer primary key, label text, score real, payload blob)")
                connection.execute("insert into a (id, label) values (1, 'auto')")
                connection.execute("insert into a (id, label) values (250, 'explicit')")
                connection.commit()
            finally:
                connection.close()

            external_rowids = query(mirrored_path, "select rowid from a order by rowid")
            mirrored = native_rows(mirrored_path, "a")
            self.assertEqual([int(row["rowid"]) for row in mirrored], [row[0] for row in external_rowids])
            self.assertEqual(mirrored[1]["columns"][1]["value"], "explicit")

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

            master = query(space.path, "select name, type from sqlite_master order by name")
            self.assertEqual(
                master,
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
            self.assertEqual(names, sorted(f"{kind}:{name}" for name, kind in master))

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("create table m (id integer primary key, slug text unique, name text)")
                connection.execute("create index m_name on m (name)")
                connection.execute("create unique index m_name_unique on m (name)")
                connection.execute("insert into m (slug, name) values ('a', 'alpha')")
                connection.commit()
            finally:
                connection.close()

            external_master = query(mirrored_path, "select name, type from sqlite_master order by name")
            mirrored = sorted(f"{item['kind']}:{item['name']}" for item in native_schema(mirrored_path))
            self.assertEqual(mirrored, sorted(f"{kind}:{name}" for name, kind in external_master))

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

            rows = native_rows(space.path, "u")
            self.assertEqual(len(rows), 19)
            self.assertEqual(rows[4]["columns"][1]["value"], "updated")
            self.assertEqual(rows[4]["columns"][2]["value"], 5.5)

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path, isolation_level=None)
            try:
                connection.execute("create table u (id integer primary key, label text, score real, payload blob)")
                connection.execute("begin")
                connection.executemany("insert into u (label, score) values (?, ?)", [(f"r{i}", i) for i in range(1, 21)])
                connection.execute("rollback")
                connection.execute("begin")
                connection.executemany("insert into u (label, score) values (?, ?)", [(f"r{i}", i) for i in range(1, 21)])
                connection.execute("commit")
                connection.execute("begin")
                connection.execute("insert into u (label, score) values ('rolled-back', 0)")
                connection.execute("rollback")
                connection.execute("update u set label = 'updated', score = 5.5 where rowid = 5")
                connection.execute("delete from u where rowid = 7")
            finally:
                connection.close()

            external_rows = query(mirrored_path, "select rowid, label from u order by rowid")
            mirrored = native_rows(mirrored_path, "u")
            self.assertEqual(
                [(int(row["rowid"]), row["columns"][1]["value"]) for row in mirrored],
                [(rowid, label) for rowid, label in external_rows],
            )

    def test_without_rowid_rows_are_read_in_key_order(self) -> None:
        with Workspace("without-rowid") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute("create table wo (k text primary key, v integer) without rowid")
                connection.executemany("insert into wo values (?, ?)", [("b", 2), ("a", 1), ("c", 3)])
                connection.commit()
            finally:
                connection.close()

            external = query(space.path, "select k, v from wo order by k")
            rows = call("readWithoutRowid", {"path": str(space.path), "table": "wo"})
            self.assertEqual(
                [(row[0]["value"], int(row[1]["value"])) for row in rows],
                [(key, value) for key, value in external],
            )
            self.assertEqual([column["kind"] for column in rows[0]], ["text", "integer"])

    def test_secondary_index_matches_external_indexed_by(self) -> None:
        with Workspace("index") as space:
            steps = [table("ix", columns()), {"kind": "createIndex", "name": "i_label", "table": "ix", "columns": ["label"]}]
            steps += [
                insert("ix", [{"$omit": True}, f"label-{(i * 37) % 1200:04d}", i / 2, None]) for i in range(1, 1201)
            ]
            build(space.path, steps, page_size=1024)

            meta = call("meta", {"path": str(space.path)})
            self.assertGreater(meta["bytes"] / meta["pageSize"], 4)
            external_order = query(space.path, "select rowid, label from ix indexed by i_label order by label, rowid")
            self.assertEqual(len(external_order), 1200)
            self.assertEqual(integrity(space.path), "ok")

            scanned = native_index(space.path, "i_label")
            self.assertEqual(
                [(int(row["rowid"]), row["columns"][0]["value"]) for row in scanned],
                [(rowid, label) for rowid, label in external_order],
            )

            connection = sqlite3.connect(space.path)
            try:
                connection.execute("drop index i_label")
                connection.execute("create index i_label on ix (label)")
                connection.commit()
            finally:
                connection.close()
            rebuilt = query(space.path, "select rowid, label from ix indexed by i_label order by label, rowid")
            self.assertEqual(rebuilt, external_order)

            mirrored_path = space.path.parent / "external.sqlite3"
            connection = sqlite3.connect(mirrored_path)
            try:
                connection.execute("pragma page_size = 1024")
                connection.execute("create table ix (id integer primary key, label text, score real, payload blob)")
                connection.execute("create index i_label on ix (label)")
                connection.executemany(
                    "insert into ix (label, score) values (?, ?)",
                    [(f"label-{(i * 53) % 1200:04d}", i / 2) for i in range(1, 1201)],
                )
                connection.commit()
            finally:
                connection.close()

            expected = query(mirrored_path, "select rowid, label from ix indexed by i_label order by label, rowid")
            mirrored = native_index(mirrored_path, "i_label")
            self.assertEqual(
                [(int(row["rowid"]), row["columns"][0]["value"]) for row in mirrored],
                [(rowid, label) for rowid, label in expected],
            )


if __name__ == "__main__":
    unittest.main()
