# sqlite-pyo3

PyO3 bindings for SQLite format-3 snapshots. Both bindings and the writer reuse
the pure-Rust `sqlite` facade; this crate only translates Python values and
never re-implements page logic.

## Build

```powershell
python -m maturin build --release --manifest-path projects/sqlite.rs/sqlite-pyo3/Cargo.toml --out platforms/python/wheels
python -m venv platforms/python/.venv
platforms/python/.venv/Scripts/python -m pip install --no-index --find-links platforms/python/wheels sqlite-format3
```

## Surface

```python
from sqlite_format3 import SqliteDatabase, SqliteWriter

writer = SqliteWriter.create(4096)
writer.create_table("bench", [
    {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
    {"name": "label", "declaredType": "TEXT", "notNull": True},
    {"name": "score", "declaredType": "REAL"},
])
for index in range(1, 1001):
    writer.insert("bench", [index, f"row-{index}", index / 10])
writer.save("bench.sqlite3")

database = SqliteDatabase.open("bench.sqlite3")
rows = database.table("bench")
print(len(rows), rows[0]["rowid"], rows[0]["columns"][1]["value"])
```

`SqliteDatabase` replays a `-wal` sidecar or a hot `-journal` in memory, decodes
rowid and `WITHOUT ROWID` tables with the text encoding declared in the header,
and validates the header through `ping()`. `SqliteWriter` owns `create`,
`open`, `create_table`, `insert`, `delete`, `save`, and `pages`.

Module functions: `decode_record_cells(payload, encoding=None)`,
`library_version(payload)`, `validate(payload)`.
