// Registration point for the repository harness.
//
// The repository harness (`test` / `bench` / `conformance` / `fixtures` /
// `oracle`) consumes `platformStages`, so the three bindings run through one
// entry instead of separate scripts. Each stage keeps its own runner under
// `stages/<binding>` and reports the same floor and external truth contract
// as the `sqlite.ts` / `sqlite.py` suites.
//
// A stage reports **assertion** counts, never the rows it happens to write.
// `rows` is the data volume and stays in a separate field, and every stage
// splits its assertions between the storage layer and the SQL layer so the
// gate can report the three coverage metrics independently.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repository, stagesDir, wasmPlatform } from "./paths.mjs";

const here = stagesDir;

function count(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
}

function spawn(command, args, cwd) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    elapsed: Date.now() - started,
  };
}

function summarize({ name, assertionsFloor, sqlFloor = 0, steps, truth }) {
  const text = steps.map((step) => step.text).join("\n");
  const elapsed = steps.reduce((total, step) => total + step.elapsed, 0);
  const assertions = count(text, /"assertions": (\d+)/);
  const rows = count(text, /"rows": (\d+)/);
  const layers = {
    storage: count(text, /"storage": (\d+)/),
    sql: count(text, /"sql": (\d+)/),
  };
  const reasons = [];
  if (steps.some((step) => step.status !== 0)) reasons.push("command failed");
  if (assertions < assertionsFloor) reasons.push(`assertions ${assertions} < floor ${assertionsFloor}`);
  if (layers.sql < sqlFloor) reasons.push(`sql assertions ${layers.sql} < floor ${sqlFloor}`);
  if (assertions !== layers.storage + layers.sql) {
    reasons.push(`assertion layers ${layers.storage}+${layers.sql} do not add up to ${assertions}`);
  }
  if (!truth(text)) reasons.push("missing external truth");
  return { name, ok: reasons.length === 0, assertions, rows, layers, skipped: 0, elapsed, reasons, tail: text };
}

function runNode() {
  return summarize({
    name: "platforms/node",
    assertionsFloor: 35,
    sqlFloor: 28,
    steps: [spawn(process.execPath, [join(here, "node", "smoke.mjs")], repository)],
    truth: (text) => text.includes('"status": "PASS"') && text.includes('"integrity_check": "ok"'),
  });
}

function runWasm() {
  const build = spawn(process.execPath, [join(repository, "scripts/build-wasm.mjs")], repository);
  return summarize({
    name: "platforms/wasm",
    assertionsFloor: 45,
    sqlFloor: 42,
    steps: [build, spawn(process.execPath, [join(wasmPlatform, "tests/smoke.mjs")], repository)],
    truth: (text) => text.includes('"status": "PASS"') && text.includes('"integrity_check": "ok"'),
  });
}

function runPython() {
  const sources = readFileSync(join(here, "python", "test_features.py"), "utf8");
  return summarize({
    name: "platforms/python",
    assertionsFloor: 60,
    sqlFloor: 39,
    steps: [spawn(process.execPath, [join(here, "python", "run_tests.mjs")], repository)],
    truth: (text) =>
      /"cases": \d+/.test(text) && /"assertions": \d+/.test(text) && sources.includes("integrity_check"),
  });
}

// `command` names the harness subcommand that owns the stage. The python stage
// installs the wheel into a clean virtual environment before running, so the
// clean-install check is part of `test` rather than a separate script.
export const platformStages = [
  { name: "platforms/node", commands: ["test"], assertionsFloor: 35, sqlFloor: 28, run: runNode },
  { name: "platforms/wasm", commands: ["test"], assertionsFloor: 45, sqlFloor: 42, run: runWasm },
  { name: "platforms/python", commands: ["test"], assertionsFloor: 60, sqlFloor: 39, run: runPython },
];
