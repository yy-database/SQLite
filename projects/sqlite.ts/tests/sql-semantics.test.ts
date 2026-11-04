// SQL semantics ported out of the retired `yydb-query` suite. Each case is
// judged by three external SQLite builds at once (`better-sqlite3`,
// `node:sqlite`, `sql.js`) and, when it carries an expectation, the agreement
// must also match that expectation. The expectation is the ported assertion,
// never this repository's implementation.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareOutcomes, runOn, type Cell, type EngineName, type Step, type StepOutcome } from "../packages/sqlite-harness/src/oracle.ts";

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const ENGINES: EngineName[] = ["better-sqlite3", "node:sqlite", "sql.js"];

interface Case {
  readonly source: string;
  readonly note?: string;
  readonly schema?: string[];
  readonly seed?: string[];
  readonly steps: Array<{ sql: string; params?: unknown[] }>;
  readonly expect?: Array<{ rows?: Cell[][] } | { error: true }>;
}

interface Corpus {
  readonly group: string;
  readonly cases: Case[];
}

function loadCorpus(): Array<{ file: string; corpus: Corpus }> {
  const only = process.env.SQL_CORPUS?.split(",").map((name) => name.trim()).filter(Boolean);
  return readdirSync(TESTS_DIR)
    .filter((name) => name.startsWith("sql-") && name.endsWith(".json"))
    .filter((name) => only === undefined || only.includes(name))
    .sort()
    .map((name) => ({
      file: name,
      corpus: JSON.parse(readFileSync(join(TESTS_DIR, name), "utf8")) as Corpus,
    }));
}

function outcomeText(outcome: StepOutcome): string {
  if (outcome.error) return `error: ${outcome.error}`;
  return `rows: ${JSON.stringify(outcome.rows ?? [])}`;
}

function assertExpectation(actual: StepOutcome, expected: { rows?: Cell[][] } | { error: true }, label: string): void {
  if ("error" in expected) {
    assert.ok(actual.error !== undefined, `${label}: expected an error, got ${outcomeText(actual)}`);
    return;
  }
  assert.ok(actual.error === undefined, `${label}: expected rows, got ${outcomeText(actual)}`);
  const rows = actual.rows ?? [];
  const wanted = expected.rows ?? [];
  const text = (cells: Cell[]) => cells.map((cell) => (cell === null ? "NULL" : JSON.stringify(cell))).join(",");
  assert.equal(rows.length, wanted.length, `${label}: expected ${wanted.length} rows (${wanted.map(text).join(" / ")}), got ${rows.map(text).join(" / ")}`);
  for (let index = 0; index < wanted.length; index += 1) {
    assert.deepEqual(rows[index], wanted[index], `${label}: row ${index + 1} differs`);
  }
}

for (const { file, corpus } of loadCorpus()) {
  for (const entry of corpus.cases) {
    test(`${corpus.group}: ${entry.source}`, async () => {
      const prefix: Step[] = [...(entry.schema ?? []), ...(entry.seed ?? [])].map((sql) => ({ sql }));
      const steps: Step[] = [...prefix, ...entry.steps.map((step) => ({ sql: step.sql, params: step.params }))];
      const outcomes = await runOn(ENGINES, steps);
      const comparison = compareOutcomes(outcomes);
      assert.ok(
        comparison.ok,
        `${file} ${entry.source}: external engines disagree\n${comparison.differences.join("\n")}${entry.note ? `\nnote: ${entry.note}` : ""}`,
      );

      if (entry.expect) {
        assert.equal(entry.expect.length, entry.steps.length, `${entry.source}: expectation count does not match the step count`);
        const baseline = outcomes[ENGINES[0]].slice(prefix.length);
        entry.expect.forEach((expected, index) => assertExpectation(baseline[index], expected, `${entry.source} step ${index + 1}`));
      }
    });
  }
}
