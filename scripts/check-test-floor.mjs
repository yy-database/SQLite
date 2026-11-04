// Anti-silent-regression gate.
//
// `sqlite.ts` and `sqlite.py` execution counts are the floor, any reported skip
// turns the gate red, every executed case must declare which external truth
// source judges it (`scripts/external-truth.json`), and every catalogued
// scenario (`scripts/scenarios.json`) must keep its scale, oracle and case
// mapping intact.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_FLOOR = 30;
const PY_FLOOR = 30;
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const manifest = JSON.parse(readFileSync(join(root, "scripts", "external-truth.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(root, "scripts", "scenarios.json"), "utf8"));
const allowedSources = new Set(manifest.sources);
const allowedDirections = new Set(manifest.directions);

function count(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
}

function names(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1].trim());
}

function build() {
  const result = spawnSync(process.execPath, [join(root, "scripts/build-napi.mjs")], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`native build failed\n${result.stdout}${result.stderr}`);
  }
}

function runTs() {
  const result = spawnSync(
    process.execPath,
    ["--test-reporter=tap", "--experimental-strip-types", "--test", "tests/**/*.test.ts"],
    { cwd: join(root, "projects/sqlite.ts"), encoding: "utf8" },
  );
  const text = `${result.stdout}${result.stderr}`;
  return {
    ok: result.status === 0,
    executed: count(text, /# tests (\d+)/),
    skipped: count(text, /# skipped (\d+)/),
    cases: names(text, /^(?:not )?ok \d+ - (.+)$/gm),
  };
}

function runPy() {
  const result = spawnSync(PYTHON, ["-m", "unittest", "discover", "-v", "-s", "tests", "-t", "tests"], {
    cwd: join(root, "projects/sqlite.py"),
    encoding: "utf8",
  });
  const text = `${result.stdout}${result.stderr}`;
  return {
    ok: result.status === 0,
    executed: count(text, /Ran (\d+) tests?/),
    skipped: count(text, /skipped=(\d+)/),
    cases: names(text, /^(\w+) \(\S+\)/gm),
  };
}

function declared(suite) {
  return manifest.suites[suite] ?? {};
}

function audit(suite, executed) {
  const reasons = [];
  const table = declared(suite);
  for (const name of executed) {
    const entry = table[name];
    if (!entry) {
      reasons.push(`no external truth source declared for "${name}"`);
      continue;
    }
    const sources = Array.isArray(entry.sources) ? entry.sources : [];
    if (sources.length === 0) reasons.push(`"${name}" declares no external source`);
    for (const source of sources) {
      if (!allowedSources.has(source)) reasons.push(`"${name}" uses unknown source ${source}`);
    }
    if (!allowedDirections.has(entry.direction)) reasons.push(`"${name}" has unknown direction ${entry.direction}`);
    if (!manifest.capabilities[entry.capability]) reasons.push(`"${name}" maps to unknown capability ${entry.capability}`);
  }
  for (const name of Object.keys(table)) {
    if (!executed.includes(name)) reasons.push(`declared case "${name}" did not execute`);
  }
  return reasons;
}

function auditedCapabilities() {
  const coverage = new Map();
  for (const [suite, table] of Object.entries(manifest.suites)) {
    for (const [name, entry] of Object.entries(table)) {
      const sides = coverage.get(entry.capability) ?? new Set();
      if (entry.direction === "both" || entry.direction === "write-to-external") sides.add("write-to-external");
      if (entry.direction === "both" || entry.direction === "external-to-read") sides.add("external-to-read");
      coverage.set(entry.capability, sides);
    }
  }
  const reasons = [];
  for (const [capability, entry] of Object.entries(manifest.capabilities)) {
    const sides = coverage.get(capability) ?? new Set();
    if (typeof entry.externalOnly === "string" && entry.externalOnly.trim().length > 0) {
      continue;
    }
    if (!sides.has("write-to-external")) reasons.push(`capability ${capability} has no write-to-external case`);
    if (!sides.has("external-to-read")) reasons.push(`capability ${capability} has no external-to-read case`);
  }
  return reasons;
}

function catalogReasons(executedBySuite) {
  const reasons = [];
  const rows = Array.isArray(catalog.scenarios) ? catalog.scenarios : [];
  if (rows.length === 0) reasons.push("scenario catalog is empty");
  const seen = new Set();
  const covered = new Set();
  for (const [index, row] of rows.entries()) {
    const label = row?.id ?? `#${index}`;
    if (!row?.id) reasons.push(`scenario ${label} has no id`);
    if (row?.id && seen.has(row.id)) reasons.push(`duplicate scenario id ${row.id}`);
    if (row?.id) seen.add(row.id);
    if (!row?.title) reasons.push(`scenario ${label} has no title`);
    if (!row?.risk) reasons.push(`scenario ${label} has no risk`);
    if (!row?.capability || !manifest.capabilities[row.capability]) {
      reasons.push(`scenario ${label} names unknown capability ${row?.capability}`);
    } else {
      covered.add(row.capability);
    }
    const scale = row?.scale ?? {};
    const magnitude = Math.max(Number(scale.rows) || 0, Number(scale.updates) || 0);
    if (magnitude < 1000) reasons.push(`scenario ${label} declares ${magnitude} rows or updates, below 1000`);
    if (!scale.shape) reasons.push(`scenario ${label} has no scale shape`);
    if (!scale.pageSize) reasons.push(`scenario ${label} has no page size`);
    if (!Number.isInteger(scale.minPages) || scale.minPages < 1) reasons.push(`scenario ${label} has no minPages`);
    const sources = row?.oracle?.sources ?? [];
    if (sources.length === 0) reasons.push(`scenario ${label} declares no external oracle`);
    for (const source of sources) {
      if (!allowedSources.has(source)) reasons.push(`scenario ${label} uses unknown oracle ${source}`);
    }
    if (!row?.oracle?.method) reasons.push(`scenario ${label} has no oracle method`);
    for (const suite of ["sqlite.ts", "sqlite.py"]) {
      const name = row?.cases?.[suite];
      if (!name) reasons.push(`scenario ${label} has no ${suite} case`);
      else if (!manifest.suites[suite]?.[name]) reasons.push(`scenario ${label} case "${name}" is not declared in ${suite}`);
      else if (!executedBySuite[suite].includes(name)) reasons.push(`scenario ${label} case "${name}" did not execute in ${suite}`);
    }
  }
  for (const capability of Object.keys(manifest.capabilities)) {
    if (!covered.has(capability)) reasons.push(`capability ${capability} has no catalog scenario`);
  }
  return reasons;
}

build();
const suites = [
  { name: "sqlite.ts", floor: TS_FLOOR, ...runTs() },
  { name: "sqlite.py", floor: PY_FLOOR, ...runPy() },
];
const executedBySuite = { "sqlite.ts": suites[0].cases, "sqlite.py": suites[1].cases };

let failed = false;
const catalogIssues = catalogReasons(executedBySuite);
if (catalogIssues.length > 0) {
  failed = true;
  console.log(`red catalog: ${catalogIssues.join(", ")}`);
}
const manifestReasons = auditedCapabilities();
if (manifestReasons.length > 0) {
  failed = true;
  console.log(`red manifest: ${manifestReasons.join(", ")}`);
}
for (const suite of suites) {
  const reasons = [];
  if (!suite.ok) reasons.push("suite failed");
  if (suite.executed < suite.floor) reasons.push(`executed ${suite.executed} < floor ${suite.floor}`);
  if (suite.skipped > 0) reasons.push(`skipped ${suite.skipped} > 0`);
  reasons.push(...audit(suite.name, suite.cases));
  if (reasons.length > 0) failed = true;
  console.log(`${reasons.length === 0 ? "ok" : "red"} ${suite.name}: executed=${suite.executed} skipped=${suite.skipped}${
    reasons.length === 0 ? "" : ` (${reasons.join(", ")})`
  }`);
}
process.exit(failed ? 1 : 0);
