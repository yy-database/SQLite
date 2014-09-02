"""Installed-wheel checks for the sqlite-pyo3 binding.

Run inside a clean virtual environment that has the wheel installed:

    python test_features.py

Every assertion is made against an external truth source: CPython's standard
library `sqlite3` (including `PRAGMA integrity_check`), never against the
binding that produced the file. The script prints one JSON line so the harness
can report assertion counts separately from the data volume (`rows`).
"""

import json
import shutil
import sqlite3
import tempfile
from pathlib import Path

from sqlite_format3 import SqliteDatabase, SqliteEngine, SqliteWriter

COUNTS = {"cases": 0, "assertions": 0, "storage": 0, "sql": 0}
ROWS = {"rows": 0}


def check(condition, message):
    COUNTS["assertions"] += 1
    COUNTS["storage"] += 1
    if not condition:
        raise AssertionError(message)


def check_sql(condition, message):
    COUNTS["assertions"] += 1
    COUNTS["sql"] += 1
    if not condition:
        raise AssertionError(message)


def integrity_check(path):
    connection = sqlite3.connect(path)
    try:
        return connection.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        connection.close()


def count_rows(path, table):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    finally:
        connection.close()


def write_read_roundtrip_1000(directory):
    path = directory / "bench.sqlite3"
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
    ROWS["rows"] = 1000

    check(integrity_check(path) == "ok", "PRAGMA integrity_check is ok")
    check(count_rows(path, "bench") == 1000, "external sqlite3 sees 1000 rows")

    database = SqliteDatabase.open(str(path))
    check(database.ping() > 0, "header ping")
    check(database.sqlite_version().startswith("3."), "library reports SQLite 3")
    rows = database.table("bench")
    check(len(rows) == 1000, "reader sees 1000 rows")
    check(rows[0]["rowid"] == 1, "first rowid is 1")
    # `INTEGER PRIMARY KEY` is a rowid alias, so the stored payload has no
    # value for it and the rowid carries the identity.
    check([cell["kind"] for cell in rows[0]["columns"]] == ["null", "text", "real"], "storage classes survive")
    check(rows[0]["columns"][1]["value"] == "row-1", "first label")
    check(abs(rows[0]["columns"][2]["value"] - 0.1) < 1e-9, "first score")


def wal_visible(directory):
    source = directory / "wal-source.sqlite3"
    connection = sqlite3.connect(source, isolation_level=None)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE wal_t (id INTEGER PRIMARY KEY, label TEXT)")
    connection.executemany("INSERT INTO wal_t (label) VALUES (?)", [(f"r{index}",) for index in range(500)])
    connection.execute("PRAGMA wal_checkpoint(PASSIVE)")
    fixture = directory / "wal-fixture.sqlite3"
    shutil.copyfile(source, fixture)
    wal = Path(str(source) + "-wal")
    check(wal.is_file(), "the WAL sidecar exists while the writer is open")
    shutil.copyfile(wal, Path(str(fixture) + "-wal"))
    connection.close()

    database = SqliteDatabase.open(str(fixture))
    rows = database.table("wal_t")
    check(len(rows) == 500, "WAL rows are visible")
    check(rows[-1]["columns"][1]["value"] == "r499", "last WAL row")


def hot_journal_rollback(directory):
    source = directory / "journal-source.sqlite3"
    connection = sqlite3.connect(source, isolation_level=None)
    connection.execute("CREATE TABLE journal_t (id INTEGER PRIMARY KEY, label TEXT)")
    connection.executemany("INSERT INTO journal_t (label) VALUES (?)", [(f"keep-{index}",) for index in range(1000)])
    connection.execute("BEGIN")
    connection.executemany("INSERT INTO journal_t (label) VALUES (?)", [(f"rolled-{index}",) for index in range(500)])
    fixture = directory / "journal-fixture.sqlite3"
    shutil.copyfile(source, fixture)
    journal = Path(str(source) + "-journal")
    check(journal.is_file(), "a rollback journal exists inside the transaction")
    shutil.copyfile(journal, Path(str(fixture) + "-journal"))
    connection.execute("ROLLBACK")
    connection.close()

    database = SqliteDatabase.open(str(fixture))
    rows = database.table("journal_t")
    check(len(rows) == 1000, "rollback discards the uncommitted rows")
    check(rows[0]["columns"][1]["value"] == "keep-0", "first kept row")
    check("rolled-0" not in [row["columns"][1]["value"] for row in rows], "rolled rows are gone")


def without_rowid(directory):
    path = directory / "without-rowid.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE wr (id INTEGER PRIMARY KEY, label TEXT) WITHOUT ROWID")
    connection.executemany("INSERT INTO wr (id, label) VALUES (?, ?)", [(index, f"wr-{index}") for index in range(1, 5)])
    connection.commit()
    connection.close()

    check(integrity_check(path) == "ok", "WITHOUT ROWID integrity check is ok")
    database = SqliteDatabase.open(str(path))
    rows = database.table_without_rowid("wr")
    check(
        [[cell["value"] for cell in row] for row in rows] == [[1, "wr-1"], [2, "wr-2"], [3, "wr-3"], [4, "wr-4"]],
        "WITHOUT ROWID rows decode in key order",
    )


