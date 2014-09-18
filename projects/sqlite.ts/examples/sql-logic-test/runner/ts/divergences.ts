// Records the `@yydb/sqlite` side of the divergence ledger.
//
// Reads the ledger, replays each case on a fresh engine (setup statements first,
// then `sql`) and prints one JSON object. `scripts/gen-divergences.mjs` merges
// this with the real SQLite side. Run it from an installation-state directory.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createEngine, type ExecValue, type NativeEngine } from "@yydb/sqlite";

interface LedgerCase {
  id: string;
  setup?: string[];
  sql: string;
}

interface Outcome {
  kind: "rows" | "error";
  rows?: (null | number | string | { $blob: string })[][];
  stage?: "setup" | "sql";
  code?: string;
  clause?: string | null;
  message?: string;
}

function argument(name: string, fallback = ""): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

function normalize(value: ExecValue): null | number | string | { $blob: string } {
  if (value !== null && typeof value === "object") {
    return { $blob: String((value as { $blob: string }).$blob).toLowerCase() };
  }
  return value;
}

function errorOutcome(stage: "setup" | "sql", error: { code?: string; message?: string; clause?: string | null } | undefined): Outcome {
  return {
    kind: "error",
    stage,
    code: error?.code ?? "unknown-error",
    clause: error?.clause ?? null,
    message: error?.message ?? "",
  };
}

function runCase(testCase: LedgerCase): Outcome {
  const engine: NativeEngine = createEngine();
  for (const statement of testCase.setup ?? []) {
    const outcome = engine.tryExecute(statement);
    if (!outcome.ok) {
      return errorOutcome("setup", outcome.error);
    }
  }
  const outcome = engine.tryExecute(testCase.sql);
  if (!outcome.ok) {
    return errorOutcome("sql", outcome.error);
  }
  return { kind: "rows", rows: (outcome.result?.rows ?? []).map((row) => row.map(normalize)) };
}

const ledgerPath = resolve(argument("ledger"));
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { cases: LedgerCase[] };

let engineVersion = "unknown";
try {
  engineVersion = createEngine().sqliteVersion();
} catch {
  engineVersion = "unavailable";
}

const results: Record<string, Outcome> = {};
for (const testCase of ledger.cases) {
  results[testCase.id] = runCase(testCase);
}

process.stdout.write(
  `${JSON.stringify({ engineVersion, node: process.version, module: "@yydb/sqlite createEngine", results })}\n`,
);
