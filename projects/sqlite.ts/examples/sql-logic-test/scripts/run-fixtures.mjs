// Runs the semantic fixture files against the installed `@yydb/sqlite` through
// both the TypeScript and the Python runner, and aggregates their verdicts.
//
//   node scripts/run-fixtures.mjs
//   node scripts/run-fixtures.mjs --only ts --json fixtures-report.json
//
// Installation state is prepared by `scripts/prepare.mjs`; temporary
// directories are left in place and printed.

import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packAndInstall, preparePython, run, stagingDirectory } from "./prepare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const fixturesRoot = resolve(here, "../fixtures");
const semanticsRoot = resolve(fixturesRoot, "semantics");

function argument(name, fallback = "") {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const only = argument("only", "both");
const jsonPath = argument("json", "");
const fileTimeoutMs = Number.parseInt(argument("file-timeout-ms", "120000"), 10);
const requested = argument("files", "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const files = requested.length > 0 ? requested.map((name) => (name.endsWith(".json") ? name : `${name}.json`)) : readdirSync(semanticsRoot).filter((name) => name.endsWith(".json")).sort();

const FIELDS = ["records", "pass", "gapLocked", "unsupported", "resultMismatch", "errorMismatch", "runnerError"];

function checkBindings(knownIds) {
  const bindings = JSON.parse(readFileSync(resolve(fixturesRoot, "bindings/bindings.json"), "utf8"));
  const shapes = new Set(Object.keys(bindings.shapes));
  const problems = [];
  for (const entry of bindings.cases) {
    if (!knownIds.has(entry.semanticCaseId)) {
      problems.push(`binding \`${entry.id}\` points at unknown fixture \`${entry.semanticCaseId}\``);
    }
    for (const shape of entry.shapes) {
      if (!shapes.has(shape)) {
        problems.push(`binding \`${entry.id}\` uses unknown shape \`${shape}\``);
      }
    }
  }
  return { count: bindings.cases.length, problems };
}

const staging = stagingDirectory("sqlite-fixtures-");
const { install } = packAndInstall(repoRoot, staging);
cpSync(resolve(here, "../runner"), join(install, "runner"), { recursive: true });
const commit = run("git rev-parse HEAD", repoRoot, 60_000);

let pythonExe = null;
if (only !== "ts") {
  pythonExe = preparePython(repoRoot, staging);
}

function runRunner(name, source) {
  const file = resolve(semanticsRoot, name);
  const command =
    source === "ts"
      ? `node --experimental-strip-types runner/ts/fixtures.ts --file "${file}"`
      : `"${pythonExe}" runner/py/fixtures.py --file "${file}"`;
  const result = run(command, install, fileTimeoutMs);
  if (result.status !== 0) {
    return { ok: false, reason: `runner exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(-800)}` };
  }
  try {
    return { ok: true, summary: JSON.parse(result.stdout.trim().split("\n").pop() ?? "") };
  } catch {
    return { ok: false, reason: `no JSON on stdout: ${(result.stdout + result.stderr).trim().slice(-800)}` };
  }
}

const knownIds = new Set();
for (const name of files) {
  const payload = JSON.parse(readFileSync(resolve(semanticsRoot, name), "utf8"));
  for (const testCase of payload.cases) {
    knownIds.add(testCase.id);
  }
}
const bindings = checkBindings(knownIds);

const summaries = { ts: {}, py: {} };
const parity = [];
for (const name of files) {
  for (const source of ["ts", "py"]) {
    if (only !== "both" && only !== source) {
      continue;
    }
    const outcome = runRunner(name, source);
    summaries[source][name] = outcome.ok
      ? outcome.summary
      : {
          source,
          file: name,
          category: "unknown",
          records: 0,
          pass: 0,
          gapLocked: 0,
          unsupported: 0,
          resultMismatch: 0,
          errorMismatch: 0,
          runnerError: 1,
          rejections: {},
          rejectionClauses: {},
          failures: [{ id: name, status: "runner-error", detail: outcome.reason }],
          cases: [],
          elapsedMs: 0,
        };
  }
  if (summaries.ts[name] && summaries.py[name]) {
    const differing = FIELDS.filter((field) => summaries.ts[name][field] !== summaries.py[name][field]);
    if (JSON.stringify(summaries.ts[name].rejections) !== JSON.stringify(summaries.py[name].rejections)) {
      differing.push("rejections");
    }
    parity.push({ file: name, identical: differing.length === 0, differing });
  }
}

const chosen = only === "py" ? summaries.py : summaries.ts;
const aggregate = {
  files: {},
  totals: { records: 0, pass: 0, gapLocked: 0, unsupported: 0, resultMismatch: 0, errorMismatch: 0, runnerError: 0 },
  categories: {},
  rejections: {},
  rejectionClauses: {},
  failures: [],
};
for (const name of files) {
  const summary = chosen[name];
  if (!summary) {
    continue;
  }
  aggregate.files[name] = { category: summary.category, ...Object.fromEntries(FIELDS.map((field) => [field, summary[field]])) };
  for (const field of Object.keys(aggregate.totals)) {
    aggregate.totals[field] += summary[field] ?? 0;
  }
  const category = summary.category;
  aggregate.categories[category] = aggregate.categories[category] ?? { records: 0, pass: 0, failures: 0 };
  aggregate.categories[category].records += summary.records;
  aggregate.categories[category].pass += summary.pass;
  aggregate.categories[category].failures += summary.unsupported + summary.resultMismatch + summary.errorMismatch + summary.runnerError;
  for (const [code, value] of Object.entries(summary.rejections)) {
    aggregate.rejections[code] = (aggregate.rejections[code] ?? 0) + value;
  }
  for (const [code, value] of Object.entries(summary.rejectionClauses)) {
    aggregate.rejectionClauses[code] = (aggregate.rejectionClauses[code] ?? 0) + value;
  }
  for (const failure of summary.failures ?? []) {
    aggregate.failures.push({ file: name, ...failure });
  }
}
aggregate.passRate = aggregate.totals.records > 0 ? aggregate.totals.pass / aggregate.totals.records : 0;

const report = {
  fixtures: { root: "fixtures/semantics", files, commit: commit.status === 0 ? commit.stdout.trim() : "unknown" },
  runners: { ts: "runner/ts/fixtures.ts", py: "runner/py/fixtures.py" },
  bindings,
  install: { staging },
  node: process.version,
  parity,
  summaries: only === "both" ? summaries : { [only]: chosen },
  aggregate,
};

if (jsonPath) {
  writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
}

console.log("file                        category                 records  pass  gapLocked  unsupported  result-mismatch  error-mismatch");
for (const name of files) {
  const row = aggregate.files[name];
  if (!row) {
    continue;
  }
  console.log(
    `${name.padEnd(26)} ${String(row.category).padEnd(24)} ${String(row.records).padStart(7)} ${String(row.pass).padStart(5)} ${String(row.gapLocked).padStart(10)} ${String(row.unsupported).padStart(11)} ${String(row.resultMismatch).padStart(16)} ${String(row.errorMismatch).padStart(14)}`,
  );
}
console.log("");
console.log(`semantic fixtures: ${aggregate.totals.records} cases, ${aggregate.totals.pass} pass (${(aggregate.passRate * 100).toFixed(1)}%)`);
console.log(`gap-locked: ${aggregate.totals.gapLocked}, unsupported: ${aggregate.totals.unsupported}, result-mismatch: ${aggregate.totals.resultMismatch}, error-mismatch: ${aggregate.totals.errorMismatch}, runner-error: ${aggregate.totals.runnerError}`);
for (const [category, row] of Object.entries(aggregate.categories)) {
  console.log(`  ${category.padEnd(24)} ${String(row.pass).padStart(4)}/${String(row.records).padStart(4)} pass, ${row.failures} fail`);
}
console.log(`rejection codes: ${Object.entries(aggregate.rejections).map(([code, value]) => `${code}=${value}`).join(", ") || "none"}`);
const clauses = Object.entries(aggregate.rejectionClauses);
if (clauses.length > 0) {
  console.log(`rejection clauses: ${clauses.map(([key, value]) => `${key}=${value}`).join(", ")}`);
}
console.log(`bindings: ${bindings.count} pending entries, ${bindings.problems.length} problem(s)`);
for (const problem of bindings.problems) {
  console.log(`  ${problem}`);
}
for (const entry of parity) {
  console.log(`parity ${entry.file}: ${entry.identical ? "identical" : `differs (${entry.differing.join(", ")})`}`);
}
console.log(`staging: ${staging}`);
