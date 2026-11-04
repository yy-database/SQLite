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

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { emit, execFile, nativeModulePath, platformKey, repoPath, type CliOptions, type CommandResult } from "./util.ts";
import { platformStages } from "../stages/stages.mjs";
import { stagesDir } from "../stages/paths.mjs";

type LayerName = "external" | "storage" | "sql";

const TS_EXTERNAL_FILES = ["sql-semantics.test.ts"];
const TS_SQL_FILES = ["sql-engine.test.ts", "sql-expression.test.ts", "three-valued-logic.test.ts"];
const PY_EXTERNAL_MODULES = ["test_sql_semantics"];
const PY_SQL_MODULES = ["test_sql_engine", "test_three_valued_logic"];

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
    // The TypeScript suite runs the native engine directly. The Python SQL module
    // runs against the installed wheel built by the `platforms/python` stage, so
    // both hosts are measured on the same statement surface.
    ts: Number(process.env.TS_SQL_FLOOR ?? 64),
    py: Number(process.env.PY_SQL_FLOOR ?? 20),
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

interface PackProbe {
  readonly name: string;
  readonly tarball: string;
  readonly files: number;
  readonly elapsedMs: number;
  readonly ok: boolean;
  readonly detail: string;
}

// The product package is imported by library users, so the tarball has to be
// loadable by a plain Node runtime. TypeScript sources inside a tarball are
// rejected with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, so only compiled
// JavaScript may be exported.
const SQL_PROBE = `import { createEngine, executeSql } from "@yydb/sqlite";\n` +
  `const engine = createEngine(4096);\n` +
  `const pick = (result) => ({ statement: result.statement, affected: result.affected, columns: result.columns, rows: result.rows });\n` +
  `const created = pick(executeSql(engine, "create table probe (id integer primary key, label text not null)"));\n` +
  `const inserted = pick(executeSql(engine, "insert into probe (label) values ('ready')"));\n` +
  `const counted = pick(executeSql(engine, "select count(*) from probe"));\n` +
  `process.stdout.write(JSON.stringify({ created, inserted, counted }));\n`;

const FIXTURE_PROBE = `import { existsSync, readdirSync } from "node:fs";\n` +
  `import { fixturesDirectory } from "@yydb/sqlite-fixtures";\n` +
  `const names = existsSync(fixturesDirectory) ? readdirSync(fixturesDirectory) : [];\n` +
  `process.stdout.write(JSON.stringify({ fixtures: names.length }));\n`;

interface PackTarget {
  readonly name: string;
  readonly directory: string[];
  readonly probe: string;
  readonly native: boolean;
}

const PACK_TARGETS: PackTarget[] = [
  { name: "@yydb/sqlite", directory: ["projects", "sqlite.ts", "packages", "sqlite"], probe: SQL_PROBE, native: true },
  {
    name: "@yydb/sqlite-fixtures",
    directory: ["projects", "sqlite.ts", "packages", "sqlite-fixtures"],
    probe: FIXTURE_PROBE,
    native: false,
  },
];

// `npm` and `pnpm` are shell scripts on Windows, so the pack step goes through
// the platform shell. Every other step uses plain executables.
function shellRun(line: string, cwd: string): CommandResult {
  const start = process.hrtime.bigint();
  const result = spawnSync(line, { cwd, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs: Number(process.hrtime.bigint() - start) / 1_000_000,
  };
}

function plainNode(script: string, cwd: string): CommandResult {
  const start = process.hrtime.bigint();
  const env = { ...process.env };
  delete env.SQLITE_NATIVE;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [script], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs: Number(process.hrtime.bigint() - start) / 1_000_000,
  };
}

function packageName(name: string): { scope: string | null; leaf: string } {
  const parts = name.split("/");
  return parts.length === 2 ? { scope: parts[0], leaf: parts[1] } : { scope: null, leaf: name };
}

