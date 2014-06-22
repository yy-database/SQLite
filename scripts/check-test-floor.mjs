// Anti-silent-regression gate: `sqlite.ts` and `sqlite.py` execution counts are
// the floor, and any reported skip turns the gate red.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_FLOOR = 11;
const PY_FLOOR = 11;

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
  const result = spawnSync("python", ["-m", "unittest", "discover", "-s", "tests", "-t", "tests"], {
    cwd: join(root, "projects/sqlite.py"),
    encoding: "utf8",
  });
  const text = `${result.stdout}${result.stderr}`;
  return { ok: result.status === 0, executed: count(text, /Ran (\d+) tests?/), skipped: count(text, /skipped=(\d+)/) };
}

build();
const suites = [
  { name: "sqlite.ts", floor: TS_FLOOR, ...runTs() },
  { name: "sqlite.py", floor: PY_FLOOR, ...runPy() },
];

let failed = false;
for (const suite of suites) {
  const reasons = [];
  if (!suite.ok) reasons.push("suite failed");
  if (suite.executed < suite.floor) reasons.push(`executed ${suite.executed} < floor ${suite.floor}`);
  if (suite.skipped > 0) reasons.push(`skipped ${suite.skipped} > 0`);
  if (reasons.length > 0) failed = true;
  console.log(`${reasons.length === 0 ? "ok" : "red"} ${suite.name}: executed=${suite.executed} skipped=${suite.skipped}${
    reasons.length === 0 ? "" : ` (${reasons.join(", ")})`
  }`);
}
process.exit(failed ? 1 : 0);
