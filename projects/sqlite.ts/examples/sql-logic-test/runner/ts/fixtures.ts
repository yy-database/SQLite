// Executes one semantic fixture file against the installed `@yydb/sqlite`.
//
// The fixtures are language-neutral JSON: the TypeScript runner and the Python
// runner parse the same file and must reach the same verdict per case. Run from
// an installation-state directory (see `scripts/run-fixtures.mjs`):
//
//   node --experimental-strip-types runner/ts/fixtures.ts --file fixtures/semantics/01-query.json

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createEngine, type ExecValue, type NativeEngine } from "@yydb/sqlite";

const UNSUPPORTED_CODES = new Set(["unsupported-statement", "unsupported-clause", "syntax"]);
const FAILURE_SAMPLE_LIMIT = 20;

type Cell = null | number | string | { $blob: string };

interface SetupObject {
  sql?: string;
  expect?: string;
  repeat?: number;
  insert?: string;
}

interface ExpectedRows {
  kind: "rows";
  rows?: Cell[][];
}

interface ExpectedError {
  kind: "error";
  code?: string;
  oracle?: string;
}

interface ExpectedRejection {
  kind: "rejected";
  code: string;
  clause?: string;
  note?: string;
}

interface FixtureCase {
  id: string;
  setup: (string | SetupObject)[];
  sql: string;
  expect: ExpectedRows | ExpectedError | ExpectedRejection;
}

type Status = "pass" | "unsupported" | "result-mismatch" | "error-mismatch" | "runner-error";

interface CaseRecord {
  id: string;
  status: Status;
  code?: string;
  clause?: string | null;
  detail?: string;
}

const COUNTERS: Record<Status, keyof Pick<Summary, "pass" | "unsupported" | "resultMismatch" | "errorMismatch" | "runnerError">> = {
  pass: "pass",
  unsupported: "unsupported",
  "result-mismatch": "resultMismatch",
  "error-mismatch": "errorMismatch",
  "runner-error": "runnerError",
};

interface Summary {
  source: "ts";
  file: string;
  category: string;
  records: number;
  pass: number;
  gapLocked: number;
  unsupported: number;
  resultMismatch: number;
  errorMismatch: number;
  runnerError: number;
  rejections: Record<string, number>;
  rejectionClauses: Record<string, number>;
  failures: CaseRecord[];
  cases: CaseRecord[];
  elapsedMs: number;
}

function argument(name: string, fallback = ""): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const file = resolve(argument("file"));
const payload = JSON.parse(readFileSync(file, "utf8")) as { category: string; cases: FixtureCase[] };

const summary: Summary = {
  source: "ts",
  file: file.replace(/^.*[\\/]/, ""),
  category: payload.category ?? "unknown",
  records: payload.cases.length,
  pass: 0,
  gapLocked: 0,
  unsupported: 0,
  resultMismatch: 0,
  errorMismatch: 0,
  runnerError: 0,
  rejections: {},
  rejectionClauses: {},
  failures: [],
  cases: [],
  elapsedMs: 0,
};

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

const sampled: Record<string, number> = {};

function fail(status: Status, id: string, detail: string, code?: string, clause?: string | null): void {
  summary[COUNTERS[status]] += 1;
  if (code) {
    count(summary.rejections, code);
    count(summary.rejectionClauses, `${code}|${clause ?? "-"}`);
  }
  const record: CaseRecord = { id, status, detail: detail.slice(0, 200), code, clause };
  summary.cases.push(record);
  sampled[status] = (sampled[status] ?? 0) + 1;
  if (sampled[status] <= FAILURE_SAMPLE_LIMIT) {
    summary.failures.push(record);
  }
}

function pass(id: string, gapLocked = false): void {
  summary.pass += 1;
  if (gapLocked) {
    summary.gapLocked += 1;
  }
  summary.cases.push({ id, status: "pass" });
}

function setupSteps(entry: string | SetupObject): { sql: string; mustFail: boolean }[] {
  if (typeof entry === "string") {
    return [{ sql: entry, mustFail: false }];
  }
  if (typeof entry.repeat === "number") {
    const steps: { sql: string; mustFail: boolean }[] = [];
    for (let index = 1; index <= entry.repeat; index += 1) {
      steps.push({ sql: (entry.sql ?? "").replaceAll("{n}", String(index)), mustFail: false });
      if (entry.insert) {
        steps.push({ sql: entry.insert.replaceAll("{n}", String(index)), mustFail: false });
      }
    }
    return steps;
  }
  return [{ sql: entry.sql ?? "", mustFail: entry.expect === "error" }];
}

function blobHex(cell: Cell): string | null {
  return typeof cell === "object" && cell !== null && "$blob" in cell ? String(cell.$blob).toLowerCase() : null;
}

