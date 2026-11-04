"""SQL semantics ported out of the retired `yydb-query` suite.

Each case runs on Python's standard-library `sqlite3` (SQLite 3.49.x) and is
checked against an expectation that three other external builds
(`better-sqlite3`, `node:sqlite`, `sql.js`) agreed on in the TypeScript suite.
The expectation is never produced by this repository's reader or writer.
"""

import json
import re
import sqlite3
import unittest
from pathlib import Path

CORPUS_DIR = Path(__file__).resolve().parents[2] / "sqlite.ts" / "tests"


def decode(cell):
    if cell is None:
        return None
    if "i" in cell:
        return int(cell["i"])
    if "r" in cell:
        return float(cell["r"])
    if "t" in cell:
        return cell["t"]
    return bytes.fromhex(cell["b"])


def load_cases():
    cases = []
    for path in sorted(CORPUS_DIR.glob("sql-*.json")):
        corpus = json.loads(path.read_text(encoding="utf-8"))
        for case in corpus["cases"]:
            cases.append((path.name, corpus["group"], case))
    return cases


def run_case(case):
    connection = sqlite3.connect(":memory:")
    try:
        for sql in case.get("schema", []) + case.get("seed", []):
            connection.execute(sql)
        outcomes = []
        for step in case["steps"]:
            try:
                cursor = connection.execute(step["sql"], step.get("params", []))
                outcomes.append({"rows": [list(row) for row in cursor.fetchall()]})
            except sqlite3.Error as error:
                outcomes.append({"error": str(error)})
        return outcomes
    finally:
        connection.close()


def make_method(file_name, group, case):
    source = case["source"]
    expectation = case.get("expect")
    steps = case["steps"]

    def test(self):
        outcomes = run_case(case)
        label = f"{file_name} {source}"
        if expectation is None:
            for index, outcome in enumerate(outcomes):
                self.assertNotIn("error", outcome, f"{label} step {index + 1}: {outcome.get('error')}")
            return
        self.assertEqual(len(expectation), len(steps), f"{label}: expectation count does not match the step count")
        for index, (expected, actual) in enumerate(zip(expectation, outcomes)):
            where = f"{label} step {index + 1}"
            if "error" in expected:
                self.assertIn("error", actual, f"{where}: expected an error, got {actual.get('rows')}")
                continue
            self.assertNotIn("error", actual, f"{where}: expected rows, got {actual.get('error')}")
            wanted = [[decode(cell) for cell in row] for row in expected.get("rows", [])]
            self.assertEqual(actual["rows"], wanted, where)

    test.__doc__ = f"{group}: {source}"
    name = f"test_{re.sub(r'[^0-9a-zA-Z]+', '_', source).strip('_')}"
    return name, test


class SqlSemantics(unittest.TestCase):
    pass


for file_name, group, case in load_cases():
    name, method = make_method(file_name, group, case)
    setattr(SqlSemantics, name, method)


if __name__ == "__main__":
    unittest.main()
