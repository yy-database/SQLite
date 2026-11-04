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

import { compareOutcomes, runOn, type Cell, type EngineName, type Step, type StepOutcome } from "../../sqlite-harness/src/oracle.ts";

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

// JavaScript adapters cannot always tell an INTEGER from a REAL: `sql.js`
// hands back plain numbers for both classes, and `Number.isInteger` is true
// for integral REALs such as 9.22e19. Expectations therefore compare numeric
// cells by value, while text, blob and NULL stay exact. Queries that need the
// storage class itself assert on `typeof(...)`.
function cellMatches(actual: Cell, expected: Cell): boolean {
  if (actual === null || expected === null) return actual === expected;
  const numeric = (cell: Cell): string | undefined => ("i" in cell ? cell.i : "r" in cell ? cell.r : undefined);
  const left = numeric(actual);
  const right = numeric(expected);
  if (left !== undefined && right !== undefined) {
    const a = Number(left);
    const b = Number(right);
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  if ("t" in actual && "t" in expected) return actual.t === expected.t;
  if ("b" in actual && "b" in expected) return actual.b === expected.b;
  return false;
}

// Corpus parameters use the same cell shape as results so the JSON stays
// engine-neutral. Adapters need real JavaScript values, and an integer larger
// than the safe range must bind as a `bigint` to keep its exact value.
function decodeParam(cell: unknown): unknown {
  if (cell === null || typeof cell !== "object") return cell;
  const typed = cell as { i?: string; r?: string; t?: string; b?: string };
  if (typed.i !== undefined) {
    const value = Number(typed.i);
    return Number.isSafeInteger(value) ? value : BigInt(typed.i);
  }
  if (typed.r !== undefined) return Number(typed.r);
  if (typed.t !== undefined) return typed.t;
  if (typed.b !== undefined) return new Uint8Array(Buffer.from(typed.b, "hex"));
  return cell;
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
    const matches = rows[index].length === wanted[index].length && rows[index].every((cell, column) => cellMatches(cell, wanted[index][column]));
    assert.ok(matches, `${label}: row ${index + 1} differs (got ${text(rows[index])}, expected ${text(wanted[index])})`);
  }
}

for (const { file, corpus } of loadCorpus()) {
  for (const entry of corpus.cases) {
    test(`${corpus.group}: ${entry.source}`, async () => {
      const prefix: Step[] = [...(entry.schema ?? []), ...(entry.seed ?? [])].map((sql) => ({ sql }));
      const steps: Step[] = [...prefix, ...entry.steps.map((step) => ({ sql: step.sql, params: step.params?.map(decodeParam) }))];
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
