// One-command acceptance harness for the SQLite suites.
//
// It builds `sqlite.node`, runs `sqlite.ts` and `sqlite.py` in separate child
// processes, then runs the three platform smokes (`node`, `wasm`, `python`) so
// every shipped binding proves the same external truth. It fails if a suite
// reports a failure, executes fewer than `FLOOR` cases, skips a case, or stops
// calling a real external engine.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { platformStages } from "../platforms/stages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = 30;
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function count(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
}

function run(command, args, cwd) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return { status: result.status, text: `${result.stdout}${result.stderr}`, elapsed: Date.now() - started };
}

function build() {
  const result = run(process.execPath, [join(root, "scripts/build-napi.mjs")], root);
  if (result.status !== 0) throw new Error(`native build failed\n${result.text}`);
}

function runTs() {
  const result = run(
    process.execPath,
    ["--test-reporter=tap", "--experimental-strip-types", "--test", "tests/**/*.test.ts"],
    join(root, "projects/sqlite.ts"),
  );
  return {
    ok: result.status === 0,
    executed: count(result.text, /# tests (\d+)/),
    skipped: count(result.text, /# skipped (\d+)/),
    elapsed: result.elapsed,
    tail: result.status === 0 ? "" : result.text,
  };
}

function runPy() {
  const result = run(PYTHON, ["-m", "unittest", "discover", "-v", "-s", "tests", "-t", "tests"], join(root, "projects/sqlite.py"));
  return {
    ok: result.status === 0,
    executed: count(result.text, /Ran (\d+) tests?/),
    skipped: count(result.text, /skipped=(\d+)/),
    elapsed: result.elapsed,
    tail: result.status === 0 ? "" : result.text,
  };
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
const platforms = platformStages.map((stage) => stage.run());

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
  console.log(
    `${reasons.length === 0 ? "ok" : "red"} ${suite.name}: executed=${suite.executed} skipped=${suite.skipped} elapsed=${
      suite.elapsed
    }ms${reasons.length === 0 ? "" : ` (${reasons.join(", ")})`}`,
  );
  if (reasons.length > 0 && suite.tail) console.log(suite.tail);
}
for (const item of platforms) {
  if (!item.ok) failed = true;
  console.log(
    `${item.ok ? "ok" : "red"} ${item.name}: executed=${item.executed} skipped=${item.skipped} elapsed=${item.elapsed}ms${
      item.ok ? "" : ` (${item.reasons.join(", ")})`
    }`,
  );
  if (!item.ok && item.tail) console.log(item.tail);
}
process.exit(failed ? 1 : 0);