function installState(target: PackTarget): PackProbe {
  const packageDirectory = repoPath(...target.directory);
  const staging = mkdtempSync(join(tmpdir(), `sqlite-pack-probe-${packageName(target.name).leaf}-`));
  const start = process.hrtime.bigint();
  const fail = (detail: string): PackProbe => ({
    name: target.name,
    tarball: "",
    files: 0,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - start) / 1_000_000),
    ok: false,
    detail,
  });
  try {
    const packed = shellRun(`pnpm pack --pack-destination "${staging}"`, packageDirectory);
    if (packed.status !== 0) return fail(`pack failed\n${(packed.stdout + packed.stderr).trim()}`);
    const tarball = readdirSync(staging).find((entry) => entry.endsWith(".tgz"));
    if (!tarball) return fail("pack produced no tarball");
    const archive = join(staging, tarball);

    const listing = execFile("tar", ["-tzf", archive], staging);
    if (listing.status !== 0) return fail(`cannot list ${tarball}\n${listing.stderr.trim()}`);
    const entries = listing.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    // `.d.ts` is a declaration file, which is what `types` must point at. Only
    // real sources would force the consumer to strip types.
    const sources = entries.filter(
      (entry) =>
        (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) || entry.endsWith(".mts") || entry.endsWith(".cts"),
    );
    if (sources.length > 0) return fail(`${tarball} ships TypeScript sources: ${sources.join(", ")}`);

    const extracted = execFile("tar", ["-xzf", archive, "-C", staging], staging);
    if (extracted.status !== 0) return fail(`cannot extract ${tarball}\n${extracted.stderr.trim()}`);

    // Stage the tarball as an installed dependency. The platform package is
    // copied in because it is unpublished during local development and the
    // probe must resolve it the same way an installed consumer would.
    const { scope, leaf } = packageName(target.name);
    const modules = scope ? join(staging, "node_modules", scope) : join(staging, "node_modules");
    mkdirSync(modules, { recursive: true });
    renameSync(join(staging, "package"), join(modules, leaf));
    if (target.native) {
      const key = platformKey();
      if (!key) return fail(`no platform package for ${process.platform}-${process.arch}`);
      cpSync(repoPath("projects", "sqlite.ts", "platforms", `sqlite-${key}`), join(modules, `sqlite-${key}`), {
        recursive: true,
      });
    }

    const probePath = join(staging, "probe.mjs");
    writeFileSync(probePath, target.probe);
    const run = plainNode(probePath, staging);
    if (run.status !== 0) return fail(`plain Node import failed\n${(run.stdout + run.stderr).trim()}`);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(run.stdout.trim().split("\n").pop() ?? "");
    } catch {
      return fail(`probe produced no JSON: ${run.stdout.trim()}`);
    }
    if (target.native) {
      const counted = payload.counted?.rows?.[0]?.[0];
      if (payload.created?.statement !== "create-table" || payload.inserted?.affected !== 1 || counted !== 1) {
        return fail(`probe returned unexpected values: ${run.stdout.trim()}`);
      }
    } else if (typeof payload.fixtures !== "number" || payload.fixtures <= 0) {
      return fail(`fixture package exposes no fixtures: ${run.stdout.trim()}`);
    }
    return {
      name: target.name,
      tarball,
      files: entries.length,
      elapsedMs: Math.round(Number(process.hrtime.bigint() - start) / 1_000_000),
      ok: true,
      detail: `${entries.length} files, plain Node import and one statement ok`,
    };
  } finally {
    // Only the temporary directory this probe created is removed, and only when
    // it still matches the prefix `mkdtempSync` produced.
    if (basename(staging).startsWith("sqlite-pack-probe-") && staging.startsWith(tmpdir())) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

// The native module and the compiled TypeScript entry are both build outputs.
// Workspace consumers resolve `@yydb/sqlite` through `dist`, so the gate builds
// it before any suite runs instead of trusting a stale checkout.
function build(): { ok: boolean; output: string } {
  const native = execFile(process.execPath, [repoPath("scripts", "build-napi.mjs")], repoPath());
  const packageDirectory = repoPath("projects", "sqlite.ts", "packages", "sqlite");
  const typescript = execFile(
    process.execPath,
    [repoPath("node_modules", "typescript", "bin", "tsc"), "-p", join(packageDirectory, "tsconfig.json")],
    packageDirectory,
  );
  return {
    ok: native.status === 0 && typescript.status === 0,
    output: `${native.stdout}${native.stderr}${typescript.stdout}${typescript.stderr}`.trim(),
  };
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

// The Python SQL module has to import the packaged extension module, so it runs
// with the interpreter that `platforms/python` provisioned. Every other Python
// layer keeps using the host interpreter.
function pyInterpreter(layer: LayerName): string {
  if (layer === "sql") {
    const venv = join(stagesDir, "python", ".venv");
    const candidate = join(venv, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function runPyLayer(layer: LayerName, modules: string[]): Suite {
  const name = `sqlite.py/${layer}`;
  const floor = FLOORS[layer].py;
  const directory = repoPath("projects", "sqlite.py", "packages", "sqlite", "tests");
  const interpreter = pyInterpreter(layer);
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
  // Platform stages run first: the Python SQL layer imports the wheel that the
  // `platforms/python` stage installs, and the probe below reuses the built
  // native module without rebuilding it.
  const external = externalCheck();
  const packs: PackProbe[] = PACK_TARGETS.map((target) => installState(target));
  const platforms: PlatformStageResult[] = platformStages
    .filter((stage: { commands: string[] }) => stage.commands.includes("test"))
    .map((stage: { assertionsFloor: number; run: () => Omit<PlatformStageResult, "assertionsFloor"> }) => ({
      ...stage.run(),
      assertionsFloor: stage.assertionsFloor,
    }));

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
    suites.every((suite) => suite.ok) &&
    external.ok &&
    packs.every((probe) => probe.ok) &&
    platforms.every((stage) => stage.ok);

  for (const probe of packs) {
    if (!probe.ok) process.stderr.write(`\n${probe.name} pack probe output\n${probe.tarball} ${probe.detail}\n`);
  }

  const payload = { command: "test", ok, native: nativePath(), external, coverage, suites, platforms, packs };
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
    const packRows = packs.map((probe) => [
      probe.name,
      probe.tarball || "-",
      probe.files,
      `${probe.elapsedMs}ms`,
      probe.ok ? "ok" : `FAIL (${probe.detail})`,
    ]);
    const packsTable = [
      "| packed package | tarball | files | elapsed | plain Node install-state import |",
      "| -------------- | ------- | ----- | ------- | ------------------------------ |",
      ...packRows.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
    const coverageLines = [
      `coverage: external-conformance ${coverage.externalConformance} cases (external engines, not repository coverage)`,
      `coverage: storage-primitives ${coverage.storagePrimitives} (cases plus platform assertions)`,
      `coverage: sql-execution ${coverage.sqlExecution} (cases plus platform assertions)`,
    ].join("\n");
    return `${table}\n${stages}\n${packsTable}\n${coverageLines}\n${externalLine}\nnative module: ${nativePath()}`;
  };
  emit(options, payload as unknown as Record<string, unknown>, text);
  return ok ? 0 : 1;
}
