// `test` subcommand: build the native module once, run both acceptance
// suites, and report executed / failed / skipped counts. A suite is red when
// it fails, when it skips a case, or when it executes fewer cases than its
// floor. The source scan keeps the suites honest about calling real external
// engines instead of judging themselves.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emit, execFile, nativeModulePath, repoPath, type CliOptions } from "./util.ts";
import { platformStages } from "../stages/stages.mjs";

const TS_FLOOR = Number(process.env.TS_TEST_FLOOR ?? 335);
const PY_FLOOR = Number(process.env.PY_TEST_FLOOR ?? 300);

const EXTERNAL_CALLS = ["better-sqlite3", "integrity_check", "sqlite3.connect"];

interface Suite {
  readonly name: string;
  readonly executed: number;
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

function runTs(): Suite {
  const result = execFile(
    process.execPath,
    [
      "--test-reporter=tap",
      "--experimental-strip-types",
      "--test",
      "tests/*.test.ts",
      "../../emulators/sqlite/tests/*.test.ts",
    ],
    repoPath("projects", "sqlite.ts", "packages", "sqlite"),
    { SQLITE_NATIVE: nativePath() },
  );
  const output = result.stdout;
  const tests = Number((output.match(/^# tests (\d+)$/m) ?? [])[1] ?? 0);
  const pass = Number((output.match(/^# pass (\d+)$/m) ?? [])[1] ?? 0);
  const fail = Number((output.match(/^# fail (\d+)$/m) ?? [])[1] ?? 0);
  const skip = Number((output.match(/^# skipped (\d+)$/m) ?? [])[1] ?? 0);
  return {
    name: "sqlite.ts",
    executed: tests,
    passed: pass,
    failed: fail,
    skipped: skip,
    floor: TS_FLOOR,
    elapsedMs: Math.round(result.elapsedMs),
    ok: fail === 0 && skip === 0 && tests >= TS_FLOOR,
    detail: tail(result.stdout),
  };
}

// The Python suite lives inside the packaging project so the wheel metadata and
// its acceptance cases stay in one package directory.
function pythonTests(): { cwd: string; relative: string } {
  const cwd = repoPath("projects", "sqlite.py", "packages", "sqlite");
  return { cwd, relative: "tests" };
}

function runPy(): Suite {
  const { cwd, relative } = pythonTests();
  const result = execFile(
    process.platform === "win32" ? "python" : "python3",
    ["-m", "unittest", "discover", "-v", "-s", relative, "-t", relative],
    cwd,
  );
  const output = result.stderr + result.stdout;
  const ran = Number((output.match(/Ran (\d+) tests?/g) ?? []).reduce((total, line) => {
    return total + Number(line.replace(/Ran (\d+) tests?/, "$1"));
  }, 0));
  const skipped = Number((output.match(/skipped=(\d+)/g) ?? []).reduce((total, line) => {
    return total + Number(line.replace("skipped=", ""));
  }, 0));
  const failures = Number((output.match(/failures=(\d+)/g) ?? []).reduce((total, line) => {
    return total + Number(line.replace("failures=", ""));
  }, 0));
  const errors = Number((output.match(/errors=(\d+)/g) ?? []).reduce((total, line) => {
    return total + Number(line.replace("errors=", ""));
  }, 0));
  const failed = result.status === 0 ? 0 : Math.max(failures + errors, 1);
  return {
    name: "sqlite.py",
    executed: ran,
    passed: ran - skipped - failures - errors,
    failed,
    skipped,
    floor: PY_FLOOR,
    elapsedMs: Math.round(result.elapsedMs),
    ok: result.status === 0 && skipped === 0 && ran >= PY_FLOOR,
    detail: tail(output),
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
  readonly executed: number;
  readonly skipped: number;
  readonly elapsed: number;
  readonly ok: boolean;
  readonly reasons: string[];
  readonly floor: number;
}

export function commandTest(options: CliOptions): number {
  const built = build();
  if (!built.ok) {
    process.stderr.write(`build failed\n${built.output}\n`);
    return 1;
  }
  const suites = [runTs(), runPy()];
  // A red suite has to say why. Without the child output the gate only reports
  // counts, which turns every platform-specific breakage into a blind search.
  for (const suite of suites) {
    if (!suite.ok) process.stderr.write(`\n${suite.name} output\n${suite.detail}\n`);
  }
  const external = externalCheck();
  const platforms: PlatformStageResult[] = platformStages
    .filter((stage: { commands: string[] }) => stage.commands.includes("test"))
    .map((stage: { floor: number; run: () => Omit<PlatformStageResult, "floor"> }) => ({
      ...stage.run(),
      floor: stage.floor,
    }));
  const ok =
    suites.every((suite) => suite.ok) && external.ok && platforms.every((stage) => stage.ok);

  const payload = { command: "test", ok, native: nativePath(), external, suites, platforms };
  const text = () => {
    const rows = suites.map((suite) => [
      suite.name,
      suite.executed,
      suite.passed,
      suite.failed,
      suite.skipped,
      `>= ${suite.floor}`,
      `${suite.elapsedMs}ms`,
      suite.ok ? "ok" : "FAIL",
    ]);
    const table = [
      "| suite | executed | passed | failed | skipped | floor | elapsed | status |",
      "| ----- | -------- | ------ | ------ | ------- | ----- | ------- | ------ |",
      ...rows.map((row) => `| ${row.join(" | ")} |`),
      ...platforms.map((stage) => [
        stage.name,
        stage.executed,
        "-",
        "-",
        stage.skipped,
        `>= ${stage.floor}`,
        `${stage.elapsed}ms`,
        stage.ok ? "ok" : `FAIL (${stage.reasons.join(", ")})`,
      ]).map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
    const externalLine = external.ok
      ? `external engines referenced: ${external.used.join(", ")}`
      : `external engines missing from suite sources: ${external.missing.join(", ")}`;
    return `${table}\n${externalLine}\nnative module: ${nativePath()}`;
  };
  emit(options, payload as unknown as Record<string, unknown>, text);
  return ok ? 0 : 1;
}