function sameCell(expected: Cell, actual: ExecValue): boolean {
  if (expected === null || actual === null) {
    return expected === actual;
  }
  const expectedBlob = blobHex(expected);
  const actualBlob = blobHex(actual as Cell);
  if (expectedBlob !== null || actualBlob !== null) {
    return expectedBlob === actualBlob;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isInteger(expected) && Number.isInteger(actual)) {
      return expected === actual;
    }
    return Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected), Math.abs(actual));
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return expected === actual;
  }
  return false;
}

function describeCell(cell: Cell | ExecValue): string {
  if (cell === null) {
    return "NULL";
  }
  const blob = blobHex(cell as Cell);
  if (blob !== null) {
    return `blob:${blob}`;
  }
  return typeof cell === "string" ? `'${cell}'` : String(cell);
}

function compareRows(expected: Cell[][], actual: ExecValue[][]): { ok: boolean; detail: string } {
  if (expected.length !== actual.length) {
    return { ok: false, detail: `row count ${actual.length}, expected ${expected.length}` };
  }
  for (let rowIndex = 0; rowIndex < expected.length; rowIndex += 1) {
    const expectedRow = expected[rowIndex];
    const actualRow = actual[rowIndex] ?? [];
    if (expectedRow.length !== actualRow.length) {
      return { ok: false, detail: `row ${rowIndex + 1}: column count ${actualRow.length}, expected ${expectedRow.length}` };
    }
    for (let column = 0; column < expectedRow.length; column += 1) {
      if (!sameCell(expectedRow[column], actualRow[column])) {
        return {
          ok: false,
          detail: `row ${rowIndex + 1}, column ${column + 1}: got ${describeCell(actualRow[column])}, expected ${describeCell(expectedRow[column])}`,
        };
      }
    }
  }
  return { ok: true, detail: "" };
}

function isUnsupported(code: string): boolean {
  return UNSUPPORTED_CODES.has(code);
}

const startedAt = Date.now();
for (const testCase of payload.cases) {
  const engine: NativeEngine = createEngine();
  let blocked: { status: Status; detail: string; code?: string; clause?: string | null } | null = null;

  for (const entry of testCase.setup) {
    for (const step of setupSteps(entry)) {
      const outcome = engine.tryExecute(step.sql);
      const code = outcome.error?.code ?? "unknown-error";
      const clause = outcome.error?.clause ?? null;
      if (step.mustFail) {
        if (outcome.ok) {
          blocked = { status: "error-mismatch", detail: `setup step expected to fail but succeeded: ${step.sql}` };
        }
      } else if (!outcome.ok) {
        blocked = {
          status: isUnsupported(code) ? "unsupported" : "error-mismatch",
          detail: `setup rejected with ${code}: ${outcome.error?.message ?? ""} (${step.sql})`,
          code,
          clause,
        };
      }
      if (blocked) {
        break;
      }
    }
    if (blocked) {
      break;
    }
  }

  if (blocked) {
    fail(blocked.status, testCase.id, blocked.detail, blocked.code, blocked.clause);
    continue;
  }

  const outcome = engine.tryExecute(testCase.sql);
  const code = outcome.error?.code ?? "unknown-error";
  const clause = outcome.error?.clause ?? null;
  const expect = testCase.expect;

  if (expect.kind === "rows") {
    if (!outcome.ok) {
      fail(isUnsupported(code) ? "unsupported" : "error-mismatch", testCase.id, `rejected with ${code}: ${outcome.error?.message ?? ""}`, code, clause);
      continue;
    }
    const comparison = compareRows(expect.rows ?? [], (outcome.result?.rows ?? []) as ExecValue[][]);
    if (comparison.ok) {
      pass(testCase.id);
    } else {
      fail("result-mismatch", testCase.id, comparison.detail);
    }
    continue;
  }

  if (expect.kind === "error") {
    if (outcome.ok) {
      fail("error-mismatch", testCase.id, "sqlite rejects this statement but the engine accepted it");
    } else if (expect.code && expect.code !== code) {
      fail("error-mismatch", testCase.id, `rejected with ${code}, expected ${expect.code}: ${outcome.error?.message ?? ""}`, code, clause);
    } else {
      pass(testCase.id);
    }
    continue;
  }

  if (outcome.ok) {
    fail("error-mismatch", testCase.id, `expected the engine to reject with ${expect.code} but it succeeded`);
  } else if (code !== expect.code || (expect.clause !== undefined && expect.clause !== (clause ?? ""))) {
    fail(
      "error-mismatch",
      testCase.id,
      `gap lock drifted: rejected with ${code}/${clause ?? "-"}, expected ${expect.code}/${expect.clause ?? "-"}`,
      code,
      clause,
    );
  } else {
    pass(testCase.id, true);
  }
}
summary.elapsedMs = Date.now() - startedAt;

process.stdout.write(`${JSON.stringify(summary)}\n`);
