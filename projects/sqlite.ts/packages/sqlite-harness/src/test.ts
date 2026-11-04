// `test` subcommand: build the native module once, run every acceptance
// suite, and report the three coverage metrics separately:
//
//   external   cross-engine conformance. Judged by `better-sqlite3`,
//              `node:sqlite`, `sql.js` and the CPython `sqlite3` module, so it
//              is reported but never counted as repository coverage.
//   storage    this repository's writer / reader / snapshot primitives, the
//              platform packages and the installed wheel.
//   sql        SQL text executed by this repository's own engine. This layer
//              starts at zero and only grows when a suite actually executes a
//              statement through the `execute` / `executeBatch` primitives.
//
// A suite is red when it fails, when it skips a case, or when it executes fewer
// cases than its floor. No file is left unclassified: every test file lands in
// exactly one layer.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emit, execFile, nativeModulePath, repoPath, type CliOptions } from "./util.ts";
import { platformStages } from "../stages/stages.mjs";

type LayerName = "external" | "storage" | "sql";

const TS_EXTERNAL_FILES = ["sql-semantics.test.ts"];
const TS_SQL_FILES = ["sql-engine.test.ts"];
const PY_EXTERNAL_MODULES = ["test_sql_semantics"];
const PY_SQL_MODULES = ["test_sql_engine"];

const FLOORS: Record<LayerName, { ts: number; py: number }> = {
  external: {
    ts: Number(process.env.TS_EXTERNAL_FLOOR ?? 283),
    py: Number(process.env.PY_EXTERNAL_FLOOR ?? 265),
  },
  storage: {
    ts: Number(process.env.TS_STORAGE_FLOOR ?? 62),
    py: Number(process.env.PY_STORAGE_FLOOR ?? 35),
  },
  sql: {
    ts: Number(process.env.TS_SQL_FLOOR ?? 0),
    py: Number(process.env.PY_SQL_FLOOR ?? 0),
  },
};

const EXTERNAL_CALLS = ["better-sqlite3", "integrity_check", "sqlite3.connect"];

interface Suite {
  readonly name: string;
  readonly layer: LayerName;
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly floor: number;
  readonly elapsedMs: number;
  readonly ok: boolean;
  readonly detail: string;
}

function tail(output: string, lines = 40): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

function nativePath(): string {
  return nativeModulePath();
}

function build(): { ok: boolean; output: string } {
  const result = execFile(process.execPath, [repoPath("scripts", "build-napi.mjs")], repoPath());
  return { ok: result.status === 0, output: (result.stdout + result.stderr).trim() };
}

function tsFiles(): { external: string[]; storage: string[]; sql: string[] } {
  const directory = repoPath("projects", "sqlite.ts", "packages", "sqlite", "tests");
  let names: string[] = [];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".test.ts")).sort();
  } catch {
    names = [];
  }
  return {
    external: names.filter((name) => TS_EXTERNAL_FILES.includes(name)).map((name) => `tests/${name}`),
    sql: names.filter((name) => TS_SQL_FILES.includes(name)).map((name) => `tests/${name}`),
    // The emulator CLI suite exercises the packaged workspace entry, so it
    // belongs to the storage layer with the rest of the primitives.
    storage: [
      ...names
        .filter((name) => !TS_EXTERNAL_FILES.includes(name) && !TS_SQL_FILES.includes(name))
        .map((name) => `tests/${name}`),
      "../../emulators/sqlite/tests/cli.test.ts",
    ],
  };
}

