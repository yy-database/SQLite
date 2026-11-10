// Side-by-side throughput with `node:sqlite` (`DatabaseSync`) as baseline.
// Console + report show relative uplift/gap vs baseline only (same measurements underneath).
// Timing style matches `packages/sqlite-harness/src/bench/index.ts` (hrtime, median).
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (default 5000), BENCH_TXN (1000), BENCH_PAGE (4096), BENCH_ROUNDS (3),
//      BENCH_POINT (1000), BENCH_RANGE (200), BENCH_MUTATE (1000), BENCH_SYNCHRONOUS (off|on)

import Database from "better-sqlite3";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createEngine, createWriter, openDatabase, openWriter } from "../../../packages/sqlite/src/index.ts";
import { workspace } from "../src/shared.ts";
import { loadSqlJs, type SqlJsStatic } from "../src/sql-js.ts";
import { elapsedMs, median } from "../src/timing.ts";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROWS = Number(process.env.BENCH_ROWS ?? 5_000);
const ROWS_PER_TXN = Number(process.env.BENCH_TXN ?? 1_000);
const PAGE_SIZE = Number(process.env.BENCH_PAGE ?? 4_096);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const POINT_OPS = Number(process.env.BENCH_POINT ?? 1_000);
const RANGE_OPS = Number(process.env.BENCH_RANGE ?? 200);
const RANGE_WIDTH = 50;
const MUTATE_OPS = Number(process.env.BENCH_MUTATE ?? 1_000);
const SYNC = process.env.BENCH_SYNCHRONOUS ?? "off";

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
]);

const UPDATE_SLOTS = JSON.stringify([{ keep: true }, { keep: true }, { set: 7.25 }]);

function thrptPerSec(ops: number, ms: number): number {
  if (ms <= 0) return 0;
  return (ops / ms) * 1_000;
}

/** Time ratio vs baseline (`candidate_time / baseline_time`). Faster => `<1`, slower => `>1`. */
function timeRatioVsBaseline(candidatePerSec: number, baselinePerSec: number): number {
  if (baselinePerSec <= 0 || candidatePerSec <= 0) return Number.NaN;
  return baselinePerSec / candidatePerSec;
}

function formatRatio(timeRatio: number): string {
  if (!Number.isFinite(timeRatio)) return "n/a";
  if (Math.abs(timeRatio - 1) < 0.005) return "1.00x";
  return `${timeRatio.toFixed(2)}x`;
}

type WorkloadKey = "batch" | "scan" | "point" | "point_sql" | "range" | "indexed" | "update" | "delete" | "rollback" | "open";
const WORKLOADS: WorkloadKey[] = ["batch", "scan", "point", "point_sql", "range", "indexed", "update", "delete", "rollback", "open"];

// Ops per workload for throughput normalization (batch/scan count rows; the rest count queries/mutations/opens).
function workloadOps(workload: WorkloadKey): number {
  if (workload === "batch" || workload === "scan") return ROWS;
  if (workload === "range") return RANGE_OPS;
  if (workload === "update" || workload === "delete" || workload === "rollback") return MUTATE_OPS;
  if (workload === "open") return ROUNDS;
  return POINT_OPS;
}

// ---------------------------------------------------------------------------
// native peers (`better-sqlite3`, `node:sqlite`) share one thin handle adapter.
// ---------------------------------------------------------------------------

type PeerStatement = {
  run(...values: unknown[]): void;
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
};

type PeerHandle = {
  exec(source: string): void;
  prepare(source: string): PeerStatement;
  close(): void;
};

function openBetter(path: string, readOnly = false): PeerHandle {
  const database = readOnly ? new Database(path, { readonly: true }) : new Database(path);
  return {
    exec: (source) => {
      database.exec(source);
    },
    prepare: (source) => {
      const statement = database.prepare(source);
      return {
        run: (...values) => {
          statement.run(...values);
        },
        get: (...values) => statement.get(...values),
        all: (...values) => statement.all(...values),
      };
    },
    close: () => database.close(),
  };
}

function openNode(path: string, readOnly = false): PeerHandle {
  const database = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  return {
    exec: (source) => {
      database.exec(source);
    },
    prepare: (source) => {
      const statement = database.prepare(source);
      return {
        run: (...values) => {
          statement.run(...values);
        },
        get: (...values) => statement.get(...values),
        all: (...values) => statement.all(...values),
      };
    },
    close: () => database.close(),
  };
}

