#!/usr/bin/env python3
"""Locks the semantic fixture expectations with CPython's `sqlite3` module.

The fixtures describe "given this setup and this SQL, what should SQLite
return". Their expected values are therefore produced by an external engine,
never by this repository. Two modes:

    python scripts/gen-fixtures.py --write     # fill `expect` from sqlite3
    python scripts/gen-fixtures.py --verify    # recompute and compare

`--write` refuses to run when a fixture disagrees with SQLite: a case whose
recorded `expect.kind` is `rows` but raises, or `error` but succeeds, is a
fixture bug and must be fixed by hand rather than silently rewritten.

`expect.kind = "rejected"` is a gap lock: the case asserts that this engine
rejects a statement with a documented code, so SQLite is not consulted.
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMANTICS = ROOT / "fixtures" / "semantics"
BLOB_KEY = "$blob"
KINDS = {"rows", "error", "rejected"}


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def expand_setup(entry):
    """Yields `(sql, must_fail)` for one setup entry.

    A plain string is a statement that must succeed. An object with
    `expect: "error"` is a statement that must fail. An object with `repeat`
    expands `{n}` from 1 to `repeat` and optionally runs an `insert` line
    right after each `sql` line.
    """
    if isinstance(entry, str):
        yield entry, False
        return
    if "repeat" in entry:
        count = int(entry["repeat"])
        if count < 1:
            raise ValueError(f"repeat must be positive, got {count}")
        for index in range(1, count + 1):
            yield entry["sql"].replace("{n}", str(index)), False
            if entry.get("insert"):
                yield entry["insert"].replace("{n}", str(index)), False
        return
    if "sql" not in entry:
        raise ValueError(f"setup entry has no `sql`: {entry}")
    yield entry["sql"], entry.get("expect") == "error"


def normalize(cell):
    if cell is None or isinstance(cell, (int, float, str)):
        return cell
    if isinstance(cell, bytes):
        return {BLOB_KEY: cell.hex()}
    raise TypeError(f"unsupported sqlite3 value {type(cell).__name__}")


def snapshot(case):
    """Runs one case against sqlite3 and returns its expected outcome."""
    if case["expect"]["kind"] == "rejected":
        return None
    connection = sqlite3.connect(":memory:")
    try:
        for entry in case["setup"]:
            for sql, must_fail in expand_setup(entry):
                try:
                    connection.execute(sql)
                except sqlite3.Error as error:
                    if not must_fail:
                        raise AssertionError(f"setup step failed: {sql}: {error}")
                else:
                    if must_fail:
                        raise AssertionError(f"setup step expected to fail but succeeded: {sql}")
        try:
            cursor = connection.execute(case["sql"])
        except sqlite3.Error as error:
            if case["expect"]["kind"] != "error":
                raise AssertionError(f"expected rows, sqlite rejected: {error}")
            expect = {"kind": "error", "oracle": str(error)}
            if case["expect"].get("code"):
                expect["code"] = case["expect"]["code"]
            return expect
        if case["expect"]["kind"] == "error":
            raise AssertionError("expected an error, sqlite accepted the statement")
        return {"kind": "rows", "rows": [[normalize(cell) for cell in row] for row in cursor.fetchall()]}
    finally:
        connection.close()


def same_value(left, right):
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        if isinstance(left, (int, float)) and isinstance(right, (int, float)) and not isinstance(left, bool) and not isinstance(right, bool):
            return abs(float(left) - float(right)) <= 1e-9 * max(1.0, abs(float(left)), abs(float(right)))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.get(BLOB_KEY, "").lower() == right.get(BLOB_KEY, "").lower()
    return left == right


def same_outcome(expected, observed):
    if expected["kind"] != observed["kind"]:
        return False
    if expected["kind"] == "error":
        return expected.get("oracle") == observed.get("oracle")
    rows_expected, rows_observed = expected["rows"], observed["rows"]
    if len(rows_expected) != len(rows_observed):
        return False
    for row_expected, row_observed in zip(rows_expected, rows_observed):
        if len(row_expected) != len(row_observed):
            return False
        if not all(same_value(a, b) for a, b in zip(row_expected, row_observed)):
            return False
    return True


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump(path, payload):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, indent=2, ensure_ascii=False))
        handle.write("\n")


def check_shape(path, payload):
    if not isinstance(payload.get("cases"), list):
        fail(f"{path.name}: no `cases` list")
    seen = set()
    for case in payload["cases"]:
        for field in ("id", "setup", "sql", "expect"):
            if field not in case:
                fail(f"{path.name}: case {case.get('id', '?')} has no `{field}`")
        if case["id"] in seen:
            fail(f"{path.name}: duplicate case id `{case['id']}`")
        seen.add(case["id"])
        if case["expect"].get("kind") not in KINDS:
            fail(f"{path.name}: case `{case['id']}` has an unknown expect kind")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="fill expect blocks from sqlite3")
    parser.add_argument("--verify", action="store_true", help="recompute and compare with locked values")
    args = parser.parse_args()
    if args.write == args.verify:
        fail("pass exactly one of --write or --verify")

    files = sorted(SEMANTICS.glob("*.json"))
    if not files:
        fail(f"no fixtures under {SEMANTICS}")

    problems = []
    total = 0
    filled = 0
    locked = 0
    for path in files:
        payload = load(path)
        check_shape(path, payload)
        for case in payload["cases"]:
            total += 1
            expected = case["expect"]
            try:
                observed = snapshot(case)
            except (AssertionError, ValueError, TypeError, sqlite3.Error) as error:
                problems.append(f"{path.name}: {case['id']}: {error}")
                continue
            if observed is None:
                locked += 1
                continue
            if args.write:
                merged = {"kind": observed["kind"]}
                if observed.get("code"):
                    merged["code"] = observed["code"]
                if observed["kind"] == "error":
                    merged["oracle"] = observed["oracle"]
                else:
                    merged["rows"] = observed["rows"]
                case["expect"] = merged
                filled += 1
            else:
                if not same_outcome(expected, observed):
                    problems.append(f"{path.name}: {case['id']}: locked value differs from sqlite3")
        if args.write:
            dump(path, payload)

    print(f"fixtures: {len(files)} files, {total} cases, {locked} gap-locked")
    if args.write:
        print(f"filled: {filled}")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(1)
    print("verify: all locked values match CPython sqlite3")


if __name__ == "__main__":
    main()