def utf16(directory):
    path = directory / "utf16.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA encoding='UTF-16le'")
    connection.execute("CREATE TABLE u (id INTEGER PRIMARY KEY, label TEXT)")
    connection.execute("INSERT INTO u (label) VALUES ('中文标注')")
    connection.commit()
    connection.close()

    database = SqliteDatabase.open(str(path))
    check(database.encoding() == "utf-16le", "UTF-16le encoding is detected")
    rows = database.table("u")
    check(len(rows) == 1, "one UTF-16 row")
    check(rows[0]["columns"][1]["value"] == "中文标注", "UTF-16 text decodes")


def sql_engine(directory):
    path = directory / "sql-engine.sqlite3"
    engine = SqliteEngine.create(4096)

    created = engine.execute("create table people (id integer primary key, name text not null, score real)")
    check_sql(created["statement"] == "create-table", "create-table statement name")
    check_sql(created["affected"] == 1 and created["columns"] == [] and created["rows"] == [], "create-table envelope")

    inserted = engine.execute("insert into people (name, score) values ('ada', 9.5)")
    check_sql(inserted["statement"] == "insert" and inserted["affected"] == 1, "insert statement and affected")
    check_sql(inserted["columns"] == ["rowid"] and inserted["rows"] == [[1]], "insert returns the rowid")
    engine.execute("insert into people (name) values ('bob')")

    selected = engine.execute("select * from people")
    check_sql(selected["columns"] == ["id", "name", "score"], "select * column labels")
    check_sql(selected["rows"] == [[1, "ada", 9.5], [2, "bob", None]], "select * rows")

    counted = engine.execute("select count(*) from people")
    check_sql(counted["columns"] == ["count(*)"] and counted["rows"] == [[2]], "select count(*)")

    limited = engine.execute("select name from people limit 1")
    check_sql(limited["rows"] == [["ada"]], "select named column with limit")

    batch = engine.execute_batch(
        [
            "create table t2 (id integer primary key, label text)",
            "insert into t2 values (1, 'x')",
            "select * from t2",
        ]
    )
    check_sql(len(batch) == 3 and batch[2]["rows"] == [[1, "x"]], "batch preserves order")

    filtered = engine.execute("select name, score from people where score >= 9.0 order by score desc")
    check_sql(filtered["rows"] == [["ada", 9.5]], "where comparison with order by desc")
    nulls = engine.execute("select count(*) from people where score is null or name = 'bob'")
    check_sql(nulls["rows"] == [[1]], "is null and equality combined with or")

    rejected = engine.try_execute("select * from people group by id")
    check_sql(rejected["ok"] is False, "unsupported clause is reported, not raised")
    error = rejected["error"]
    check_sql(error["code"] == "unsupported-clause", "rejection code")
    check_sql(error["statement"] == "select" and error["clause"] == "GROUP", "rejection statement and clause")
    check_sql(error["position"] == 21, "rejection position")

    unknown = engine.try_execute("insert into missing values (1)")
    check_sql(unknown["ok"] is False and unknown["error"]["code"] == "unknown-table", "unknown table code")

    multi = engine.try_execute("select * from people; select * from people")
    check_sql(multi["ok"] is False and multi["error"]["code"] == "multiple-statements", "multiple statements code")

    engine.execute("create table raw (id integer primary key, payload blob)")
    engine.execute("insert into raw (payload) values (X'00ff')")
    blob = engine.execute("select * from raw")
    check_sql(blob["rows"] == [[1, {"$blob": "00ff"}]], "blob cells use the tagged envelope")

    check_sql(engine.page_size() == 4096, "engine page size")
    check_sql(engine.sqlite_version().startswith("3."), "engine library version")
    check_sql(engine.ping() > 0, "engine header ping")

    path.write_bytes(engine.snapshot())
    check_sql(integrity_check(path) == "ok", "SQL-written image passes PRAGMA integrity_check")
    connection = sqlite3.connect(path)
    try:
        external = connection.execute("SELECT id, name, score FROM people").fetchall()
    finally:
        connection.close()
    check_sql(external == [(1, "ada", 9.5), (2, "bob", None)], "external sqlite3 reads SQL-written rows")


CASES = [
    ("write_read_roundtrip_1000", write_read_roundtrip_1000),
    ("wal_visible", wal_visible),
    ("hot_journal_rollback", hot_journal_rollback),
    ("without_rowid", without_rowid),
    ("utf16", utf16),
    ("sql_engine", sql_engine),
]


def main():
    for name, case in CASES:
        directory = Path(tempfile.mkdtemp(prefix="sqlite-format3-"))
        COUNTS["cases"] += 1
        try:
            case(directory)
        finally:
            shutil.rmtree(directory, ignore_errors=True)
    print(json.dumps({**COUNTS, "rows": ROWS["rows"]}))


if __name__ == "__main__":
    main()
