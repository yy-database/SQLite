// Anti-silent-regression gate.
//
// Two checks only: both suites keep executing at least `FLOOR` cases with zero
// skips, and the suites really call an external SQLite engine (`better-sqlite3`
// or Python's `sqlite3` with `PRAGMA integrity_check`) instead of grading our
// own implementation against itself.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = 30;
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function count(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
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
  return { ok: result.status === 0, executed: count(text, /# tests (\d+)/), skipped: count(text, /# skipped (\d+)/) };
}

function runPy() {
  const result = spawnSync(PYTHON, ["-m", "unittest", "discover", "-v", "-s", "tests", "-t", "tests"], {
    cwd: join(root, "projects/sqlite.py"),
    encoding: "utf8",
  });
  const text = `${result.stdout}${result.stderr}`;
  return { ok: result.status === 0, executed: count(text, /Ran (\d+) tests?/), skipped: count(text, /skipped=(\d+)/) };
}

function suiteSources(directory) {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".ts") || name.endsWith(".py"))
    .map((name) => readFileSync(join(root, directory, name), "utf8"))
    .join("\n");
}

function externalReasons() {
  const reasons = [];
  const ts = suiteSources("projects/sqlite.ts/tests");
  const py = suiteSources("projects/sqlite.py/tests");
  if (!ts.includes("better-sqlite3")) reasons.push("sqlite.ts never loads `better-sqlite3`");
  if (!ts.includes("integrity_check")) reasons.push("sqlite.ts never asks the external engine for `integrity_check`");
  if (!py.includes("sqlite3.connect")) reasons.push("sqlite.py never opens a `sqlite3` connection");
  if (!py.includes("integrity_check")) reasons.push("sqlite.py never asks the external engine for `integrity_check`");
  return reasons;
}

build();
const suites = [
  { name: "sqlite.ts", ...runTs() },
  { name: "sqlite.py", ...runPy() },
];

let failed = false;
const externals = externalReasons();
if (externals.length > 0) {
  failed = true;
  console.log(`red external truth: ${externals.join(", ")}`);
}
for (const suite of suites) {
  const reasons = [];
  if (!suite.ok) reasons.push("suite failed");
  if (suite.executed < FLOOR) reasons.push(`executed ${suite.executed} < floor ${FLOOR}`);
  if (suite.skipped > 0) reasons.push(`skipped ${suite.skipped} > 0`);
  if (reasons.length > 0) failed = true;
  console.log(`${reasons.length === 0 ? "ok" : "red"} ${suite.name}: executed=${suite.executed} skipped=${suite.skipped}${
    reasons.length === 0 ? "" : ` (${reasons.join(", ")})`
  }`);
}
process.exit(failed ? 1 : 0);
