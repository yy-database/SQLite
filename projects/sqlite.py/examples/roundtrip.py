"""下游验收示例：本仓原生 reader/writer 与 Python 标准库 `sqlite3` 的写读双向核对。

期望值全部来自外部引擎（标准库 `sqlite3` 与 `PRAGMA integrity_check`），不读取
本仓任何内部常量。原生侧经 `../bridge.mjs` 暴露（本仓没有 pyo3 产品绑定）。
运行：`python projects/sqlite.py/examples/roundtrip.py`
"""

from __future__ import annotations

import json
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile

ROWS = 1000
PAGE_SIZE = 4096
BRIDGE = pathlib.Path(__file__).resolve().parent.parent / "bridge.mjs"

COLUMNS = [
    {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
    {"name": "label", "declaredType": "TEXT"},
    {"name": "score", "declaredType": "REAL"},
]

EXPECTED = [(index + 1, f"row-{index + 1}", (index + 1) / 4) for index in range(ROWS)]


def native(command: str, payload: dict) -> object:
    # 1000 行 fixture 走 stdin，避免 Windows 命令行长度上限。
    done = subprocess.run(
        ["node", str(BRIDGE), command],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(done.stdout)


def column(value: dict) -> object:
    kind = value["kind"]
    if kind == "null":
        return None
    if kind == "integer":
        return int(value["value"])
    if kind == "real":
        return value["value"]
    if kind == "text":
        return value["value"]
    if kind == "blob":
        return value["value"]
    raise AssertionError(f"unknown column kind {kind}")


work = pathlib.Path(tempfile.mkdtemp(prefix="sqlite-py-example-"))

try:
    # 方向一：本仓写入 → 外部引擎读。
    written = work / "written.sqlite3"
    steps = [{"kind": "createTable", "name": "items", "columns": COLUMNS}]
    steps += [
        {"kind": "insert", "table": "items", "values": [row_id, label, score]}
        for row_id, label, score in EXPECTED
    ]
    native("build", {"path": str(written), "pageSize": PAGE_SIZE, "steps": steps})

    with sqlite3.connect(written) as external:
        integrity = external.execute("PRAGMA integrity_check").fetchone()[0]
        observed = external.execute("SELECT id, label, score FROM items ORDER BY id").fetchall()

    assert integrity == "ok", f"integrity_check failed: {integrity}"
    assert len(observed) == ROWS, f"external read {len(observed)} rows, expected {ROWS}"
    assert observed == EXPECTED, "write-to-external mismatch"

    # 方向二：外部引擎写 → 本仓读。
    external_written = work / "external.sqlite3"
    with sqlite3.connect(external_written) as created:
        created.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, score REAL)")
        created.executemany("INSERT INTO items (id, label, score) VALUES (?, ?, ?)", EXPECTED)

    decoded = native("read", {"path": str(external_written), "table": "items"})
    assert len(decoded) == ROWS, f"native read {len(decoded)} rows, expected {ROWS}"
    for (row_id, label, score), row in zip(EXPECTED, decoded):
        observed_row = [column(value) for value in row["columns"]]
        # `INTEGER PRIMARY KEY` 是 rowid 别名，序列化 payload 里没有它的值。
        assert int(row["rowid"]) == row_id, f"rowid mismatch at id={row_id}"
        assert observed_row[1] == label, f"label mismatch at id={row_id}"
        assert observed_row[2] == score, f"score mismatch at id={row_id}"

    print(f"ok sqlite.py examples: {ROWS} rows verified in both directions")
finally:
    shutil.rmtree(work, ignore_errors=True)
