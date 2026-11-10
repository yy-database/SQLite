// Shared helpers for the harness toolbox: repository root, child processes,
// elapsed time and table rendering. Every command prints human tables by
// default and the same data as JSON when `--json` is passed.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const HARNESS_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const REPO_ROOT = join(HARNESS_ROOT, "..", "..", "..", "..");

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

export type PlatformKey = "win32-x64" | "linux-x64" | "darwin-x64" | "darwin-arm64";

/** Map Node platform and arch to the optionalDependency package suffix. */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

// The binding is the platform package `main`, staged by `scripts/build-napi.mjs`.
// Resolve through the package entry so a missing build fails with a platform
// message instead of a bare `MODULE_NOT_FOUND`. Callers never concatenate the
// `.node` filename.
export function nativeModulePath(): string {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  return require.resolve(`@yydb/sqlite-${key}`);
}

// ---- 标准 harness 能力：与产品 SQL 入口并列的正式绑定面 ----
//
// harness 判定（digest、compare/classify、baseline、bench、gate、fuzz、report）由上游
// `database.harness` 维护，编译进与产品共用的同一个 `.node`。本包按模块取用 harness
// 导出，不为这个边界另造 addon，也不降为 dev-dependency。能力缺失即抛错，不回退 JS。

export interface BenchStats {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly rounds: number;
}

/** `database.harness` 经 SQLite N-API 暴露的标准判定面。 */
export interface HarnessAddon {
  harnessDigest(bytes: Uint8Array): string;
  harnessCheckBaseline(baselineJson: string, currentJson: string, observedJson: string): string;
  harnessRenderReport(reportJson: string): string;
  harnessCompare(expectedJson: string, actualJson: string, modeJson: string): string;
  harnessClassify(comparisonJson: string, knownJson: string): string;
  harnessEvaluateGate(inputJson: string): string;
  harnessBenchSummary(samplesMs: number[]): BenchStats;
  harnessBenchPerOp(stats: BenchStats, ops: number): number;
  harnessRenderBenchChart(rowsJson: string, metric: string, title: string): string;
  harnessFuzzGenerate(grammarJson: string, planJson: string): string;
  harnessFuzzRender(grammarJson: string, inputJson: string): string;
  harnessFuzzShrinkStart(grammarJson: string, inputJson: string): string;
  harnessFuzzShrinkNext(grammarJson: string, sessionJson: string): string;
  harnessFuzzShrinkReport(sessionJson: string, failing: boolean): string;
}

let cachedHarness: HarnessAddon | null = null;

/** 加载共用 `.node` 的 harness 切片。进程内复用同一加载结果。 */
export function harnessAddon(): HarnessAddon {
  if (cachedHarness) return cachedHarness;
  let loaded: HarnessAddon & { default?: HarnessAddon };
  try {
    loaded = require(nativeModulePath()) as HarnessAddon & { default?: HarnessAddon };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite harness addon not available; run \`node scripts/build-napi.mjs\`. ${message}`);
  }
  cachedHarness = (loaded.default ?? loaded) as HarnessAddon;
  return cachedHarness;
}

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

export function execFile(
  command: string,
  args: string[],
  cwd = REPO_ROOT,
  extraEnv: Record<string, string> = {},
): CommandResult {
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs: Number(process.hrtime.bigint() - start) / 1_000_000,
  };
}

export function renderTable(columns: string[], rows: Array<Array<string | number>>): string {
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => String(row[index] ?? "").length)),
  );
  const line = (cells: Array<string | number>) =>
    `| ${cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(columns), separator, ...rows.map(line)].join("\n");
}

export interface CliOptions {
  readonly json: boolean;
}

export function parseOptions(argv: string[]): CliOptions {
  const unknown = argv.filter((value) => value !== "--json");
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(" ")}`);
  return { json: argv.includes("--json") };
}

export function emit(options: CliOptions, payload: Record<string, unknown>, text: () => string): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text()}\n`);
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
  return value;
}