function nativeBatchLoad(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number {
  rmSync(path, { force: true });
  const database = factory(path);
  database.exec(`pragma page_size = ${PAGE_SIZE}`);
  database.exec(`pragma synchronous = ${SYNC === "on" ? "full" : "off"}`);
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

function nativeScan(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
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

function nativePoint(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      if (select.get(id) === undefined) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeRange(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare("select id, label, score from items where id between ? and ?");
  const windows = Array.from({ length: RANGE_OPS }, (_, index) => 1 + (index % (ROWS - RANGE_WIDTH)));
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const lower of windows) {
      const rows = select.all(lower, lower + RANGE_WIDTH - 1);
      if (rows.length !== RANGE_WIDTH) throw new Error(`range ${lower} returned ${rows.length}`);
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeIndexed(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const writable = factory(path);
  writable.exec("create index if not exists items_label on items(label)");
  writable.close();
  const database = factory(path, true);
  const select = database.prepare("select id, label, score from items where label = ?");
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const label of labels) {
      if (select.get(label) === undefined) throw new Error(`indexed miss label=${label}`);
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeUpdate(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  nativeBatchLoad(factory, path);
  const database = factory(path);
  const update = database.prepare("update items set score = ? where id = ?");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) update.run(7.25, (op % ROWS) + 1);
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeDelete(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  nativeBatchLoad(factory, path);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory(path);
    const remove = database.prepare("delete from items where id = ?");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) remove.run(op + 1);
    database.exec("commit");
    samples.push(elapsedMs(start));
    database.close();
    nativeBatchLoad(factory, path);
  }
  return samples;
}

function nativeRollback(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path);
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) insert.run(1_000_000 + op, `rollback-${op}`, 0);
    database.exec("rollback");
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeOpen(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const database = factory(path, true);
    database.close();
    samples.push(elapsedMs(start));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// `@yydb/sqlite` (format-3 writer/reader + SQL engine)
// ---------------------------------------------------------------------------

function ourBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const start = process.hrtime.bigint();
  const writer = createWriter(PAGE_SIZE);
  writer.setSynchronous(SYNC === "on");
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

function ourPoint(path: string): number[] {
  const reader = openDatabase(path);
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const rows = reader.rowByRowid("items", id);
      if (rows === null || rows.length !== 1) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourPointSql(): number[] {
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

function ourRange(path: string): number[] {
  const reader = openDatabase(path);
  const windows = Array.from({ length: RANGE_OPS }, (_, index) => 1 + (index % (ROWS - RANGE_WIDTH)));
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const lower of windows) {
      const rows = reader.range("items", lower, lower + RANGE_WIDTH - 1);
      if (rows.length !== RANGE_WIDTH) throw new Error(`range ${lower} returned ${rows.length}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourIndexed(): number[] {
  const engine = createEngine(PAGE_SIZE);
  engine.execute("create table items (id integer primary key, label text, score real)");
  engine.execute("create index items_label on items (label)");
  for (let row = 1; row <= ROWS; row += 1) {
    engine.execute(`insert into items (id, label, score) values (${row}, 'row-${row}', ${row / 4})`);
  }
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const label of labels) {
      const result = engine.execute(`select id, label, score from items where label = '${label}'`);
      if (result.rows.length !== 1) throw new Error(`indexed miss label=${label}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourUpdate(path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const writer = openWriter(path);
    writer.setSynchronous(SYNC === "on");
    const start = process.hrtime.bigint();
    writer.begin();
    for (let op = 0; op < MUTATE_OPS; op += 1) writer.update("items", (op % ROWS) + 1, UPDATE_SLOTS);
    writer.commit();
    writer.save(path);
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourDelete(path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    ourBatchLoad(path);
    const writer = openWriter(path);
    writer.setSynchronous(SYNC === "on");
    const start = process.hrtime.bigint();
    writer.begin();
    for (let op = 0; op < MUTATE_OPS; op += 1) writer.delete("items", op + 1);
    writer.commit();
    writer.save(path);
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourRollback(path: string): number[] {
  const writer = openWriter(path);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    writer.begin();
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      writer.insert("items", JSON.stringify([1_000_000 + op, `rollback-${op}`, 0]));
    }
    writer.rollback();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourOpen(path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    openDatabase(path);
    samples.push(elapsedMs(start));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// `sql.js` (WASM SQLite over a serialized main-file image)
// ---------------------------------------------------------------------------

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

function sqlJsRange(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare("select id, label, score from items where id between ? and ?");
  const windows = Array.from({ length: RANGE_OPS }, (_, index) => 1 + (index % (ROWS - RANGE_WIDTH)));
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const lower of windows) {
      statement.bind([lower, lower + RANGE_WIDTH - 1]);
      let count = 0;
      while (statement.step()) {
        statement.getAsObject();
        count += 1;
      }
      statement.reset();
      if (count !== RANGE_WIDTH) throw new Error(`range ${lower} returned ${count}`);
    }
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsIndexed(SQL: SqlJsStatic, path: string): number[] {
  const writable = new SQL.Database(readFileSync(path));
  writable.run("create index if not exists items_label on items(label)");
  writeFileSync(path, Buffer.from(writable.export()));
  writable.close();
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare("select id, label, score from items where label = ?");
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const label of labels) {
      statement.bind([label]);
      if (!statement.step()) throw new Error(`indexed miss label=${label}`);
      statement.getAsObject();
      statement.reset();
    }
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsUpdate(SQL: SqlJsStatic, path: string): number[] {
  sqlJsBatchLoad(SQL, path);
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare("update items set score = ? where id = ?");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      statement.bind([7.25, (op % ROWS) + 1]);
      statement.step();
      statement.reset();
    }
    database.run("commit");
    writeFileSync(path, Buffer.from(database.export()));
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsDelete(SQL: SqlJsStatic, path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    sqlJsBatchLoad(SQL, path);
    const database = new SQL.Database(readFileSync(path));
    const statement = database.prepare("delete from items where id = ?");
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      statement.bind([op + 1]);
      statement.step();
      statement.reset();
    }
    database.run("commit");
    writeFileSync(path, Buffer.from(database.export()));
    samples.push(elapsedMs(start));
    statement.free();
    database.close();
  }
  return samples;
}

function sqlJsRollback(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      statement.bind([1_000_000 + op, `rollback-${op}`, 0]);
      statement.step();
      statement.reset();
    }
    database.run("rollback");
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsOpen(SQL: SqlJsStatic, path: string): number[] {
  const bytes = readFileSync(path);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const database = new SQL.Database(bytes);
    database.close();
    samples.push(elapsedMs(start));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// `@yydb/sqlite-unknown-wasm32` (in-memory SQL binding; no reader point API,
// no UPDATE/DELETE/indexes/file open — unsupported workloads report `n/a`)
// ---------------------------------------------------------------------------

type WasmDatabase = {
  exec(sql: string): string;
  snapshot(): Uint8Array;
  free(): void;
};

const requireModule = createRequire(import.meta.url);
let wasmMemoryDatabase: (new (pageSize?: number | null) => WasmDatabase) | null = null;
try {
  const glue = requireModule(join(exampleRoot, "../../platforms/sqlite-unknown-wasm32/lib/sqlite_wasm.js")) as {
    MemoryDatabase?: new (pageSize?: number | null) => WasmDatabase;
  };
  wasmMemoryDatabase = glue.MemoryDatabase ?? null;
} catch {
  // Glue not built yet (`pnpm build:wasm`); the wasm column stays `n/a`.
}

const wasmCreate = "create table items (id integer primary key, label text, score real)";

function wasmInserts(database: WasmDatabase): void {
  for (let row = 1; row <= ROWS; row += 1) {
    database.exec(`insert into items values (${row}, 'row-${row}', ${row / 4})`);
  }
}

function wasmBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const database = new wasmMemoryDatabase!(PAGE_SIZE);
  const start = process.hrtime.bigint();
  database.exec(wasmCreate);
  wasmInserts(database);
  writeFileSync(path, Buffer.from(database.snapshot()));
  const total = elapsedMs(start);
  database.free();
  return total;
}

function wasmReadDatabase(): WasmDatabase {
  const database = new wasmMemoryDatabase!(PAGE_SIZE);
  database.exec(wasmCreate);
  wasmInserts(database);
  return database;
}

function wasmScan(database: WasmDatabase): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const rows = (JSON.parse(database.exec("select * from items"))[0]?.rows ?? []) as unknown[];
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  return samples;
}

function wasmPointSql(database: WasmDatabase): number[] {
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const rows = (JSON.parse(database.exec(`select id, label, score from items where id = ${id}`))[0]?.rows ?? []) as unknown[];
      if (rows.length !== 1) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

function wasmRange(database: WasmDatabase): number[] {
  const windows = Array.from({ length: RANGE_OPS }, (_, index) => 1 + (index % (ROWS - RANGE_WIDTH)));
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const lower of windows) {
      const rows = (JSON.parse(
        database.exec(`select id, label, score from items where id >= ${lower} and id <= ${lower + RANGE_WIDTH - 1}`),
      )[0]?.rows ?? []) as unknown[];
      if (rows.length !== RANGE_WIDTH) throw new Error(`range ${lower} returned ${rows.length}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// rates + report
// ---------------------------------------------------------------------------

type LibraryRates = { name: string; rates: Partial<Record<WorkloadKey, number>> };

function ratesFromSamples(samples: Partial<Record<WorkloadKey, number[]>>): Partial<Record<WorkloadKey, number>> {
  const rates: Partial<Record<WorkloadKey, number>> = {};
  for (const workload of WORKLOADS) {
    const values = samples[workload];
    if (values) rates[workload] = thrptPerSec(workloadOps(workload), median(values));
  }
  return rates;
}

function workloadRatios(libraries: LibraryRates[], baseline: Partial<Record<WorkloadKey, number>>, workload: WorkloadKey): number[] {
  return libraries.map((library) => timeRatioVsBaseline(library.rates[workload] ?? 0, baseline[workload] ?? 0));
}

function printRelativeTable(libraries: LibraryRates[], baseline: Partial<Record<WorkloadKey, number>>): void {
  const names = libraries.map((library) => library.name);
  const plainCells = WORKLOADS.flatMap((workload) => workloadRatios(libraries, baseline, workload).map((ratio) => formatRatio(ratio)));
  const colWidth = Math.max(12, ...names.map((name) => name.length), ...plainCells.map((cell) => cell.length + 2));
  const workloadWidth = 10;

  const header = ["Workload".padEnd(workloadWidth), ...names.map((name) => name.padStart(colWidth))].join("  ");
  console.log("vs-js-libraries — relative to `node:sqlite` baseline (time ratio; * = fastest)");
  console.log(
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_TXN=${ROWS_PER_TXN}, BENCH_PAGE=${PAGE_SIZE}, BENCH_ROUNDS=${ROUNDS}, BENCH_POINT=${POINT_OPS}, BENCH_RANGE=${RANGE_OPS}, BENCH_MUTATE=${MUTATE_OPS}, BENCH_SYNCHRONOUS=${SYNC}`,
  );
  console.log(header);
  for (const workload of WORKLOADS) {
    const ratios = workloadRatios(libraries, baseline, workload);
    const finite = ratios.filter((ratio) => Number.isFinite(ratio));
    const best = finite.length ? Math.min(...finite) : Number.NaN;
    console.log(
      [
        workload.padEnd(workloadWidth),
        ...ratios.map((ratio) => {
          const text = formatRatio(ratio);
          const marked = Number.isFinite(ratio) && Math.abs(ratio - best) < 1e-9 ? `*${text}*` : text;
          return marked.padStart(colWidth);
        }),
      ].join("  "),
    );
  }
  console.log("");
}

function markdownRelativeTable(libraries: LibraryRates[], baseline: Partial<Record<WorkloadKey, number>>): string {
  const names = libraries.map((library) => library.name);
  const lines = [
    `| Workload | ${names.join(" | ")} |`,
    `|---------:|${names.map(() => "-------:").join("|")}|`,
  ];
  for (const workload of WORKLOADS) {
    const ratios = workloadRatios(libraries, baseline, workload);
    const finite = ratios.filter((ratio) => Number.isFinite(ratio));
    const best = finite.length ? Math.min(...finite) : Number.NaN;
    const cells = ratios.map((ratio) => {
      const text = formatRatio(ratio);
      return Number.isFinite(ratio) && Math.abs(ratio - best) < 1e-9 ? `**${text}**` : text;
    });
    lines.push(`| ${workload} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

const oursSpace = workspace("sqlite-vs-js-libraries-ours");
const oursMutateSpace = workspace("sqlite-vs-js-libraries-ours-mutate");
const oursDeleteSpace = workspace("sqlite-vs-js-libraries-ours-delete");
const betterSpace = workspace("sqlite-vs-js-libraries-better-sqlite3");
const betterMutateSpace = workspace("sqlite-vs-js-libraries-better-mutate");
const betterDeleteSpace = workspace("sqlite-vs-js-libraries-better-delete");
const nodeSpace = workspace("sqlite-vs-js-libraries-node-sqlite");
const nodeMutateSpace = workspace("sqlite-vs-js-libraries-node-mutate");
const nodeDeleteSpace = workspace("sqlite-vs-js-libraries-node-delete");
const sqlJsSpace = workspace("sqlite-vs-js-libraries-sql-js");
const sqlJsMutateSpace = workspace("sqlite-vs-js-libraries-sqljs-mutate");
const sqlJsDeleteSpace = workspace("sqlite-vs-js-libraries-sqljs-delete");
const wasmSpace = workspace("sqlite-vs-js-libraries-wasm");

try {
  const SQL = await loadSqlJs();

  // node:sqlite baseline.
  const nodeBatch = [
    nativeBatchLoad(openNode, nodeSpace.path),
    nativeBatchLoad(openNode, nodeSpace.path),
    nativeBatchLoad(openNode, nodeSpace.path),
  ];
  const nodeSamples: Partial<Record<WorkloadKey, number[]>> = {
    batch: nodeBatch,
    scan: nativeScan(openNode, nodeSpace.path),
    point: nativePoint(openNode, nodeSpace.path),
    range: nativeRange(openNode, nodeSpace.path),
    indexed: nativeIndexed(openNode, nodeSpace.path),
    rollback: nativeRollback(openNode, nodeSpace.path),
    open: nativeOpen(openNode, nodeSpace.path),
    update: nativeUpdate(openNode, nodeMutateSpace.path),
    delete: nativeDelete(openNode, nodeDeleteSpace.path),
  };
  nodeSamples.point_sql = nodeSamples.point;
  const baselineRates = ratesFromSamples(nodeSamples);

  // @yydb/sqlite.
  const oursSamples: Partial<Record<WorkloadKey, number[]>> = {
    batch: [ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path)],
    scan: ourScan(oursSpace.path),
    point: ourPoint(oursSpace.path),
    point_sql: ourPointSql(),
    range: ourRange(oursSpace.path),
    indexed: ourIndexed(),
    rollback: ourRollback(oursSpace.path),
    open: ourOpen(oursSpace.path),
  };
  ourBatchLoad(oursMutateSpace.path);
  oursSamples.update = ourUpdate(oursMutateSpace.path);
  oursSamples.delete = ourDelete(oursDeleteSpace.path);
  const oursRates = ratesFromSamples(oursSamples);

  // better-sqlite3.
  const betterSamples: Partial<Record<WorkloadKey, number[]>> = {
    batch: [
      nativeBatchLoad(openBetter, betterSpace.path),
      nativeBatchLoad(openBetter, betterSpace.path),
      nativeBatchLoad(openBetter, betterSpace.path),
    ],
    scan: nativeScan(openBetter, betterSpace.path),
    point: nativePoint(openBetter, betterSpace.path),
    range: nativeRange(openBetter, betterSpace.path),
    indexed: nativeIndexed(openBetter, betterSpace.path),
    rollback: nativeRollback(openBetter, betterSpace.path),
    open: nativeOpen(openBetter, betterSpace.path),
    update: nativeUpdate(openBetter, betterMutateSpace.path),
    delete: nativeDelete(openBetter, betterDeleteSpace.path),
  };
  betterSamples.point_sql = betterSamples.point;
  const betterRates = ratesFromSamples(betterSamples);

  // sql.js.
  const sqlJsSamples: Partial<Record<WorkloadKey, number[]>> = {
    batch: [
      sqlJsBatchLoad(SQL, sqlJsSpace.path),
      sqlJsBatchLoad(SQL, sqlJsSpace.path),
      sqlJsBatchLoad(SQL, sqlJsSpace.path),
    ],
    scan: sqlJsScan(SQL, sqlJsSpace.path),
    point: sqlJsPoint(SQL, sqlJsSpace.path),
    range: sqlJsRange(SQL, sqlJsSpace.path),
    indexed: sqlJsIndexed(SQL, sqlJsSpace.path),
    rollback: sqlJsRollback(SQL, sqlJsSpace.path),
    open: sqlJsOpen(SQL, sqlJsSpace.path),
    update: sqlJsUpdate(SQL, sqlJsMutateSpace.path),
    delete: sqlJsDelete(SQL, sqlJsDeleteSpace.path),
  };
  sqlJsSamples.point_sql = sqlJsSamples.point;
  const sqlJsRates = ratesFromSamples(sqlJsSamples);

  // @yydb/sqlite-unknown-wasm32 (skipped with `n/a` when the glue is not built).
  let wasmRates: Partial<Record<WorkloadKey, number>> | null = null;
  if (wasmMemoryDatabase) {
    const wasmSamples: Partial<Record<WorkloadKey, number[]>> = {
      batch: [wasmBatchLoad(wasmSpace.path), wasmBatchLoad(wasmSpace.path), wasmBatchLoad(wasmSpace.path)],
    };
    const readDatabase = wasmReadDatabase();
    wasmSamples.scan = wasmScan(readDatabase);
    wasmSamples.point_sql = wasmPointSql(readDatabase);
    wasmSamples.range = wasmRange(readDatabase);
    readDatabase.free();
    wasmRates = ratesFromSamples(wasmSamples);
  } else {
    console.log("note: wasm glue missing — run `pnpm build:wasm` to include @yydb/sqlite-unknown-wasm32\n");
  }

  const libraries: LibraryRates[] = [
    { name: "node:sqlite", rates: baselineRates },
    { name: "@yydb/sqlite", rates: oursRates },
    { name: "better-sqlite3", rates: betterRates },
    { name: "sql.js", rates: sqlJsRates },
    { name: "@yydb/sqlite-unknown-wasm32", rates: wasmRates ?? {} },
  ];
  printRelativeTable(libraries, baselineRates);

  const report = `# Benchmark report

Command: \`pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark\`
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_TXN=${ROWS_PER_TXN}\`, \`BENCH_PAGE=${PAGE_SIZE}\`, \`BENCH_ROUNDS=${ROUNDS}\`, \`BENCH_POINT=${POINT_OPS}\`, \`BENCH_RANGE=${RANGE_OPS}\`, \`BENCH_MUTATE=${MUTATE_OPS}\`, \`BENCH_SYNCHRONOUS=${SYNC}\`
Baseline: \`node:sqlite\` (\`DatabaseSync\`) = \`1.00x\`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Relative to \`node:sqlite\`

${markdownRelativeTable(libraries, baselineRates)}

## Workloads

- \`batch\`: create table, ${ROWS} rows in transactions of ${ROWS_PER_TXN}, save file. \`BENCH_SYNCHRONOUS=on\` moves every library to \`synchronous=FULL\`.
- \`scan\`: open + full table scan per round.
- \`point\`: reader \`rowByRowid\` vs each peer's prepared \`get\`.
- \`point_sql\`: our SQL engine \`select ... where id = N\` vs the same peer prepared \`get\` (peer cells reuse \`point\`).
- \`range\`: ${RANGE_WIDTH}-row \`between\` windows, reader \`range\` vs peers' prepared range.
- \`indexed\`: equality on an indexed \`label\` column; our side runs through the SQL engine, peers through their index.
- \`update\` / \`delete\`: ${MUTATE_OPS} mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- \`rollback\`: begin + ${MUTATE_OPS} inserts + rollback (nothing persisted).
- \`open\`: open + close of the main file, no reads.
- \`@yydb/sqlite-unknown-wasm32\` is the in-memory SQL binding: it runs \`batch\` (inserts + snapshot export + file write), \`scan\`, \`point_sql\` and \`range\` through \`exec\`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are \`n/a\`.

## Intentional deltas

- Our writer is snapshot-based: \`update\`/\`delete\` include the full-image \`save()\`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include \`export()\`.
- \`point_sql\` has no separate peer path — peers' prepared \`get\` is the reference.
- The wasm column reads the same in-memory image every round (\`SELECT\` re-scans the image; the binding has no seek), and its \`batch\` includes \`snapshot()\` + the file write.

Regenerate: \`pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark\`
`;
  writeFileSync(join(exampleRoot, "reports", "benchmark.md"), report, "utf8");

  console.log(
    "Notes: baseline is node:sqlite (DatabaseSync). Batch/scan/open use the format-3 writer/reader for @yydb/sqlite vs peer file I/O. point uses the reader rowByRowid API; point_sql keeps the engine SQL path. BENCH_SYNCHRONOUS=on puts every library on synchronous=FULL. update/delete on our side include save(); sql.js includes export().",
  );
} finally {
  oursSpace.dispose();
  oursMutateSpace.dispose();
  oursDeleteSpace.dispose();
  betterSpace.dispose();
  betterMutateSpace.dispose();
  betterDeleteSpace.dispose();
  nodeSpace.dispose();
  nodeMutateSpace.dispose();
  nodeDeleteSpace.dispose();
  sqlJsSpace.dispose();
  sqlJsMutateSpace.dispose();
  sqlJsDeleteSpace.dispose();
  wasmSpace.dispose();
}
