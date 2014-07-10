// Same-workload comparison between this repository's writer/reader and the
// real SQLite engine through `better-sqlite3`.
//
// Both sides load the same row count with the same page size, the same
// transaction boundary (ROWS_PER_TXN rows per commit) and the same payload
// shape. SQLite runs twice: once with `synchronous=OFF` (no fsync barrier,
// comparable with our single in-memory `save()`), and once with
// `synchronous=FULL` (durability barrier we do not expose).
//
// Run: node --experimental-strip-types bench/bench.ts

import { createRequire } from "node:module";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriter, openDatabase } from "../src/index.ts";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (
  path: string,
  options?: Record<string, unknown>,
) => {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): {
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
};

const ROWS = Number(process.env.BENCH_ROWS ?? 20_000);
const ROWS_PER_TXN = Number(process.env.BENCH_TXN ?? 1_000);
const POINT_OPS = Number(process.env.BENCH_POINT ?? 10_000);
const PAGE_SIZE = Number(process.env.BENCH_PAGE ?? 4_096);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const PAYLOAD = "x".repeat(48);

interface Timing {
  readonly name: string;
  readonly unit: string;
  readonly samples: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function record(target: Timing[], name: string, unit: string, samples: number[]): void {
  target.push({ name, unit, samples });
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
  { name: "payload", declaredType: "BLOB" },
]);

function slots(row: number, payload: Buffer): string {
  return JSON.stringify([row, `row-${row}`, row / 4, { $blob: payload.toString("hex") }]);
}

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-bench-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows keeps handles briefly after a close; the temp dir is disposable.
      }
    },
  };
}

function ourBatchLoad(path: string): { totalMs: number; pointMs: number[] } {
  const payload = Buffer.alloc(48, "x");
  const start = process.hrtime.bigint();
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) writer.begin();
    writer.insert("items", slots(row, payload));
    if (row % ROWS_PER_TXN === 0) writer.commit();
  }
  writer.save(path);
  const totalMs = elapsedMs(start);

  // Our reader exposes table scans only; point lookups are measured as one
  // reopen plus one bounded scan so the number is labelled honestly.
  const pointMs: number[] = [];
  for (let index = 0; index < Math.min(POINT_OPS, 100); index += 1) {
    const at = process.hrtime.bigint();
    const reader = openDatabase(path);
    reader.table("items", { maxRows: ROWS });
    pointMs.push(elapsedMs(at));
  }
  return { totalMs, pointMs };
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

function oracleBatchLoad(path: string, synchronous: "off" | "full"): number {
  const database = new BetterSqlite(path);
  database.pragma(`page_size = ${PAGE_SIZE}`);
  database.pragma(`synchronous = ${synchronous}`);
  database.pragma("journal_mode = memory");
  database.exec(
    "create table items (id integer primary key, label text, score real, payload blob)",
  );
  const insert = database.prepare(
    "insert into items (id, label, score, payload) values (?, ?, ?, ?)",
  );
  const payload = Buffer.alloc(48, 0x78);
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.exec("begin");
    insert.run(row, `row-${row}`, row / 4, payload);
    if (row % ROWS_PER_TXN === 0) database.exec("commit");
  }
  const totalMs = elapsedMs(start);
  database.close();
  return totalMs;
}

