"""Records the real SQLite side of the divergence ledger.

Every case is executed against CPython's bundled SQLite in a fresh in-memory
database: the `setup` statements first, then `sql`. The result is written as
JSON on stdout and never hand-edited. `scripts/gen-divergences.mjs` merges it
with the engine side and writes `divergences/ledger.json`.
"""

import argparse
import json
import platform
import sqlite3
import sys


def normalize(cell):
    if cell is None or isinstance(cell, (int, float, str)):
        return cell
    if isinstance(cell, bytes):
        return {"$blob": cell.hex()}
    raise TypeError(f"unsupported sqlite3 value {type(cell).__name__}")


def run_case(case):
    connection = sqlite3.connect(":memory:")
    try:
        for statement in case.get("setup") or []:
            try:
                connection.execute(statement)
            except sqlite3.Error as error:
                return {"kind": "error", "stage": "setup", "message": str(error)}
        try:
            cursor = connection.execute(case["sql"])
        except sqlite3.Error as error:
            return {"kind": "error", "stage": "sql", "message": str(error)}
        return {"kind": "rows", "rows": [[normalize(cell) for cell in row] for row in cursor.fetchall()]}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", required=True)
    args = parser.parse_args()

    with open(args.ledger, encoding="utf-8") as handle:
        ledger = json.load(handle)

    results = {}
    for case in ledger["cases"]:
        try:
            results[case["id"]] = run_case(case)
        except Exception as error:  # keep one broken case from hiding the rest
            results[case["id"]] = {"kind": "error", "stage": "runner", "message": f"{type(error).__name__}: {error}"}

    print(
        json.dumps(
            {
                "sqliteVersion": sqlite3.sqlite_version,
                "python": platform.python_version(),
                "module": "CPython sqlite3",
                "results": results,
            }
        )
    )


if __name__ == "__main__":
    main()
    sys.exit(0)
