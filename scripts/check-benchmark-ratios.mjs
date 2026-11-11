// 基准比值门禁：只读取已提交的 `reports/benchmark.md`，检查
// `@yydb/sqlite / node:sqlite` 的时间比值上限。
//
// 默认上限 100x；已知并有解释的偏差写在 `reports/benchmark-deltas.json` 的
// 台账里，逐项给出更宽的 `maxRatio` 与原因。脚本不做耗时测量，因此不会因
// 机器负载抖动；它检查的是报告是否越过约定边界。
//
// 独立命令：`pnpm bench:check`。不挂在 `pnpm test` 上。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPORT = join(root, "projects", "sqlite.ts", "examples", "vs-js-libraries", "reports", "benchmark.md");
const DEFAULT_LEDGER = join(root, "projects", "sqlite.ts", "examples", "vs-js-libraries", "reports", "benchmark-deltas.json");

function usage() {
  return [
    "usage: node scripts/check-benchmark-ratios.mjs [options]",
    "",
    "  --report <path>     benchmark markdown (default: reports/benchmark.md)",
    "  --ledger <path>     delta ledger JSON (default: reports/benchmark-deltas.json)",
    "  --max-ratio <n>     base limit for unlisted workloads (default: ledger defaultMaxRatio, else 100)",
    "  --help              print this message",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT, ledger: DEFAULT_LEDGER, maxRatio: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--report" || arg === "--ledger" || arg === "--max-ratio") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === "--report") options.report = resolve(value);
      else if (arg === "--ledger") options.ledger = resolve(value);
      else options.maxRatio = parsePositive(value, arg);
    } else if (arg.startsWith("--report=")) {
      options.report = resolve(arg.slice("--report=".length));
    } else if (arg.startsWith("--ledger=")) {
      options.ledger = resolve(arg.slice("--ledger=".length));
    } else if (arg.startsWith("--max-ratio=")) {
      options.maxRatio = parsePositive(arg.slice("--max-ratio=".length), "--max-ratio");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function parsePositive(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number, got ${JSON.stringify(value)}`);
  return parsed;
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseRatios(markdown) {
  const lines = markdown.split(/\r?\n/);
  let subjectIndex = -1;
  const ratios = new Map();

  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      if (subjectIndex >= 0) break;
      continue;
    }
    const cells = splitRow(line);
    if (cells.includes("Workload")) {
      subjectIndex = cells.findIndex((cell) => cell === "@yydb/sqlite");
      ratios.clear();
      continue;
    }
    if (subjectIndex < 0) continue;
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const workload = cells[0];
    const cell = cells[subjectIndex];
    if (!workload || !cell) continue;
    if (cell === "n/a" || cell === "-") continue;
    const matched = /^([0-9]+(?:\.[0-9]+)?)x$/.exec(cell.replaceAll("*", ""));
    if (!matched) throw new Error(`cannot read a ratio from the "${workload}" row: ${JSON.stringify(cell)}`);
    ratios.set(workload, Number(matched[1]));
  }
  return ratios;
}

function readLedger(path) {
  if (!existsSync(path)) throw new Error(`delta ledger not found: ${path}`);
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const defaultMaxRatio = parsePositive(payload.defaultMaxRatio ?? 100, "ledger.defaultMaxRatio");
  const deltas = payload.deltas ?? {};
  if (typeof deltas !== "object" || Array.isArray(deltas)) throw new Error("ledger.deltas must be an object");
  const normalized = new Map();
  for (const [workload, entry] of Object.entries(deltas)) {
    if (entry === null || typeof entry !== "object") throw new Error(`ledger delta for "${workload}" must be an object`);
    const maxRatio = parsePositive(entry.maxRatio, `ledger.deltas.${workload}.maxRatio`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`ledger.deltas.${workload}.reason must be a non-empty string`);
    }
    normalized.set(workload, { maxRatio, reason: entry.reason.trim() });
  }
  return { defaultMaxRatio, deltas: normalized };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let ratios;
  let ledger;
  try {
    if (!existsSync(options.report)) throw new Error(`benchmark report not found: ${options.report}`);
    ratios = parseRatios(readFileSync(options.report, "utf8"));
    ledger = readLedger(options.ledger);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  if (ratios.size === 0) {
    process.stderr.write("no @yydb/sqlite ratios found in the benchmark report\n");
    return 2;
  }

  const baseLimit = options.maxRatio ?? ledger.defaultMaxRatio;
  const violations = [];
  const rows = [];
  for (const [workload, ratio] of ratios) {
    const delta = ledger.deltas.get(workload);
    const limit = delta?.maxRatio ?? baseLimit;
    const ok = ratio <= limit;
    rows.push(
      `${ok ? "ok  " : "FAIL"} ${workload.padEnd(14)} ${ratio.toFixed(2).padStart(9)}x  limit ${limit}x${delta ? " (ledger)" : ""}`,
    );
    if (!ok) violations.push({ workload, ratio, limit });
  }

  for (const workload of ledger.deltas.keys()) {
    if (!ratios.has(workload)) violations.push({ workload, ratio: Number.NaN, limit: Number.NaN, missing: true });
  }

  process.stdout.write(`benchmark report: ${options.report}\nbase limit: ${baseLimit}x\n\n${rows.join("\n")}\n`);
  for (const [workload, delta] of ledger.deltas) {
    if (ratios.has(workload)) process.stdout.write(`\nledger ${workload}: ${delta.reason}\n`);
  }

  if (violations.length > 0) {
    process.stderr.write("\nratio gate failed:\n");
    for (const violation of violations) {
      if (violation.missing) {
        process.stderr.write(`- ledger entry "${violation.workload}" is not present in the report\n`);
      } else {
        process.stderr.write(`- ${violation.workload}: ${violation.ratio.toFixed(2)}x exceeds ${violation.limit}x\n`);
      }
    }
    return 1;
  }

  process.stdout.write(`\nratio gate passed: ${ratios.size} workloads\n`);
  return 0;
}

process.exitCode = main();
