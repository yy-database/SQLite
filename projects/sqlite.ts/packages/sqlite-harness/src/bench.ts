// `bench` subcommand: the same workload on our writer/reader and on
// `better-sqlite3`, reported as median and p95 for both sides. Only workloads
// where both sides do the same work are emitted: our reader has no point or
// range API, so `BENCH_POINT` and `BENCH_RANGE` are accepted but produce no
// comparison row instead of a misleading side-by-side.

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriter, openDatabase } from "../../sqlite/src/index.ts";
import { emit, envInt, harnessAddon, repoPath, renderTable, type BenchStats, type CliOptions } from "./util.ts";

// median/p95 与分组柱图走上游 `database.harness` 的标准判定面（与产品共用 `.node`，
// nearest-rank 公式已在 Rust 侧 golden vector 钉死），写到本包的 `reports/`（git 忽略）。
const benchAddon = harnessAddon();

const require = createRequire(repoPath("projects", "sqlite.ts", "packages", "sqlite", "package.json"));
const BetterSqlite = require("better-sqlite3") as new (
  path: string,
  options?: Record<string, unknown>,
) => {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

const ROWS = envInt("BENCH_ROWS", 20_000);
const ROWS_PER_TXN = envInt("BENCH_TXN", 1_000);
const PAGE_SIZE = envInt("BENCH_PAGE", 4_096);
const ROUNDS = envInt("BENCH_ROUNDS", 3);
const POINT_OPS = envInt("BENCH_POINT", 10_000);
const RANGE_OPS = envInt("BENCH_RANGE", 1_000);
const SINGLE_INSERTS = 200;
const PAYLOAD = Buffer.alloc(48, 0x78);

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
  { name: "payload", declaredType: "BLOB" },
]);

function slots(row: number): string {
  return JSON.stringify([row, `row-${row}`, row / 4, { $blob: PAYLOAD.toString("hex") }]);
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-harness-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows keeps handles briefly; the temp directory is disposable.
      }
    },
  };
}

function ourBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const start = process.hrtime.bigint();
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) writer.begin();
    writer.insert("items", slots(row));
    if (row % ROWS_PER_TXN === 0) writer.commit();
  }
  writer.save(path);
  return elapsedMs(start);
}

function oracleBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const database = new BetterSqlite(path);
  database.pragma(`page_size = ${PAGE_SIZE}`);
  database.pragma("synchronous = off");
  database.pragma("journal_mode = memory");
  database.exec("create table items (id integer primary key, label text, score real, payload blob)");
  const insert = database.prepare("insert into items (id, label, score, payload) values (?, ?, ?, ?)");
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.exec("begin");
    insert.run(row, `row-${row}`, row / 4, PAYLOAD);
    if (row % ROWS_PER_TXN === 0) database.exec("commit");
  }
  const totalMs = elapsedMs(start);
  database.close();
  return totalMs;
}

function ourSingleInsert(path: string): number[] {
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  const samples: number[] = [];
  for (let row = 1; row <= SINGLE_INSERTS; row += 1) {
    const start = process.hrtime.bigint();
    writer.insert("items", slots(row));
    samples.push(elapsedMs(start) * 1_000);
  }
  writer.save(path);
  return samples;
}

function oracleSingleInsert(path: string): number[] {
  const database = new BetterSqlite(path);
  database.pragma("synchronous = off");
  database.pragma("journal_mode = memory");
  database.exec("create table items (id integer primary key, label text, score real, payload blob)");
  const insert = database.prepare("insert into items (id, label, score, payload) values (?, ?, ?, ?)");
  const samples: number[] = [];
  for (let row = 1; row <= SINGLE_INSERTS; row += 1) {
    const start = process.hrtime.bigint();
    insert.run(row, `row-${row}`, row / 4, PAYLOAD);
    samples.push(elapsedMs(start) * 1_000);
  }
  database.close();
  return samples;
}

function ourScan(path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const reader = openDatabase(path);
    const rows = reader.table("items", { maxRows: ROWS });
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  return samples;
}

