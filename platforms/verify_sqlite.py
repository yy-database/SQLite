"""External oracle for the platform smokes: read a `.sqlite3` file with CPython's
standard library and report `PRAGMA integrity_check` plus a row count.

Usage: python verify_sqlite.py <path> <table> [column,column,...]
"""

import json
import os
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    path = Path(sys.argv[1])
    table = sys.argv[2]
    columns = [column for column in sys.argv[3].split(",") if column] if len(sys.argv) > 3 else []
    if not path.is_file():
        print(f"missing database file: {path}", file=sys.stderr)
        return 2
    connection = sqlite3.connect(path)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        projection = ", ".join(columns) if columns else "*"
        count = connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        first_row = connection.execute(f"SELECT {projection} FROM {table} LIMIT 1").fetchone()
    finally:
        connection.close()
    print(
        json.dumps(
            {
                "integrity_check": integrity,
                "count": count,
                "first_row": list(first_row) if first_row else None,
                "snapshot_bytes": os.path.getsize(path),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
