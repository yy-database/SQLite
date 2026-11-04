# Python binding for the SQLite format-3 writer and reader

This package builds the `sqlite_format3` extension module from the Rust
`sqlite-pyo3` crate with maturin. The module is a thin binding over the shared
`sqlite` facade, so it reads and writes the same pages as the N-API and WASM
bindings.

```bash
python -m maturin build --release --manifest-path pyproject.toml
python -m pip install --force-reinstall target/wheels/sqlite_format3-*.whl
```

```python
import sqlite_format3

writer = sqlite_format3.SqliteWriter.create(4096)
writer.create_table("t", [{"name": "id", "declaredType": "INTEGER", "primaryKey": True}])
writer.insert("t", [1])
writer.save("t.sqlite3")

database = sqlite_format3.SqliteDatabase.open("t.sqlite3")
print(database.ping(), database.table("t"))
```

Verification lives in `../../examples/tests` and in the repository harness
(`sqlite-harness`), which installs this wheel into a clean virtual environment.
