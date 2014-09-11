"""Executes one semantic fixture file against the installed `sqlite_format3`.

Mirrors `runner/ts/fixtures.ts` behaviour: same JSON file, same setup expansion,
same failure taxonomy, same summary envelope. Run it from an installation-state
virtual environment (see `scripts/run-fixtures.mjs`):

    python runner/py/fixtures.py --file fixtures/semantics/01-query.json
"""

import argparse
import json
import re
import time

import sqlite_format3

UNSUPPORTED_CODES = {"unsupported-statement", "unsupported-clause", "syntax"}
FAILURE_SAMPLE_LIMIT = 20
COUNTERS = {
    "pass": "pass",
    "unsupported": "unsupported",
    "result-mismatch": "resultMismatch",
    "error-mismatch": "errorMismatch",
    "runner-error": "runnerError",
}


def setup_steps(entry):
    """Yields `(sql, must_fail)` exactly like the TypeScript runner."""
    if isinstance(entry, str):
        yield entry, False
        return
    if "repeat" in entry:
        for index in range(1, int(entry["repeat"]) + 1):
            yield entry["sql"].replace("{n}", str(index)), False
            if entry.get("insert"):
                yield entry["insert"].replace("{n}", str(index)), False
        return
    yield entry.get("sql", ""), entry.get("expect") == "error"


def blob_hex(cell):
    if isinstance(cell, dict) and "$blob" in cell:
        return str(cell["$blob"]).lower()
    return None


def same_cell(expected, actual):
    if expected is None or actual is None:
        return expected is actual
    expected_blob, actual_blob = blob_hex(expected), blob_hex(actual)
    if expected_blob is not None or actual_blob is not None:
        return expected_blob == actual_blob
    if isinstance(expected, bool) or isinstance(actual, bool):
        return False
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if isinstance(expected, int) and isinstance(actual, int):
            return expected == actual
        return abs(float(expected) - float(actual)) <= 1e-9 * max(1.0, abs(float(expected)), abs(float(actual)))
    if isinstance(expected, str) and isinstance(actual, str):
        return expected == actual
    return False


def describe_cell(cell):
    if cell is None:
        return "NULL"
    blob = blob_hex(cell)
    if blob is not None:
        return f"blob:{blob}"
    return f"'{cell}'" if isinstance(cell, str) else str(cell)


def compare_rows(expected, actual):
    if len(expected) != len(actual):
        return False, f"row count {len(actual)}, expected {len(expected)}"
    for row_index, expected_row in enumerate(expected):
        actual_row = actual[row_index] or []
        if len(expected_row) != len(actual_row):
            return False, f"row {row_index + 1}: column count {len(actual_row)}, expected {len(expected_row)}"
        for column, expected_cell in enumerate(expected_row):
            if not same_cell(expected_cell, actual_row[column]):
                return (
                    False,
                    f"row {row_index + 1}, column {column + 1}: got {describe_cell(actual_row[column])}, "
                    f"expected {describe_cell(expected_cell)}",
                )
    return True, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    with open(args.file, encoding="utf-8") as handle:
        payload = json.load(handle)

    summary = {
        "source": "py",
        "file": re.split(r"[\\/]", args.file)[-1],
        "category": payload.get("category", "unknown"),
        "records": len(payload["cases"]),
        "pass": 0,
        "gapLocked": 0,
        "unsupported": 0,
        "resultMismatch": 0,
        "errorMismatch": 0,
        "runnerError": 0,
        "rejections": {},
        "rejectionClauses": {},
        "failures": [],
        "cases": [],
        "elapsedMs": 0,
    }
    sampled = {}

    def count(map_name, key):
        summary[map_name][key] = summary[map_name].get(key, 0) + 1

    def fail(status, case_id, detail, code=None, clause=None):
        summary[COUNTERS[status]] += 1
        if code:
            count("rejections", code)
            count("rejectionClauses", f"{code}|{clause if clause else '-'}")
        record = {"id": case_id, "status": status, "detail": detail[:200], "code": code, "clause": clause}
        summary["cases"].append(record)
        sampled[status] = sampled.get(status, 0) + 1
        if sampled[status] <= FAILURE_SAMPLE_LIMIT:
            summary["failures"].append(record)

    def passed(case_id, gap_locked=False):
        summary["pass"] += 1
        if gap_locked:
            summary["gapLocked"] += 1
        summary["cases"].append({"id": case_id, "status": "pass"})

    started = time.time()
    for case in payload["cases"]:
        engine = sqlite_format3.SqliteEngine.create()
        blocked = None
        for entry in case["setup"]:
            for sql, must_fail in setup_steps(entry):
                outcome = engine.try_execute(sql)
                error = outcome.get("error") if not outcome["ok"] else None
                code = (error or {}).get("code") or "unknown-error"
                clause = (error or {}).get("clause")
                if must_fail:
                    if outcome["ok"]:
                        blocked = ("error-mismatch", f"setup step expected to fail but succeeded: {sql}", None, None)
                elif not outcome["ok"]:
                    status = "unsupported" if code in UNSUPPORTED_CODES else "error-mismatch"
                    blocked = (status, f"setup rejected with {code}: {(error or {}).get('message', '')} ({sql})", code, clause)
                if blocked:
                    break
            if blocked:
                break
        if blocked:
            fail(blocked[0], case["id"], blocked[1], blocked[2], blocked[3])
            continue

        outcome = engine.try_execute(case["sql"])
        error = outcome.get("error") if not outcome["ok"] else None
        code = (error or {}).get("code") or "unknown-error"
        clause = (error or {}).get("clause")
        expect = case["expect"]

        if expect["kind"] == "rows":
            if not outcome["ok"]:
                status = "unsupported" if code in UNSUPPORTED_CODES else "error-mismatch"
                fail(status, case["id"], f"rejected with {code}: {(error or {}).get('message', '')}", code, clause)
                continue
            rows = (outcome.get("result") or {}).get("rows") or []
            ok, detail = compare_rows(expect.get("rows") or [], rows)
            if ok:
                passed(case["id"])
            else:
                fail("result-mismatch", case["id"], detail)
            continue

        if expect["kind"] == "error":
            if outcome["ok"]:
                fail("error-mismatch", case["id"], "sqlite rejects this statement but the engine accepted it")
            elif expect.get("code") and expect["code"] != code:
                fail("error-mismatch", case["id"], f"rejected with {code}, expected {expect['code']}: {(error or {}).get('message', '')}", code, clause)
            else:
                passed(case["id"])
            continue

        if outcome["ok"]:
            fail("error-mismatch", case["id"], f"expected the engine to reject with {expect['code']} but it succeeded")
        elif code != expect["code"] or ("clause" in expect and expect["clause"] != (clause or "")):
            fail(
                "error-mismatch",
                case["id"],
                f"gap lock drifted: rejected with {code}/{clause or '-'}, expected {expect['code']}/{expect.get('clause', '-')}",
                code,
                clause,
            )
        else:
            passed(case["id"], True)

    summary["elapsedMs"] = round((time.time() - started) * 1000, 1)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
