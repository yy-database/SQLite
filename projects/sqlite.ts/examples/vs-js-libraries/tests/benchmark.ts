// Side-by-side throughput of `@yydb/sqlite` vs better-sqlite3, node:sqlite, and sql.js.
// Style matches `packages/sqlite-harness/src/bench.ts` (hrtime, median / p95).
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (default 5000), BENCH_TXN (1000), BENCH_PAGE (4096), BENCH_ROUNDS (3), BENCH_POINT (1000)

import Database from "better-sqlite3";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createEngine, createWriter, openDatabase } from "../../../packages/sqlite/src/index.ts";
import { workspace } from "../src/shared.ts";
import { loadSqlJs, type SqlJsStatic } from "../src/sql-js.ts";
import { elapsedMs, median, p95, throughput } from "../src/timing.ts";

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

function betterSqlite3BatchLoad(path: string): number {
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

function betterSqlite3Scan(path: string): number[] {
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

function betterSqlite3Point(path: string): number[] {
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

function nodeSqliteBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const database = new DatabaseSync(path);
  database.exec(`pragma page_size = ${PAGE_SIZE}`);
  database.exec("pragma synchronous = off");
  database.exec("pragma journal_mode = memory");
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

function nodeSqliteScan(path: string): number[] {
  const database = new DatabaseSync(path, { readOnly: true });
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

function nodeSqlitePoint(path: string): number[] {
  const database = new DatabaseSync(path, { readOnly: true });
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

function sqlJsBatchLoad(SQL: SqlJsStatic, path: string): number {
  rmSync(path, { force: true });
  const database = new SQL.Database();
  database.run(`pragma page_size = ${PAGE_SIZE}`);
  database.run("create table items (id integer primary key, label text, score real)");
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.run("begin");
    database.run("insert into items (id, label, score) values (?, ?, ?)", [row, `row-${row}`, row / 4]);
    if (row % ROWS_PER_TXN === 0) database.run("commit");
  }
  writeFileSync(path, Buffer.from(database.export()));
  const total = elapsedMs(start);
  database.close();
  return total;
}

function sqlJsScan(SQL: SqlJsStatic, path: string): number[] {
  const bytes = readFileSync(path);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const database = new SQL.Database(bytes);
    const rows = database.exec("select id, label, score from items")[0]?.values ?? [];
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    database.close();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function sqlJsPoint(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      statement.bind([id]);
      if (!statement.step()) throw new Error(`point miss id=${id}`);
      statement.getAsObject();
      statement.reset();
    }
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

type PeerResult = {
  name: string;
  batch: number[];
  scan: number[];
  point: number[];
  bytes: number;
};

function printPeer(
  peer: PeerResult,
  ours: { batch: number[]; scan: number[]; point: number[]; bytes: number },
): void {
  const width = Math.max(18, peer.name.length + 4);
  const line = (workload: string, unit: string, ourSamples: number[], peerSamples: number[], ops: number): string => {
    const oursMed = median(ourSamples);
    const peerMed = median(peerSamples);
    return [
      workload.padEnd(48),
      `${oursMed.toFixed(3)} ${unit}`.padStart(14),
      `${p95(ourSamples).toFixed(3)} ${unit}`.padStart(14),
      throughput(ops, oursMed).padStart(12),
      `${peerMed.toFixed(3)} ${unit}`.padStart(width),
      `${p95(peerSamples).toFixed(3)} ${unit}`.padStart(width),
      throughput(ops, peerMed).padStart(12),
    ].join("  ");
  };

  console.log(`vs-js-libraries benchmark — ${peer.name}`);
  console.log(
    [
      "workload".padEnd(48),
      "ours median".padStart(14),
      "ours p95".padStart(14),
      "ours thrpt".padStart(12),
      `${peer.name} med`.padStart(width),
      `${peer.name} p95`.padStart(width),
      "peer thrpt".padStart(12),
    ].join("  "),
  );
  console.log(line(`batch load ${ROWS} (${PAGE_SIZE} page, ${ROWS_PER_TXN}/txn)`, "ms", ours.batch, peer.batch, ROWS));
  console.log(line(`full scan ${ROWS} (open+decode / select *)`, "ms", ours.scan, peer.scan, ROWS));
  console.log(line(`point select ${POINT_OPS} (engine WHERE / prepared get)`, "ms", ours.point, peer.point, POINT_OPS));
  console.log(`files: ours ${ours.bytes} bytes, ${peer.name} ${peer.bytes} bytes`);
  console.log("");
}

const oursSpace = workspace("sqlite-vs-js-libraries-ours");
const betterSpace = workspace("sqlite-vs-js-libraries-better-sqlite3");
const nodeSpace = workspace("sqlite-vs-js-libraries-node-sqlite");
const sqlJsSpace = workspace("sqlite-vs-js-libraries-sql-js");

try {
  const SQL = await loadSqlJs();

  const oursBatch = [ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path)];
  const oursScan = ourScan(oursSpace.path);
  const oursPoint = ourPoint();
  const ours = {
    batch: oursBatch,
    scan: oursScan,
    point: oursPoint,
    bytes: statSync(oursSpace.path).size,
  };

  const betterBatch = [
    betterSqlite3BatchLoad(betterSpace.path),
    betterSqlite3BatchLoad(betterSpace.path),
    betterSqlite3BatchLoad(betterSpace.path),
  ];
  const betterScan = betterSqlite3Scan(betterSpace.path);
  const betterPoint = betterSqlite3Point(betterSpace.path);

  const nodeBatch = [
    nodeSqliteBatchLoad(nodeSpace.path),
    nodeSqliteBatchLoad(nodeSpace.path),
    nodeSqliteBatchLoad(nodeSpace.path),
  ];
  const nodeScan = nodeSqliteScan(nodeSpace.path);
  const nodePoint = nodeSqlitePoint(nodeSpace.path);

  const sqlJsBatch = [
    sqlJsBatchLoad(SQL, sqlJsSpace.path),
    sqlJsBatchLoad(SQL, sqlJsSpace.path),
    sqlJsBatchLoad(SQL, sqlJsSpace.path),
  ];
  const sqlJsScanSamples = sqlJsScan(SQL, sqlJsSpace.path);
  const sqlJsPointSamples = sqlJsPoint(SQL, sqlJsSpace.path);

  printPeer(
    {
      name: "better-sqlite3",
      batch: betterBatch,
      scan: betterScan,
      point: betterPoint,
      bytes: statSync(betterSpace.path).size,
    },
    ours,
  );
  printPeer(
    {
      name: "node:sqlite",
      batch: nodeBatch,
      scan: nodeScan,
      point: nodePoint,
      bytes: statSync(nodeSpace.path).size,
    },
    ours,
  );
  printPeer(
    {
      name: "sql.js",
      batch: sqlJsBatch,
      scan: sqlJsScanSamples,
      point: sqlJsPointSamples,
      bytes: statSync(sqlJsSpace.path).size,
    },
    ours,
  );

  console.log(
    "Notes: batch/scan use the format-3 writer/reader vs peer file I/O. Point select uses createEngine SQL on our side (reader has no point API). better-sqlite3 / node:sqlite batch use synchronous=off journal_mode=memory. sql.js peer batch includes export(); peer scan reloads bytes each round.",
  );
} finally {
  oursSpace.dispose();
  betterSpace.dispose();
  nodeSpace.dispose();
  sqlJsSpace.dispose();
}
