"""Executes one SQLLogicTest script against the installed `sqlite_format3` engine.

The runner mirrors the TypeScript runner byte for byte in behaviour: same
parser, same rendering rules, same failure taxonomy, same JSON envelope.
Run it from an installation-state virtual environment (see `scripts/run.mjs`):

    python runner/py/run.py --file corpus/test/select1.test --format json
"""

import argparse
import hashlib
import json
import re
import time

import sqlite_format3

UNSUPPORTED_CODES = {"unsupported-statement", "unsupported-clause", "syntax"}
FAILURE_SAMPLE_LIMIT = 20
DEFAULT_HASH_THRESHOLD = 8


def parse_script(text):
    lines = text.splitlines()
    records = []
    issues = []
    hash_threshold = DEFAULT_HASH_THRESHOLD
    gate = None
    pending_issue = ""
    halted_at = None
    at = 0

    def read_block():
        nonlocal at
        while at < len(lines) and (lines[at].strip() == "" or lines[at].startswith("#")):
            at += 1
        if at >= len(lines):
            return None
        line = at + 1
        header = lines[at].strip()
        at += 1
        body = []
        while at < len(lines) and lines[at].strip() != "":
            if not lines[at].startswith("#"):
                body.append(lines[at])
            at += 1
        return {"line": line, "header": header, "body": body}

    while True:
        block = read_block()
        if block is None:
            break
        line, header, body = block["line"], block["header"], block["body"]
        parts = header.split()
        directive = parts[0] if parts else ""

        if directive == "halt":
            halted_at = line
            break
        if directive == "hash-threshold":
            try:
                hash_threshold = int(parts[1])
            except (IndexError, ValueError):
                issues.append({"line": line, "message": f"invalid hash-threshold header: {header}"})
            continue
        if directive in ("skipif", "onlyif"):
            gate = {"kind": directive, "engine": (parts[1] if len(parts) > 1 else "").lower()}
            continue
        if directive in ("require", "control"):
            pending_issue = f"unsupported directive `{header}`"
            issues.append({"line": line, "message": pending_issue})
            continue
        if directive == "statement":
            form = (parts[1] if len(parts) > 1 else "").lower()
            if form not in ("ok", "error"):
                issues.append({"line": line, "message": f"unknown statement form: {header}"})
                gate = None
                pending_issue = ""
                continue
            records.append(
                {
                    "line": line,
                    "kind": "statement-ok" if form == "ok" else "statement-error",
                    "sql": "\n".join(body),
                    "types": "",
                    "mode": "nosort",
                    "label": "",
                    "expected": [],
                    "errorPattern": " ".join(parts[2:]),
                    "gate": gate,
                    "issue": pending_issue,
                }
            )
            gate = None
            pending_issue = ""
            continue
        if directive == "query":
            types = parts[1] if len(parts) > 1 else ""
            second = (parts[2] if len(parts) > 2 else "").lower()
            if second in ("nosort", "rowsort", "valuesort"):
                mode = second
                label = parts[3] if len(parts) > 3 else ""
            else:
                mode = "nosort"
                label = parts[2] if len(parts) > 2 else ""
            separator = next((i for i, entry in enumerate(body) if entry.strip() == "----"), -1)
            if separator < 0:
                issues.append({"line": line, "message": "query block has no `----` separator"})
                gate = None
                pending_issue = ""
                continue
            expected = body[separator + 1 :]
            if not expected:
                issues.append({"line": line, "message": "query block has no expected values"})
            records.append(
                {
                    "line": line,
                    "kind": "query",
                    "sql": "\n".join(body[:separator]),
                    "types": types,
                    "mode": mode,
                    "label": label,
                    "expected": expected,
                    "errorPattern": "",
                    "gate": gate,
                    "issue": pending_issue,
                }
            )
            gate = None
            pending_issue = ""
            continue
        issues.append({"line": line, "message": f"unknown directive: {header}"})
        gate = None
        pending_issue = ""

    return {"records": records, "issues": issues, "haltedAt": halted_at}


def hashed_expectation(expected):
    if len(expected) != 1:
        return None
    match = re.match(r"^(\d+) values hashing to ([0-9a-f]{32})$", expected[0].strip())
    return (int(match.group(1)), match.group(2)) if match else None


def render_cell(type_char, cell):
    if cell is None:
        return "NULL"
    if isinstance(cell, dict):
        return f"(blob:{len(cell.get('$blob', '')) // 2}B)"
    if type_char == "I":
        if isinstance(cell, float) and cell.is_integer():
            return str(int(cell))
        return str(cell)
    if type_char == "R":
        return f"{cell:.3f}" if isinstance(cell, (int, float)) else str(cell)
    if type_char == "T":
        return "(empty)" if cell == "" else str(cell)
    return str(cell)


def render_rows(types, rows):
    rendered = []
    values = []
    for row in rows:
        cells = [render_cell(types[i] if i < len(types) else "T", cell) for i, cell in enumerate(row)]
        rendered.append(cells)
        values.extend(cells)
    return rendered, values


def compare_query(record, rows):
    rendered, values = render_rows(record["types"], rows)
    hashed = hashed_expectation(record["expected"])
    # The corpus compares one value per line, not one row per line, so the
    # expected block and the rendered sequence have the same flat shape.
    if record["mode"] == "rowsort":
        ordered = sorted(rendered, key=lambda row: " ".join(row))
        sequence = [cell for row in ordered for cell in row]
    elif record["mode"] == "valuesort":
        sequence = sorted(values)
    else:
        sequence = values

    if hashed:
        joined = "".join(value + "\n" for value in sequence)
        actual = hashlib.md5(joined.encode()).hexdigest()
        ok = len(sequence) == hashed[0] and actual == hashed[1]
        detail = (
            "hash matched"
            if ok
            else f"hash mismatch: {len(sequence)} values -> {actual}, expected {hashed[0]} values -> {hashed[1]}"
        )
        return ok, detail

    expected = [line.rstrip("\r") for line in record["expected"]]
    ok = len(expected) == len(sequence)
    detail = "" if ok else f"value count {len(sequence)}, expected {len(expected)}"
    for index in range(min(len(expected), len(sequence))):
        if expected[index] != sequence[index]:
            ok = False
            if not detail:
                detail = f"first difference at value {index + 1}: got `{sequence[index]}`, expected `{expected[index]}`"
            break
    return ok, detail