function runTsLayer(layer: LayerName, files: string[]): Suite {
  const name = `sqlite.ts/${layer}`;
  const floor = FLOORS[layer].ts;
  if (files.length === 0) {
    return { name, layer, cases: 0, passed: 0, failed: 0, skipped: 0, floor, elapsedMs: 0, ok: floor === 0, detail: "" };
  }
  const result = execFile(
    process.execPath,
    ["--test-reporter=tap", "--experimental-strip-types", "--test", ...files],
    repoPath("projects", "sqlite.ts", "packages", "sqlite"),
    { SQLITE_NATIVE: nativePath() },
  );
  const output = result.stdout;
  const cases = Number((output.match(/^# tests (\d+)$/m) ?? [])[1] ?? 0);
  const pass = Number((output.match(/^# pass (\d+)$/m) ?? [])[1] ?? 0);
  const fail = Number((output.match(/^# fail (\d+)$/m) ?? [])[1] ?? 0);
  const skip = Number((output.match(/^# skipped (\d+)$/m) ?? [])[1] ?? 0);
  return {
    name,
    layer,
    cases,
    passed: pass,
    failed: fail,
    skipped: skip,
    floor,
    elapsedMs: Math.round(result.elapsedMs),
    ok: fail === 0 && skip === 0 && cases >= floor,
    detail: tail(output),
  };
}

// The Python suite lives inside the packaging project so the wheel metadata and
// its acceptance cases stay in one package directory.
function pyModules(): { external: string[]; storage: string[]; sql: string[] } {
  const directory = repoPath("projects", "sqlite.py", "packages", "sqlite", "tests");
  let names: string[] = [];
  try {
    names = readdirSync(directory)
      .filter((name) => name.startsWith("test_") && name.endsWith(".py"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    names = [];
  }
  return {
    external: names.filter((name) => PY_EXTERNAL_MODULES.includes(name)),
    sql: names.filter((name) => PY_SQL_MODULES.includes(name)),
    storage: names.filter((name) => !PY_EXTERNAL_MODULES.includes(name) && !PY_SQL_MODULES.includes(name)),
  };
}

function runPyLayer(layer: LayerName, modules: string[]): Suite {
  const name = `sqlite.py/${layer}`;
  const floor = FLOORS[layer].py;
  const directory = repoPath("projects", "sqlite.py", "packages", "sqlite", "tests");
  const interpreter = process.platform === "win32" ? "python" : "python3";
  let cases = 0;
  let skipped = 0;
  let failures = 0;
  let errors = 0;
  let elapsed = 0;
  const details: string[] = [];
  for (const module of modules) {
    const result = execFile(interpreter, ["-m", "unittest", "-v", module], directory);
    elapsed += result.elapsedMs;
    details.push(result.stderr + result.stdout);
    const output = details[details.length - 1];
    cases += Number((output.match(/Ran (\d+) tests?/g) ?? []).reduce((total, line) => {
      return total + Number(line.replace(/Ran (\d+) tests?/, "$1"));
    }, 0));
    skipped += Number((output.match(/skipped=(\d+)/g) ?? []).reduce((total, line) => {
      return total + Number(line.replace("skipped=", ""));
    }, 0));
    failures += Number((output.match(/failures=(\d+)/g) ?? []).reduce((total, line) => {
      return total + Number(line.replace("failures=", ""));
    }, 0));
    errors += Number((output.match(/errors=(\d+)/g) ?? []).reduce((total, line) => {
      return total + Number(line.replace("errors=", ""));
    }, 0));
  }
  const failed = failures + errors;
  return {
    name,
    layer,
    cases,
    passed: cases - skipped - failures - errors,
    failed,
    skipped,
    floor,
    elapsedMs: Math.round(elapsed),
    ok: failed === 0 && skipped === 0 && cases >= floor,
    detail: tail(details.join("\n")),
  };
}

function sources(directory: string): string {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".ts") || name.endsWith(".py"))
      .map((name) => readFileSync(join(directory, name), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

function externalCheck(): { ok: boolean; missing: string[]; used: string[] } {
  const text = [
    sources(repoPath("projects", "sqlite.ts", "packages", "sqlite", "tests")),
    sources(repoPath("projects", "sqlite.py", "packages", "sqlite", "tests")),
  ].join("\n");
  const used = EXTERNAL_CALLS.filter((name) => text.includes(name));
  const missing = EXTERNAL_CALLS.filter((name) => !text.includes(name));
  // Two independent external implementations are the minimum for a
  // self-checked assertion, so two of the three is enough to pass.
  return { ok: used.length >= 2, missing, used };
}

interface PlatformStageResult {
  readonly name: string;
  readonly assertions: number;
  readonly rows: number;
  readonly layers: { storage: number; sql: number };
  readonly elapsed: number;
  readonly ok: boolean;
  readonly reasons: string[];
  readonly assertionsFloor: number;
}

export function commandTest(options: CliOptions): number {
  const built = build();
  if (!built.ok) {
    process.stderr.write(`build failed\n${built.output}\n`);
    return 1;
  }
  const ts = tsFiles();
  const py = pyModules();
  const suites: Suite[] = [
    runTsLayer("external", ts.external),
    runTsLayer("storage", ts.storage),
    runTsLayer("sql", ts.sql),
    runPyLayer("external", py.external),
    runPyLayer("storage", py.storage),
    runPyLayer("sql", py.sql),
  ];
  // A red suite has to say why. Without the child output the gate only reports
  // counts, which turns every platform-specific breakage into a blind search.
  for (const suite of suites) {
    if (!suite.ok) process.stderr.write(`\n${suite.name} output\n${suite.detail}\n`);
  }
  const external = externalCheck();
  const platforms: PlatformStageResult[] = platformStages
    .filter((stage: { commands: string[] }) => stage.commands.includes("test"))
    .map((stage: { assertionsFloor: number; run: () => Omit<PlatformStageResult, "assertionsFloor"> }) => ({
      ...stage.run(),
      assertionsFloor: stage.assertionsFloor,
    }));

  const cases = (layer: LayerName): number =>
    suites.filter((suite) => suite.layer === layer).reduce((total, suite) => total + suite.cases, 0);
  const stageAssertions = (layer: "storage" | "sql"): number =>
    platforms.reduce((total, stage) => total + stage.layers[layer], 0);
  const coverage = {
    // External engines agree with each other here. Useful signal, but it says
    // nothing about this repository, so it is never added to the two layers
    // below.
    externalConformance: cases("external"),
    storagePrimitives: cases("storage") + stageAssertions("storage"),
    sqlExecution: cases("sql") + stageAssertions("sql"),
  };

  const ok =
    suites.every((suite) => suite.ok) && external.ok && platforms.every((stage) => stage.ok);

  const payload = { command: "test", ok, native: nativePath(), external, coverage, suites, platforms };
  const text = () => {
    const rows = suites.map((suite) => [
      suite.name,
      suite.layer,
      suite.cases,
      suite.passed,
      suite.failed,
      suite.skipped,
      `>= ${suite.floor}`,
      `${suite.elapsedMs}ms`,
      suite.ok ? "ok" : "FAIL",
    ]);
    const stageRows = platforms.map((stage) => [
      stage.name,
      stage.layers.storage,
      stage.layers.sql,
      stage.assertions,
      stage.rows,
      `>= ${stage.assertionsFloor}`,
      `${stage.elapsed}ms`,
      stage.ok ? "ok" : `FAIL (${stage.reasons.join(", ")})`,
    ]);
    const table = [
      "| suite | layer | cases | passed | failed | skipped | floor | elapsed | status |",
      "| ----- | ----- | ----- | ------ | ------ | ------- | ----- | ------- | ------ |",
      ...rows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
    const stages = [
      "| stage | storage assertions | sql assertions | assertions | rows (data volume) | floor | elapsed | status |",
      "| ----- | ------------------ | -------------- | ---------- | ------------------- | ----- | ------- | ------ |",
      ...stageRows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
    const externalLine = external.ok
      ? `external engines referenced: ${external.used.join(", ")}`
      : `external engines missing from suite sources: ${external.missing.join(", ")}`;
    const coverageLines = [
      `coverage: external-conformance ${coverage.externalConformance} cases (external engines, not repository coverage)`,
      `coverage: storage-primitives ${coverage.storagePrimitives} (cases plus platform assertions)`,
      `coverage: sql-execution ${coverage.sqlExecution} (cases plus platform assertions)`,
    ].join("\n");
    return `${table}\n${stages}\n${coverageLines}\n${externalLine}\nnative module: ${nativePath()}`;
  };
  emit(options, payload as unknown as Record<string, unknown>, text);
  return ok ? 0 : 1;
}
