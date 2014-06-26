"""Shared helpers for the `sqlite.py` acceptance suite."""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import tempfile

PROJECT = pathlib.Path(__file__).resolve().parents[1]
BRIDGE = PROJECT / "bridge.mjs"


def call(command: str, payload: dict) -> object:
    """Runs one bridge command and returns its decoded JSON result."""
    completed = subprocess.run(
        ["node", str(BRIDGE), command],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"bridge {command} failed: {completed.stderr.strip()}")
    return json.loads(completed.stdout)


class Workspace:
    """Temporary directory holding one SQLite main file."""

    def __init__(self, label: str) -> None:
        self._root = tempfile.mkdtemp(prefix=f"sqlite-py-{label}-")
        self.path = pathlib.Path(self._root) / "main.sqlite3"

    def close(self) -> None:
        shutil.rmtree(self._root, ignore_errors=True)

    def __enter__(self) -> "Workspace":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def columns() -> list[dict]:
    """The shared four-column fixture used by most cases."""
    return [
        {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
        {"name": "label", "declaredType": "TEXT"},
        {"name": "score", "declaredType": "REAL"},
        {"name": "payload", "declaredType": "BLOB"},
    ]


def table(name: str, cols: list[dict]) -> dict:
    return {"kind": "createTable", "name": name, "columns": cols}


def insert(name: str, values: list) -> dict:
    return {"kind": "insert", "table": name, "values": values}


def build(path: pathlib.Path, steps: list[dict], page_size: int = 4096) -> dict:
    return call("build", {"path": str(path), "pageSize": page_size, "steps": steps})


def native_rows(path: pathlib.Path, table_name: str) -> list[dict]:
    return call("read", {"path": str(path), "table": table_name})


def native_schema(path: pathlib.Path) -> list[dict]:
    return call("schema", {"path": str(path)})


def native_index(path: pathlib.Path, index_name: str) -> list[dict]:
    return call("readIndex", {"path": str(path), "index": index_name})


def oracle(path: pathlib.Path, sql: str) -> object:
    return call("oracle", {"path": str(path), "sql": sql})
