// Shared helpers for the harness toolbox: repository root, child processes,
// elapsed time and table rendering. Every command prints human tables by
// default and the same data as JSON when `--json` is passed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

// ---- 标准 harness 能力：身份可校验的 dev-tools 产物 ----
//
// harness 判定（digest、compare/classify、baseline、bench、gate、fuzz、report）
// 全部由上游 `database.harness` 经 dev-tools 构建的 `.node` 提供。生产主入口不含
// 这些符号；这里只加载带 `dev-tools` feature 的开发产物，并校验其身份等于
// `Cargo.toml` 钉住的 database.rs rev，避免拿另一个 revision 的 `.node` 冒充已安装
// 产品的判定结果。能力缺失即抛错，不回退 JS 实现。

export interface BenchStats {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly rounds: number;
}

/** `database.harness` 经 SQLite dev-tools napi 暴露的标准判定面。 */
export interface HarnessAddon {
  harnessBuildIdentity(): string;
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

/** 从 `Cargo.toml` 读取钉住的 database.rs rev，作为 dev 产物身份基准。 */
export function pinnedDatabaseRev(): string {
  const text = readFileSync(repoPath("projects", "sqlite.rs", "Cargo.toml"), "utf8");
  const match = text.match(/^database\s*=\s*\{[^}]*rev\s*=\s*"([0-9a-f]{40})"/m);
  if (!match) {
    throw new Error("cannot read the pinned database.rs rev from projects/sqlite.rs/Cargo.toml");
  }
  return match[1];
}

let cachedDevHarness: HarnessAddon | null = null;

/** 加载并校验身份后的标准 harness 判定面。进程内复用同一加载结果。 */
export function devHarnessAddon(): HarnessAddon {
  if (cachedDevHarness) return cachedDevHarness;
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite dev-tools addon not available for ${process.platform}-${process.arch}`);
  }
  const devPath = repoPath("projects", "sqlite.ts", "platforms", `sqlite-${key}`, `sqlite.${key}.dev.node`);
  let loaded: HarnessAddon & { default?: HarnessAddon };
  try {
    loaded = require(devPath) as HarnessAddon & { default?: HarnessAddon };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite dev-tools addon not built for ${key}; run \`node scripts/build-napi.mjs --dev\`. ${message}`);
  }
  const addon = (loaded.default ?? loaded) as HarnessAddon;
  const identity = typeof addon.harnessBuildIdentity === "function" ? addon.harnessBuildIdentity() : "missing";
  const expected = `dev-tools@${pinnedDatabaseRev()}`;
  if (identity !== expected) {
    throw new Error(`SQLite dev-tools addon identity mismatch: got ${JSON.stringify(identity)}, expected ${JSON.stringify(expected)}; rebuild with \`node scripts/build-napi.mjs --dev\``);
  }
  cachedDevHarness = addon;
  return addon;
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
