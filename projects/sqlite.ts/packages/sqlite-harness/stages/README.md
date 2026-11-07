# platforms

Thin host layers around the three bindings in `projects/sqlite.rs`. None of
them owns page logic; they build the same pure-Rust core and verify the result
against an external engine.

| Layer | Binding crate | Command | Verification |
|-------|---------------|---------|--------------|
| `node/` | `sqlite-napi` | `node projects/sqlite.ts/packages/sqlite-harness/stages/node/smoke.mjs` | 1000 rows through the Node-API writer, then CPython `sqlite3` `PRAGMA integrity_check` |
| `../../sqlite-wasm` | `sqlite-wasm` | `node projects/sqlite.ts/packages/sqlite-wasm/build.mjs` then `.../smoke.mjs` | 1000 rows through in-memory SQL, snapshot written to disk, then CPython `sqlite3` check |
| `python/` | `sqlite-pyo3` | `node projects/sqlite.ts/packages/sqlite-harness/stages/python/run_tests.mjs` | maturin wheel in a clean venv, five feature tests (roundtrip, WAL, hot journal, `WITHOUT ROWID`, UTF-16) |

`verify_sqlite.py` is the shared external oracle: it opens a `.sqlite3` file
with CPython's standard library and reports `PRAGMA integrity_check`, the row
count, and the first row.

`stages.mjs` is the registration point for the repository harness: it exports
`platformStages`, each with a `commands` list (all three belong to `test`),
a row floor, and a `run()` that returns `{name, ok, executed, skipped, elapsed,
reasons, tail}`. The harness entry consumes that array instead of spawning
platform scripts on its own, so there is one entry and one result contract.
The python stage performs the clean virtual-environment install as part of
`test`, not as a separate check.

Build artifacts (`lib/`, `out/`, `wheels/`, `.venv/`) are ignored.
