// Executes one SQLLogicTest script against the installed `@yydb/sqlite` engine.
//
// Run from an installation-state directory (see `scripts/run.mjs`), never from
// a repository source path:
//
//   node --experimental-strip-types runner/ts/run.ts --file corpus/test/select1.test --format json

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createEngine, type ExecValue, type NativeEngine } from "@yydb/sqlite";

import { compareQuery, parseScript, type ScriptRecord } from "./slt.ts";

const UNSUPPORTED_CODES = new Set(["unsupported-statement", "unsupported-clause", "syntax"]);
const FAILURE_SAMPLE_LIMIT = 20;

interface Failure {
  line: number;
  kind: "unsupported" | "result-mismatch" | "error-mismatch" | "runner-error";
  detail: string;
  code?: string;
  clause?: string | null;
}

interface Summary {
  source: "ts";
  file: string;
  records: number;
  pass: number;
  unsupported: number;
  resultMismatch: number;
  errorMismatch: number;
  runnerError: number;
  filtered: number;
  statements: { total: number; accepted: number; rejectedUnsupported: number; rejectedOther: number };
  queries: { total: number; matched: number };
  rejections: Record<string, number>;
  rejectionClauses: Record<string, number>;
  reasons: Record<string, number>;
  failures: Failure[];
  slow: { line: number; elapsedMs: number }[];
  haltAt: number | null;
  parseIssues: { line: number; message: string }[];
  elapsedMs: number;
}

function argument(name: string, fallback = ""): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const file = resolve(argument("file"));
const format = argument("format", "json");
const progressPath = argument("progress");
const caseWarnMs = Number.parseInt(argument("case-warn-ms", "5000"), 10);

const script = parseScript(readFileSync(file, "utf8"));
const engine: NativeEngine = createEngine();

const summary: Summary = {
  source: "ts",
  file: file.replace(/^.*[\\/]/, ""),
  records: script.records.length,
  pass: 0,
  unsupported: 0,
  resultMismatch: 0,
  errorMismatch: 0,
  runnerError: 0,
  filtered: 0,
  statements: { total: 0, accepted: 0, rejectedUnsupported: 0, rejectedOther: 0 },
  queries: { total: 0, matched: 0 },
  rejections: {},
  rejectionClauses: {},
  reasons: {},
  failures: [],
  slow: [],
  haltAt: script.haltedAt,
  parseIssues: script.issues,
  elapsedMs: 0,
};

function digest(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

const sampled: Record<string, number> = {};
function fail(kind: Failure["kind"], record: ScriptRecord, detail: string, code?: string, clause?: string | null): void {
  sampled[kind] = (sampled[kind] ?? 0) + 1;
  if (kind === "unsupported") {
    summary.unsupported += 1;
  } else if (kind === "result-mismatch") {
    summary.resultMismatch += 1;
  } else if (kind === "error-mismatch") {
    summary.errorMismatch += 1;
  } else {
    summary.runnerError += 1;
  }
  if (code) {
    count(summary.rejections, code);
    count(summary.rejectionClauses, `${code}|${clause ?? "-"}`);
  }
  if (kind !== "result-mismatch") {
    count(summary.reasons, detail.slice(0, 140));
  }
  if (sampled[kind] <= FAILURE_SAMPLE_LIMIT) {
    summary.failures.push({ line: record.line, kind, detail, code, clause });
  }
}

function gateApplies(record: ScriptRecord): boolean {
  if (!record.gate) {
    return true;
  }
  const isSqlite = record.gate.engine === "sqlite";
  return record.gate.kind === "skipif" ? !isSqlite : isSqlite;
}

const startedAt = Date.now();
let index = 0;
for (const record of script.records) {
  index += 1;
  if (progressPath) {
    writeFileSync(progressPath, `${JSON.stringify({ index, line: record.line })}\n`, { flag: "a" });
  }
  if (!gateApplies(record)) {
    summary.filtered += 1;
    continue;
  }
  if (record.issue) {
    fail("runner-error", record, record.issue);
    continue;
  }
  const caseStarted = Date.now();
  if (record.kind === "query") {
    summary.queries.total += 1;
    const outcome = engine.tryExecute(record.sql);
    if (!outcome.ok) {
      const code = outcome.error?.code ?? "unknown-error";
      const clause = outcome.error?.clause ?? null;
      if (UNSUPPORTED_CODES.has(code)) {
        fail("unsupported", record, `${code}: ${outcome.error?.message ?? ""}`, code, clause);
      } else {
        fail("error-mismatch", record, `query rejected with ${code}: ${outcome.error?.message ?? ""}`, code, clause);
      }
    } else {
      const rows = (outcome.result?.rows ?? []) as ExecValue[][];
      const comparison = compareQuery(record, rows, digest);
      if (comparison.ok) {
        summary.pass += 1;
        summary.queries.matched += 1;
      } else {
        fail("result-mismatch", record, comparison.detail);
      }
    }
  } else {
    summary.statements.total += 1;
    const outcome = engine.tryExecute(record.sql);
    if (record.kind === "statement-ok") {
      if (outcome.ok) {
        summary.pass += 1;
        summary.statements.accepted += 1;
      } else {
        const code = outcome.error?.code ?? "unknown-error";
        const clause = outcome.error?.clause ?? null;
        if (UNSUPPORTED_CODES.has(code)) {
          summary.statements.rejectedUnsupported += 1;
          fail("unsupported", record, `${code}: ${outcome.error?.message ?? ""}`, code, clause);
        } else {
          summary.statements.rejectedOther += 1;
          fail("error-mismatch", record, `statement rejected with ${code}: ${outcome.error?.message ?? ""}`, code, clause);
        }
      }
    } else if (outcome.ok) {
      fail("error-mismatch", record, "statement expected to fail but succeeded");
    } else if (record.errorPattern && !new RegExp(record.errorPattern).test(outcome.error?.message ?? "")) {
      fail("error-mismatch", record, `error message does not match /${record.errorPattern}/`);
    } else {
      summary.pass += 1;
      summary.statements.accepted += 1;
    }
  }
  const elapsed = Date.now() - caseStarted;
  if (elapsed >= caseWarnMs && summary.slow.length < 10) {
    summary.slow.push({ line: record.line, elapsedMs: elapsed });
  }
}
summary.elapsedMs = Date.now() - startedAt;

if (format === "json") {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  process.stdout.write(
    `${summary.file}: records=${summary.records} pass=${summary.pass} unsupported=${summary.unsupported} ` +
      `result-mismatch=${summary.resultMismatch} error-mismatch=${summary.errorMismatch} runner-error=${summary.runnerError} ` +
      `filtered=${summary.filtered} in ${summary.elapsedMs} ms\n`,
  );
}