def gate_applies(record):
    if not record["gate"]:
        return True
    is_sqlite = record["gate"]["engine"] == "sqlite"
    return not is_sqlite if record["gate"]["kind"] == "skipif" else is_sqlite


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--format", default="json")
    parser.add_argument("--progress", default="")
    parser.add_argument("--case-warn-ms", type=int, default=5000)
    args = parser.parse_args()

    with open(args.file, encoding="utf-8") as handle:
        script = parse_script(handle.read())

    engine = sqlite_format3.SqliteEngine.create()

    summary = {
        "source": "py",
        "file": re.split(r"[\\/]", args.file)[-1],
        "records": len(script["records"]),
        "pass": 0,
        "unsupported": 0,
        "resultMismatch": 0,
        "errorMismatch": 0,
        "runnerError": 0,
        "filtered": 0,
        "statements": {"total": 0, "accepted": 0, "rejectedUnsupported": 0, "rejectedOther": 0},
        "queries": {"total": 0, "matched": 0},
        "rejections": {},
        "rejectionClauses": {},
        "reasons": {},
        "failures": [],
        "slow": [],
        "haltAt": script["haltedAt"],
        "parseIssues": script["issues"],
        "elapsedMs": 0,
    }

    def count(map_name, key):
        summary[map_name][key] = summary[map_name].get(key, 0) + 1

    sampled = {}

    def fail(kind, record, detail, code=None, clause=None):
        sampled[kind] = sampled.get(kind, 0) + 1
        counters = {
            "unsupported": "unsupported",
            "result-mismatch": "resultMismatch",
            "error-mismatch": "errorMismatch",
            "runner-error": "runnerError",
        }
        summary[counters[kind]] += 1
        if code:
            count("rejections", code)
            count("rejectionClauses", f"{code}|{clause if clause else '-'}")
        if kind != "result-mismatch":
            count("reasons", detail[:140])
        if sampled[kind] <= FAILURE_SAMPLE_LIMIT:
            summary["failures"].append({"line": record["line"], "kind": kind, "detail": detail, "code": code, "clause": clause})

    started = time.time()
    for index, record in enumerate(script["records"], start=1):
        if args.progress:
            with open(args.progress, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"index": index, "line": record["line"]}) + "\n")
        if not gate_applies(record):
            summary["filtered"] += 1
            continue
        if record["issue"]:
            fail("runner-error", record, record["issue"])
            continue
        case_started = time.time()
        if record["kind"] == "query":
            summary["queries"]["total"] += 1
            outcome = engine.try_execute(record["sql"])
            if not outcome["ok"]:
                error = outcome.get("error") or {}
                code = error.get("code") or "unknown-error"
                clause = error.get("clause")
                detail = f"{code}: {error.get('message', '')}"
                if code in UNSUPPORTED_CODES:
                    fail("unsupported", record, detail, code, clause)
                else:
                    fail("error-mismatch", record, f"query rejected with {detail}", code, clause)
            else:
                rows = (outcome["result"] or {}).get("rows") or []
                ok, detail = compare_query(record, rows)
                if ok:
                    summary["pass"] += 1
                    summary["queries"]["matched"] += 1
                else:
                    fail("result-mismatch", record, detail)
        else:
            summary["statements"]["total"] += 1
            outcome = engine.try_execute(record["sql"])
            if record["kind"] == "statement-ok":
                if outcome["ok"]:
                    summary["pass"] += 1
                    summary["statements"]["accepted"] += 1
                else:
                    error = outcome.get("error") or {}
                    code = error.get("code") or "unknown-error"
                    clause = error.get("clause")
                    detail = f"{code}: {error.get('message', '')}"
                    if code in UNSUPPORTED_CODES:
                        summary["statements"]["rejectedUnsupported"] += 1
                        fail("unsupported", record, detail, code, clause)
                    else:
                        summary["statements"]["rejectedOther"] += 1
                        fail("error-mismatch", record, f"statement rejected with {detail}", code, clause)
            elif outcome["ok"]:
                fail("error-mismatch", record, "statement expected to fail but succeeded")
            elif record["errorPattern"] and not re.search(record["errorPattern"], (outcome.get("error") or {}).get("message", "")):
                fail("error-mismatch", record, f"error message does not match /{record['errorPattern']}/")
            else:
                summary["pass"] += 1
                summary["statements"]["accepted"] += 1
        elapsed = (time.time() - case_started) * 1000
        if elapsed >= args.case_warn_ms and len(summary["slow"]) < 10:
            summary["slow"].append({"line": record["line"], "elapsedMs": round(elapsed, 1)})
    summary["elapsedMs"] = round((time.time() - started) * 1000, 1)

    if args.format == "json":
        print(json.dumps(summary))
    else:
        print(
            f"{summary['file']}: records={summary['records']} pass={summary['pass']} unsupported={summary['unsupported']} "
            f"result-mismatch={summary['resultMismatch']} error-mismatch={summary['errorMismatch']} "
            f"runner-error={summary['runnerError']} filtered={summary['filtered']} in {summary['elapsedMs']} ms"
        )


if __name__ == "__main__":
    main()
