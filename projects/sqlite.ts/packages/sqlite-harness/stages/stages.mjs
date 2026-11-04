// Registration point for the repository harness.
//
// The repository harness (`test` / `bench` / `conformance` / `fixtures` /
// `oracle`) consumes `platformStages`, so the three bindings run through one
// entry instead of separate scripts. Each stage keeps its own runner under
// `stages/<binding>` and reports the same floor and external truth contract
// as the `sqlite.ts` / `sqlite.py` suites.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repository, stagesDir } from "./paths.mjs";

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

function summarize({ name, floor, steps, executedPattern, skippedPattern, truth }) {
  const text = steps.map((step) => step.text).join("\n");
  const elapsed = steps.reduce((total, step) => total + step.elapsed, 0);
  const executed = count(text, executedPattern);
  const skipped = skippedPattern ? count(text, skippedPattern) : 0;
  const reasons = [];
  if (steps.some((step) => step.status !== 0)) reasons.push("command failed");
  if (executed < floor) reasons.push(`executed ${executed} < floor ${floor}`);
  if (skipped > 0) reasons.push(`skipped ${skipped} > 0`);
  if (!truth(text)) reasons.push("missing external truth");
  return { name, ok: reasons.length === 0, executed, skipped, elapsed, reasons, tail: text };
}

function runNode() {
  return summarize({
    name: "platforms/node",
    floor: 1000,
    steps: [spawn(process.execPath, [join(here, "node", "smoke.mjs")], repository)],
    executedPattern: /"count": (\d+)/,
    truth: (text) => text.includes('"status": "PASS"') && text.includes('"integrity_check": "ok"'),
  });
}

function runWasm() {
  const build = spawn(process.execPath, [join(here, "wasm", "build.mjs")], repository);
  return summarize({
    name: "platforms/wasm",
    floor: 1000,
    steps: [build, spawn(process.execPath, [join(here, "wasm", "smoke.mjs")], repository)],
    executedPattern: /"count": (\d+)/,
    truth: (text) => text.includes('"status": "PASS"') && text.includes('"integrity_check": "ok"'),
  });
}

function runPython() {
  const sources = readFileSync(join(here, "python", "test_features.py"), "utf8");
  return summarize({
    name: "platforms/python",
    floor: 5,
    steps: [spawn(process.execPath, [join(here, "python", "run_tests.mjs")], repository)],
    executedPattern: /Ran (\d+) tests?/,
    skippedPattern: /skipped=(\d+)/,
    truth: (text) => /\nOK\b/.test(text) && sources.includes("integrity_check"),
  });
}

// `command` names the harness subcommand that owns the stage. The python stage
// installs the wheel into a clean virtual environment before running, so the
// clean-install check is part of `test` rather than a separate script.
export const platformStages = [
  { name: "platforms/node", commands: ["test"], floor: 1000, run: runNode },
  { name: "platforms/wasm", commands: ["test"], floor: 1000, run: runWasm },
  { name: "platforms/python", commands: ["test"], floor: 5, run: runPython },
];
