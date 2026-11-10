// Shared helpers for the harness toolbox: repository root, child processes,
// elapsed time and table rendering. Every command prints human tables by
// default and the same data as JSON when `--json` is passed.
//
// 原生接合（加载、线协议与结构化类型）只存在于 `native/binding.ts`，本文件
// 不再持有第二份 addon 接口或加载器。

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const REPO_ROOT = join(HARNESS_ROOT, "..", "..", "..", "..");

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
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
