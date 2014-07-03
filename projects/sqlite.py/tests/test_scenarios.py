"""Feature scenarios that each target one risk in the Rust SQLite implementation.

Every scenario builds its own database and judges the result with Python's
`sqlite3` module, including `PRAGMA integrity_check`. Scenario names mirror
`scripts/scenarios.json`.
"""

from __future__ import annotations

import hashlib
import random
import sqlite3
import subprocess
import sys
import unittest
from pathlib import Path

from support import Workspace, build, call, native_index, native_rows, native_schema

ROWS = 1000


def shuffled(count: int = ROWS) -> list[int]:
    generator = random.Random(7919)
    ids = list(range(1, count + 1))
    generator.shuffle(ids)
    return ids


def standard_columns() -> list[dict]:
    return [
        {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
        {"name": "label", "declaredType": "TEXT"},
        {"name": "score", "declaredType": "REAL"},
        {"name": "payload", "declaredType": "BLOB"},
        {"name": "flag", "declaredType": "INTEGER"},
    ]


def digest(hex_payload: str) -> str:
    return hashlib.sha256(bytes.fromhex(hex_payload)).hexdigest()


def standard_steps(table_name: str, ids: list[int]) -> list[dict]:
    steps = []
    for index in ids:
        flag = {"$i64": "-9223372036854775808"} if index == 1 else {"$i64": "9223372036854775807"} if index == 2 else index % 997
        payload = {"$blob": (bytes([index % 251]) * 3000).hex()} if index % 10 == 0 else None
        label = f"案例-{index}" if index % 3 == 0 else f"row-{index}"
        score = index if index % 2 == 0 else index / 7
        steps.append({"kind": "insert", "table": table_name, "values": [index, label, score, payload, flag]})
    return steps


def standard_native(path: Path, table_name: str) -> list[tuple]:
    rows = native_rows(path, table_name)
    tuples = []
    for row in rows:
        _id, label, score, payload, flag = row["columns"]
        if score["kind"] == "null":
            number = None
        elif score["kind"] == "real":
            number = float(score["value"])
        else:
            number = float(int(score["value"]))
        body = None if payload["kind"] == "null" else digest(payload["value"])
        label_text = None if label["kind"] == "null" else label["value"]
        flag_text = None if flag["kind"] == "null" else flag["value"]
        tuples.append((row["rowid"], label_text, number, body, flag_text))
    return tuples


def standard_external(connection: sqlite3.Connection, table_name: str) -> list[tuple]:
    rows = connection.execute(f"select rowid, label, score, payload, flag from {table_name} order by rowid").fetchall()
    return [
        (
            str(row[0]),
            row[1],
            None if row[2] is None else float(row[2]),
            None if row[3] is None else digest(bytes(row[3]).hex()),
            None if row[4] is None else str(row[4]),
        )
        for row in rows
    ]


class ScenarioTest(unittest.TestCase):
    def test_narrow_rows_fill_multiple_leaf_pages(self) -> None:
        with Workspace("sc-narrow") as space:
            steps = [{"kind": "createTable", "name": "n", "columns": [
                {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                {"name": "label", "declaredType": "TEXT"},
            ]}]
            steps += [{"kind": "insert", "table": "n", "values": [index, f"n-{index}"]} for index in shuffled()]
            build(space.path, steps, page_size=1024)
            meta = call("meta", {"path": str(space.path)})
            self.assertEqual(meta["pageSize"], 1024)
            self.assertGreaterEqual(meta["bytes"] / meta["pageSize"], 2)

            connection = sqlite3.connect(space.path)
            try:
                external = [(str(row[0]), row[1]) for row in connection.execute("select rowid, label from n order by rowid")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), ROWS)
            self.assertEqual([(row["rowid"], row["columns"][1]["value"]) for row in native_rows(space.path, "n")], external)

    def test_wide_rows_round_trip_overflow_payloads(self) -> None:
        with Workspace("sc-overflow") as space:
            build(space.path, [{"kind": "createTable", "name": "w", "columns": standard_columns()}] + standard_steps("w", shuffled()), page_size=1024)
            meta = call("meta", {"path": str(space.path)})
            self.assertGreater(meta["bytes"] / meta["pageSize"], 100)
            connection = sqlite3.connect(space.path)
            try:
                external = standard_external(connection, "w")
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), ROWS)
            self.assertEqual(standard_native(space.path, "w"), external)

    def test_middle_delete_keeps_interior_routing(self) -> None:
        with Workspace("sc-delete") as space:
            steps = [{"kind": "createTable", "name": "d", "columns": standard_columns()}] + standard_steps("d", shuffled())
            steps += [{"kind": "delete", "table": "d", "rowid": index} for index in range(401, 601)]
            build(space.path, steps, page_size=512)
            connection = sqlite3.connect(space.path)
            try:
                external = standard_external(connection, "d")
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), 800)
            self.assertEqual(standard_native(space.path, "d"), external)

            with Workspace("sc-delete-external") as mirrored:
                connection = sqlite3.connect(mirrored.path)
                try:
                    connection.execute("pragma page_size = 512")
                    connection.execute("create table d (id integer primary key, label text, score real, payload blob, flag integer)")
                    for index in shuffled():
                        flag = -(2**63) if index == 1 else 2**63 - 1 if index == 2 else index % 997
                        label = f"案例-{index}" if index % 3 == 0 else f"row-{index}"
                        score = index if index % 2 == 0 else index / 7
                        payload = bytes([index % 251]) * 3000 if index % 10 == 0 else None
                        connection.execute("insert into d values (?, ?, ?, ?, ?)", (index, label, score, payload, flag))
                    connection.execute("delete from d where id between 401 and 600")
                    connection.commit()
                    expected = standard_external(connection, "d")
                    self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
                finally:
                    connection.close()
                self.assertEqual(len(expected), 800)
                self.assertEqual(standard_native(mirrored.path, "d"), expected)

    def test_without_rowid_rows_stay_in_key_order(self) -> None:
        with Workspace("sc-without-rowid") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute("pragma page_size = 1024")
                connection.execute("create table wr (k text primary key, v text) without rowid")
                connection.executemany(
                    "insert into wr (k, v) values (?, ?)",
                    [(f"k-{index:04d}", f"v-{index}") for index in shuffled()],
                )
                connection.commit()
                external = connection.execute("select k, v from wr order by k").fetchall()
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), ROWS)
            mine = call("readWithoutRowid", {"path": str(space.path), "table": "wr"})
            self.assertEqual([(row[0]["value"], row[1]["value"]) for row in mine], external)

    def test_duplicate_index_keys_preserve_order(self) -> None:
        with Workspace("sc-index") as space:
            steps = [
                {"kind": "createTable", "name": "ix", "columns": [
                    {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                    {"name": "label", "declaredType": "TEXT"},
                ]},
                {"kind": "createIndex", "name": "i_label", "table": "ix", "columns": ["label"]},
            ]
            steps += [{"kind": "insert", "table": "ix", "values": [index, f"label-{index % 10}"]} for index in shuffled()]
            build(space.path, steps, page_size=512)
            meta = call("meta", {"path": str(space.path)})
            self.assertGreater(meta["bytes"] / meta["pageSize"], 100)

            connection = sqlite3.connect(space.path)
            try:
                external = [(row[0], str(row[1])) for row in connection.execute("select label, rowid from ix indexed by i_label order by label, rowid")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), ROWS)
            self.assertEqual([(row["columns"][0]["value"], row["rowid"]) for row in native_index(space.path, "i_label")], external)

            with Workspace("sc-autoindex") as mirrored:
                connection = sqlite3.connect(mirrored.path)
                try:
                    connection.execute("pragma page_size = 512")
                    connection.execute("create table d (id integer primary key, label text, code text unique)")
                    connection.executemany(
                        "insert into d (id, label, code) values (?, ?, ?)",
                        [(index, f"label-{index % 10}", f"code-{index}") for index in shuffled()],
                    )
                    connection.commit()
                    auto = [
                        row[0]
                        for row in connection.execute("select name from sqlite_master where type = 'index' order by name")
                        if row[0].startswith("sqlite_autoindex_")
                    ]
                    self.assertTrue(auto)
                    expected = [(row[0], str(row[1])) for row in connection.execute(
                        f"select code, rowid from d indexed by {auto[0]} order by code, rowid"
                    )]
                finally:
                    connection.close()
                self.assertEqual(
                    [(row["columns"][0]["value"], row["rowid"]) for row in native_index(mirrored.path, auto[0])],
                    expected,
                )

    def test_mixed_serial_types_survive_both_directions(self) -> None:
        with Workspace("sc-serial") as space:
            build(space.path, [{"kind": "createTable", "name": "m", "columns": standard_columns()}] + standard_steps("m", shuffled()), page_size=1024)
            connection = sqlite3.connect(space.path)
            try:
                external = standard_external(connection, "m")
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(standard_native(space.path, "m"), external)

            with Workspace("sc-serial-external") as mirrored:
                connection = sqlite3.connect(mirrored.path)
                try:
                    connection.execute("pragma page_size = 1024")
                    connection.execute("create table m (id integer primary key, label text, score real, payload blob, flag integer)")
                    for index in shuffled():
                        flag = -(2**63) if index == 1 else 2**63 - 1 if index == 2 else index % 997
                        label = f"案例-{index}" if index % 3 == 0 else f"row-{index}"
                        score = index if index % 2 == 0 else index / 7
                        payload = bytes([index % 251]) * 3000 if index % 10 == 0 else None
                        connection.execute("insert into m values (?, ?, ?, ?, ?)", (index, label, score, payload, flag))
                    connection.commit()
                    external = standard_external(connection, "m")
                    self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
                finally:
                    connection.close()
                self.assertEqual(standard_native(mirrored.path, "m"), external)

    def test_wal_replay_survives_many_checkpoints(self) -> None:
        with Workspace("sc-wal") as space:
            connection = sqlite3.connect(space.path, isolation_level=None)
            try:
                connection.execute("pragma page_size = 512")
                connection.execute("pragma journal_mode = wal")
                connection.execute("create table w (id integer primary key, label text)")
                for round_index in range(50):
                    connection.execute("begin")
                    connection.executemany(
                        "insert into w (label) values (?)",
                        [(f"round-{round_index}-{index}",) for index in range(1, 21)],
                    )
                    connection.execute("commit")
                    connection.execute("pragma wal_checkpoint(PASSIVE)")
                wal_path = Path(f"{space.path}-wal")
                self.assertTrue(wal_path.exists())
                self.assertGreater(wal_path.stat().st_size, 32)
                self.assertTrue(Path(f"{space.path}-shm").exists())
                external = [(str(row[0]), row[1]) for row in connection.execute("select rowid, label from w order by rowid")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), ROWS)
            self.assertEqual([(row["rowid"], row["columns"][1]["value"]) for row in native_rows(space.path, "w")], external)

    def test_hot_journal_rolls_a_killed_transaction_back(self) -> None:
        with Workspace("sc-journal") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute("pragma page_size = 512")
                connection.execute("create table j (id integer primary key, label text)")
                connection.executemany("insert into j (label) values (?)", [(f"committed-{index}",) for index in range(1, ROWS + 1)])
                connection.commit()
            finally:
                connection.close()

            script = (
                "import os, sqlite3, sys\n"
                "connection = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
                "connection.execute('pragma journal_mode = delete')\n"
                "connection.execute('begin immediate')\n"
                "for index in range(200): connection.execute('insert into j (label) values (?)', (f'uncommitted-{index}',))\n"
                "os._exit(9)\n"
            )
            result = subprocess.run([sys.executable, "-c", script, str(space.path)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            journal_path = Path(f"{space.path}-journal")
            self.assertTrue(journal_path.exists())
            self.assertGreaterEqual(journal_path.stat().st_size, 512)

            connection = sqlite3.connect(space.path)
            try:
                external = [(str(row[0]), row[1]) for row in connection.execute("select rowid, label from j order by rowid")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(len(external), ROWS)
            self.assertEqual([(row["rowid"], row["columns"][1]["value"]) for row in native_rows(space.path, "j")], external)

    def test_thousand_same_key_updates_settle(self) -> None:
        with Workspace("sc-update") as space:
            steps = [
                {"kind": "createTable", "name": "u", "columns": [
                    {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                    {"name": "label", "declaredType": "TEXT"},
                ]},
                {"kind": "insert", "table": "u", "values": [1, "start"]},
            ]
            steps += [
                {"kind": "update", "table": "u", "rowid": 1, "slots": [{"keep": True}, {"set": f"v-{index}"}]}
                for index in range(1, ROWS + 1)
            ]
            build(space.path, steps, page_size=512)
            connection = sqlite3.connect(space.path)
            try:
                written = connection.execute("select label from u where rowid = 1").fetchone()[0]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(written, f"v-{ROWS}")
            self.assertEqual(native_rows(space.path, "u")[0]["columns"][1]["value"], f"v-{ROWS}")

            with Workspace("sc-update-external") as mirrored:
                connection = sqlite3.connect(mirrored.path)
                try:
                    connection.execute("pragma page_size = 512")
                    connection.execute("create table u (id integer primary key, label text)")
                    connection.execute("insert into u (id, label) values (1, 'start')")
                    connection.commit()
                    for index in range(1, ROWS + 1):
                        connection.execute("update u set label = ? where id = 1", (f"v-{index}",))
                    connection.commit()
                    expected = connection.execute("select label from u where rowid = 1").fetchone()[0]
                    self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
                finally:
                    connection.close()
                self.assertEqual(native_rows(mirrored.path, "u")[0]["columns"][1]["value"], expected)

    def test_page_sizes_agree_with_external_pragma(self) -> None:
        for size in (512, 1024, 4096):
            with Workspace(f"sc-page-{size}") as space:
                steps = [{"kind": "createTable", "name": "p", "columns": [
                    {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                    {"name": "label", "declaredType": "TEXT"},
                ]}]
                steps += [{"kind": "insert", "table": "p", "values": [index, f"p-{index}"]} for index in range(1, ROWS + 1)]
                build(space.path, steps, page_size=size)
                meta = call("meta", {"path": str(space.path)})
                self.assertEqual(meta["pageSize"], size)
                self.assertGreaterEqual(meta["bytes"] / size, 2)
                connection = sqlite3.connect(space.path)
                try:
                    self.assertEqual(connection.execute("pragma page_size").fetchone()[0], size)
                    external = [(str(row[0]), row[1]) for row in connection.execute("select rowid, label from p order by rowid")]
                    self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
                finally:
                    connection.close()
                self.assertEqual([(row["rowid"], row["columns"][1]["value"]) for row in native_rows(space.path, "p")], external)

    def test_utf16_rows_decode_through_declared_encoding(self) -> None:
        for pragma, encoding, marker in (("UTF-16le", "utf16le", 2), ("UTF-16be", "utf16be", 3)):
            with Workspace(f"sc-utf16-{encoding}") as space:
                connection = sqlite3.connect(space.path)
                try:
                    connection.execute(f"pragma encoding = '{pragma}'")
                    connection.execute("pragma page_size = 1024")
                    connection.execute("create table u (id integer primary key, label text)")
                    connection.executemany("insert into u (id, label) values (?, ?)", [(index, f"案例-{index}") for index in shuffled()])
                    connection.commit()
                    self.assertEqual(connection.execute("pragma encoding").fetchone()[0].upper(), pragma.upper())
                    external = [(str(row[0]), row[1]) for row in connection.execute("select rowid, label from u order by rowid")]
                    self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
                finally:
                    connection.close()
                meta = call("meta", {"path": str(space.path)})
                self.assertEqual(meta["encoding"], encoding)
                self.assertEqual(meta["textEncoding"], marker)
                self.assertEqual([(row["rowid"], row["columns"][1]["value"]) for row in native_rows(space.path, "u")], external)

    def test_strict_tables_read_and_views_fail_closed(self) -> None:
        with Workspace("sc-objects") as space:
            connection = sqlite3.connect(space.path)
            try:
                connection.execute("pragma page_size = 1024")
                connection.execute("create table s (id integer primary key, label text) strict")
                connection.executemany("insert into s (id, label) values (?, ?)", [(index, f"strict-{index}") for index in shuffled()])
                connection.execute("create view v as select id, label from s")
                connection.execute("create virtual table vt using fts5(body)")
                connection.execute("insert into vt (body) values ('virtual-row')")
                connection.commit()
                master = [(row[0], row[1]) for row in connection.execute("select type, name from sqlite_master order by name")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()

            self.assertEqual(sorted((item["kind"], item["name"]) for item in native_schema(space.path)), sorted(master))
            self.assertEqual(len(native_rows(space.path, "s")), ROWS)
            with self.assertRaises(RuntimeError) as view_error:
                native_rows(space.path, "v")
            self.assertIn("view", str(view_error.exception).lower())
            with self.assertRaises(RuntimeError) as virtual_error:
                native_rows(space.path, "vt")
            self.assertIn("virtual", str(virtual_error.exception).lower())

    def test_real_affinity_keeps_numeric_values(self) -> None:
        with Workspace("sc-real") as space:
            steps = [{"kind": "createTable", "name": "r", "columns": [
                {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                {"name": "score", "declaredType": "REAL"},
            ]}]
            steps += [{"kind": "insert", "table": "r", "values": [index, index if index % 2 == 0 else index / 7]} for index in shuffled()]
            build(space.path, steps, page_size=1024)
            connection = sqlite3.connect(space.path)
            try:
                external = [(str(row[0]), float(row[1])) for row in connection.execute("select rowid, score from r order by rowid")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            mine = []
            for row in native_rows(space.path, "r"):
                score = row["columns"][1]
                value = float(score["value"]) if score["kind"] == "real" else float(int(score["value"]))
                mine.append((row["rowid"], value))
            self.assertEqual(mine, external)

    def test_integer_primary_key_alias_at_scale(self) -> None:
        with Workspace("sc-alias") as space:
            ids = shuffled(500) + [-index for index in shuffled(500)]
            steps = [{"kind": "createTable", "name": "a", "columns": [
                {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                {"name": "label", "declaredType": "TEXT"},
            ]}]
            steps += [{"kind": "insert", "table": "a", "values": [index, f"id-{index}"]} for index in ids]
            build(space.path, steps, page_size=1024)
            connection = sqlite3.connect(space.path)
            try:
                external = [(str(row[0]), str(row[1]), row[2]) for row in connection.execute("select rowid, id, label from a order by rowid")]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
                self.assertEqual([(row[0], row[1]) for row in external if row[0] != row[1]], [])
            finally:
                connection.close()
            self.assertEqual([(row["rowid"], row["columns"][1]["value"]) for row in native_rows(space.path, "a")], [(row[0], row[2]) for row in external])
            self.assertTrue(all(row["columns"][0]["kind"] == "null" for row in native_rows(space.path, "a")))

    def test_sqlite_master_lists_indexes_at_scale(self) -> None:
        with Workspace("sc-master") as space:
            steps = [{"kind": "createTable", "name": "t", "columns": [
                {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
                {"name": "label", "declaredType": "TEXT", "unique": True},
                {"name": "group_name", "declaredType": "TEXT"},
            ]}]
            steps += [
                {"kind": "createIndex", "name": "i_group", "table": "t", "columns": ["group_name"]},
                {"kind": "createIndex", "name": "i_label_group", "table": "t", "columns": ["label", "group_name"]},
            ]
            steps += [{"kind": "insert", "table": "t", "values": [index, f"label-{index}", f"group-{index % 10}"]} for index in shuffled()]
            build(space.path, steps, page_size=1024)
            connection = sqlite3.connect(space.path)
            try:
                external = [(row[0], row[1], row[2], int(row[3])) for row in connection.execute(
                    "select type, name, tbl_name, rootpage from sqlite_master order by name"
                )]
                self.assertEqual(connection.execute("pragma integrity_check").fetchone()[0], "ok")
            finally:
                connection.close()
            self.assertEqual(sorted((item["kind"], item["name"], item["tableName"]) for item in native_schema(space.path)),
                             sorted((row[0], row[1], row[2]) for row in external))
            indexes = [row for row in external if row[0] == "index"]
            self.assertGreaterEqual(len(indexes), 3)
            self.assertTrue(all(row[3] > 1 for row in indexes))


if __name__ == "__main__":
    unittest.main()