function oracleScan(path: string): number[] {
  const database = new BetterSqlite(path);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const rows = database.prepare("select id, label, score, payload from items").all();
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

interface Pair {
  readonly workload: string;
  readonly unit: string;
  readonly ours: number[];
  readonly oracle: number[];
}

export function commandBench(options: CliOptions): number {
  const ourSpace = workspace("ours");
  const oracleSpace = workspace("oracle");
  const insertSpace = workspace("insert-ours");
  const insertOracleSpace = workspace("insert-oracle");
  const pairs: Pair[] = [];
  const files: Record<string, number> = {};
  try {
    pairs.push({
      workload: `batch load ${ROWS} (${PAGE_SIZE} page, ${ROWS_PER_TXN}/txn, single save)`,
      unit: "ms",
      ours: [ourBatchLoad(ourSpace.path), ourBatchLoad(ourSpace.path), ourBatchLoad(ourSpace.path)],
      oracle: [
        oracleBatchLoad(oracleSpace.path),
        oracleBatchLoad(oracleSpace.path),
        oracleBatchLoad(oracleSpace.path),
      ],
    });
    pairs.push({
      workload: `single insert ${SINGLE_INSERTS} (one statement each)`,
      unit: "us",
      ours: ourSingleInsert(insertSpace.path),
      oracle: oracleSingleInsert(insertOracleSpace.path),
    });
    pairs.push({
      workload: `full scan ${ROWS} (open + decode all rows / select all)`,
      unit: "ms",
      ours: ourScan(ourSpace.path),
      oracle: oracleScan(oracleSpace.path),
    });
    files.ours = statSync(ourSpace.path).size;
    files["better-sqlite3"] = statSync(oracleSpace.path).size;
  } finally {
    ourSpace.dispose();
    oracleSpace.dispose();
    insertSpace.dispose();
    insertOracleSpace.dispose();
  }

  const ok = pairs.every((pair) => pair.ours.length > 0 && pair.oracle.length > 0);
  const summaryOf = (samples: number[]): BenchStats => benchAddon.harnessBenchSummary(samples);
  const workloads = pairs.map((pair) => ({
    workload: pair.workload,
    unit: pair.unit,
    ours: summaryOf(pair.ours),
    oracle: summaryOf(pair.oracle),
  }));
  const payload = {
    command: "bench",
    ok,
    parameters: {
      rows: ROWS,
      txn: ROWS_PER_TXN,
      page: PAGE_SIZE,
      rounds: ROUNDS,
      point: POINT_OPS,
      range: RANGE_OPS,
    },
    files,
    workloads: workloads.map((entry) => ({
      workload: entry.workload,
      unit: entry.unit,
      ours: { median: entry.ours.medianMs, p95: entry.ours.p95Ms, samples: entry.ours.rounds },
      betterSqlite3: { median: entry.oracle.medianMs, p95: entry.oracle.p95Ms, samples: entry.oracle.rounds },
    })),
  };

  // 分组柱图：x=workload，颜色=引擎，median 与 p95 各一张，写进本包
  // `reports/`。`rows_json` 用核心 `BenchRow` 的 serde 形态（snake_case 键）。
  const benchRows = workloads.map((entry) => ({
    workload: entry.workload,
    unit: entry.unit,
    ours: { median_ms: entry.ours.medianMs, p95_ms: entry.ours.p95Ms, min_ms: entry.ours.minMs, max_ms: entry.ours.maxMs, rounds: entry.ours.rounds },
    reference: { median_ms: entry.oracle.medianMs, p95_ms: entry.oracle.p95Ms, min_ms: entry.oracle.minMs, max_ms: entry.oracle.maxMs, rounds: entry.oracle.rounds },
    reference_engine: "better-sqlite3",
  }));
  const reportsDir = repoPath("projects", "sqlite.ts", "packages", "sqlite-harness", "reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(
    join(reportsDir, "bench-median.svg"),
    benchAddon.harnessRenderBenchChart(JSON.stringify(benchRows), "median", `SQLite bench median (${ROWS} rows, ${ROUNDS} rounds)`),
    "utf8",
  );
  writeFileSync(
    join(reportsDir, "bench-p95.svg"),
    benchAddon.harnessRenderBenchChart(JSON.stringify(benchRows), "p95", `SQLite bench p95 (${ROWS} rows, ${ROUNDS} rounds)`),
    "utf8",
  );
  const text = () => {
    const rows = payload.workloads.map((entry) => [
      entry.workload,
      `${entry.ours.median.toFixed(3)} ${entry.unit}`,
      `${entry.ours.p95.toFixed(3)} ${entry.unit}`,
      `${entry.betterSqlite3.median.toFixed(3)} ${entry.unit}`,
      `${entry.betterSqlite3.p95.toFixed(3)} ${entry.unit}`,
    ]);
    return [
      renderTable(
        ["workload", "ours median", "ours p95", "better-sqlite3 median", "better-sqlite3 p95"],
        rows,
      ),
      "",
      `files: ours ${files.ours} bytes, better-sqlite3 ${files["better-sqlite3"]} bytes`,
      "Notes: both sides run the same rows, page size and transaction boundary. Our writer has no `synchronous` switch, so its batch load is one in-memory build plus a single `save()` while `better-sqlite3` runs with `synchronous=off` (favourable to us). Our reader has no point or range API, so `BENCH_POINT` and `BENCH_RANGE` are accepted parameters without a comparison row.",
    ].join("\n");
  };
  emit(options, payload, text);
  return ok ? 0 : 1;
}
