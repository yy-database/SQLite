// Side-by-side throughput of `@yydb/sqlite` vs `better-sqlite3`.
// Style matches `packages/sqlite-harness/src/bench.ts` (hrtime, median / p95).
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-better-sqlite3 bench`
// Env: BENCH_ROWS (default 5000), BENCH_TXN (1000), BENCH_PAGE (4096), BENCH_ROUNDS (3), BENCH_POINT (1000)

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEngine, createWriter, openDatabase } from "../../packages/sqlite/src/index.ts";

const ROWS = Number(process.env.BENCH_ROWS ?? 5_000);
const ROWS_PER_TXN = Number(process.env.BENCH_TXN ?? 1_000);
const PAGE_SIZE = Number(process.env.BENCH_PAGE ?? 4_096);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const POINT_OPS = Number(process.env.BENCH_POINT ?? 1_000);

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
]);

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, index)];
}

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-vs-better-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // disposable
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
    writer.insert("items", JSON.stringify([row, `row-${row}`, row / 4]));
    if (row % ROWS_PER_TXN === 0) writer.commit();
  }
  writer.save(path);
  return elapsedMs(start);
}

function peerBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const database = new Database(path);
  database.pragma(`page_size = ${PAGE_SIZE}`);
  database.pragma("synchronous = off");
  database.pragma("journal_mode = memory");
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.exec("begin");
    insert.run(row, `row-${row}`, row / 4);
    if (row % ROWS_PER_TXN === 0) database.exec("commit");
  }
  const total = elapsedMs(start);
  database.close();
  return total;
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

function peerScan(path: string): number[] {
  const database = new Database(path, { readonly: true });
  const samples: number[] = [];
  const select = database.prepare("select id, label, score from items");
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const rows = select.all();
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function ourPoint(): number[] {
  const engine = createEngine(PAGE_SIZE);
  engine.execute("create table items (id integer primary key, label text, score real)");
  for (let row = 1; row <= ROWS; row += 1) {
    engine.execute(`insert into items (id, label, score) values (${row}, 'row-${row}', ${row / 4})`);
  }
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const result = engine.execute(`select id, label, score from items where id = ${id}`);
      if (result.rows.length !== 1) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

function peerPoint(path: string): number[] {
  const database = new Database(path, { readonly: true });
  const select = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const row = select.get(id);
      if (row === undefined) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function throughput(rows: number, ms: number): string {
  if (ms <= 0) return "n/a";
  return `${Math.round((rows / ms) * 1_000).toLocaleString("en-US")}/s`;
}

function line(workload: string, unit: string, ours: number[], peer: number[], ops: number): string {
  const oursMed = median(ours);
  const peerMed = median(peer);
  return [
    workload.padEnd(48),
    `${oursMed.toFixed(3)} ${unit}`.padStart(14),
    `${p95(ours).toFixed(3)} ${unit}`.padStart(14),
    throughput(ops, oursMed).padStart(12),
    `${peerMed.toFixed(3)} ${unit}`.padStart(18),
    `${p95(peer).toFixed(3)} ${unit}`.padStart(18),
    throughput(ops, peerMed).padStart(12),
  ].join("  ");
}

const oursSpace = workspace("ours");
const peerSpace = workspace("peer");
try {
  const batchOurs = [ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path)];
  const batchPeer = [peerBatchLoad(peerSpace.path), peerBatchLoad(peerSpace.path), peerBatchLoad(peerSpace.path)];
  const scanOurs = ourScan(oursSpace.path);
  const scanPeer = peerScan(peerSpace.path);
  const pointOurs = ourPoint();
  const pointPeer = peerPoint(peerSpace.path);

  console.log("vs-better-sqlite3 bench");
  console.log(
    [
      "workload".padEnd(48),
      "ours median".padStart(14),
      "ours p95".padStart(14),
      "ours thrpt".padStart(12),
      "better-sqlite3 med".padStart(18),
      "better-sqlite3 p95".padStart(18),
      "peer thrpt".padStart(12),
    ].join("  "),
  );
  console.log(line(`batch load ${ROWS} (${PAGE_SIZE} page, ${ROWS_PER_TXN}/txn)`, "ms", batchOurs, batchPeer, ROWS));
  console.log(line(`full scan ${ROWS} (open+decode / select *)`, "ms", scanOurs, scanPeer, ROWS));
  console.log(line(`point select ${POINT_OPS} (engine WHERE / prepared get)`, "ms", pointOurs, pointPeer, POINT_OPS));
  console.log(
    `files: ours ${statSync(oursSpace.path).size} bytes, better-sqlite3 ${statSync(peerSpace.path).size} bytes`,
  );
  console.log(
    "Notes: batch/scan use the format-3 writer/reader vs better-sqlite3 file I/O. Point select uses createEngine SQL on our side (reader has no point API) vs prepared get. Peer batch runs with synchronous=off journal_mode=memory.",
  );
} finally {
  oursSpace.dispose();
  peerSpace.dispose();
}