function oracleSingleInsert(path: string, synchronous: "off" | "full"): number[] {
  const database = new BetterSqlite(path);
  database.pragma(`synchronous = ${synchronous}`);
  database.pragma("journal_mode = memory");
  database.exec("create table items (id integer primary key, label text, score real, payload blob)");
  const insert = database.prepare(
    "insert into items (id, label, score, payload) values (?, ?, ?, ?)",
  );
  const payload = Buffer.alloc(48, 0x78);
  const samples: number[] = [];
  for (let row = 1; row <= 200; row += 1) {
    const start = process.hrtime.bigint();
    insert.run(row, `row-${row}`, row / 4, payload);
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function oracleScan(path: string, point: boolean): number[] {
  const database = new BetterSqlite(path);
  const samples: number[] = [];
  if (point) {
    const lookup = database.prepare("select id, label, score, payload from items where id = ?");
    for (let index = 0; index < POINT_OPS; index += 1) {
      const id = ((index * 7919) % ROWS) + 1;
      const start = process.hrtime.bigint();
      const row = lookup.get(id);
      if (!row) throw new Error(`missing point row ${id}`);
      samples.push(elapsedMs(start));
    }
  } else {
    for (let round = 0; round < ROUNDS; round += 1) {
      const start = process.hrtime.bigint();
      const rows = database.prepare("select id, label, score, payload from items").all();
      if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
      samples.push(elapsedMs(start));
    }
  }
  database.close();
  return samples;
}

function ourSingleInsert(path: string): number[] {
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  const payload = Buffer.alloc(48, 0x78);
  const samples: number[] = [];
  for (let row = 1; row <= 200; row += 1) {
    const start = process.hrtime.bigint();
    writer.insert("items", slots(row, payload));
    samples.push(elapsedMs(start));
  }
  writer.save(path);
  return samples;
}

const timings: Timing[] = [];
const files: Record<string, number> = {};
const ourSpace = workspace("ours");
const sqliteOffSpace = workspace("sqlite-off");
const sqliteFullSpace = workspace("sqlite-full");
const insertSpace = workspace("insert-ours");
const insertOffSpace = workspace("insert-sqlite-off");

try {
  const batch = ourBatchLoad(ourSpace.path);
  record(timings, "our batch load 20k (4k page, 1k/txn, single save)", "ms", [batch.totalMs]);
  record(
    timings,
    "better-sqlite3 batch load 20k (4k page, 1k/txn, synchronous=off)",
    "ms",
    [oracleBatchLoad(sqliteOffSpace.path, "off")],
  );
  record(
    timings,
    "better-sqlite3 batch load 20k (4k page, 1k/txn, synchronous=full)",
    "ms",
    [oracleBatchLoad(sqliteFullSpace.path, "full")],
  );

  record(timings, "our single insert 200 (autocommit writer op)", "us", ourSingleInsert(insertSpace.path).map((ms) => ms * 1_000));
  record(
    timings,
    "better-sqlite3 single insert 200 (autocommit, synchronous=off)",
    "us",
    oracleSingleInsert(insertOffSpace.path, "off").map((ms) => ms * 1_000),
  );

  record(timings, "our full scan 20k (open + decode all rows)", "ms", ourScan(ourSpace.path));
  record(timings, "better-sqlite3 full scan 20k (select all)", "ms", oracleScan(sqliteOffSpace.path, false));
  record(
    timings,
    "our point lookup (open + bounded scan, no point API)",
    "us",
    batch.pointMs.map((ms) => ms * 1_000),
  );
  record(
    timings,
    "better-sqlite3 point lookup 10k (prepared where id = ?)",
    "us",
    oracleScan(sqliteOffSpace.path, true).map((ms) => ms * 1_000),
  );

  files.our = statSync(ourSpace.path).size;
  files["better-sqlite3 off"] = statSync(sqliteOffSpace.path).size;
  files["better-sqlite3 full"] = statSync(sqliteFullSpace.path).size;
} finally {
  ourSpace.dispose();
  sqliteOffSpace.dispose();
  sqliteFullSpace.dispose();
  insertSpace.dispose();
  insertOffSpace.dispose();
}

const lines: string[] = [];
lines.push(`sqlite bench · rows=${ROWS} · txn=${ROWS_PER_TXN} · page=${PAGE_SIZE} · rounds=${ROUNDS}`);
lines.push("");
lines.push("| workload | median | p95 | unit |");
lines.push("| --- | --- | --- | --- |");
for (const timing of timings) {
  lines.push(
    `| ${timing.name} | ${median(timing.samples).toFixed(3)} | ${p95(timing.samples).toFixed(3)} | ${timing.unit} |`,
  );
}
lines.push("");
lines.push("| file | bytes |");
lines.push("| --- | --- |");
for (const [name, bytes] of Object.entries(files)) lines.push(`| ${name} | ${bytes} |`);
lines.push("");
lines.push(
  "Notes: our writer has no fsync switch, so its batch load is one in-memory build plus a single `save()`; `synchronous=off` is the closest SQLite setting. `synchronous=full` is reported as a durability reference. Our reader has no point-lookup entry point, so our point row is a reopen plus bounded scan and is not equivalent to the prepared lookup.",
);
process.stdout.write(`${lines.join("\n")}\n`);
