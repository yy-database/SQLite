// Shared helpers for the harness toolbox: repository root, child processes,
// elapsed time and table rendering. Every command prints human tables by
// default and the same data as JSON when `--json` is passed.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

// The binding lives in `projects/sqlite.ts/platforms/<pkg>/lib` and is created by
// `scripts/build-napi.mjs`. Resolve it through the platform package entry so a
// missing build fails with a platform message instead of a bare `MODULE_NOT_FOUND`.
export function nativeModulePath(): string {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  const libDir = join(dirname(require.resolve(`@yydb/sqlite-${key}`)), "lib");
  const fileName = existsSync(libDir)
    ? readdirSync(libDir).find((entry) => entry.endsWith(".node"))
    : undefined;
  if (!fileName) {
    throw new Error(`Missing .node binary in ${libDir}. Run pnpm build:napi from the repo root.`);
  }
  return join(libDir, fileName);
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

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function p95(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
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
