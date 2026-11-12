// Side-by-side throughput with `node:sqlite` (`DatabaseSync`) as baseline.
// Console + report show relative uplift/gap vs baseline only (same measurements underneath).
// Timing style matches `packages/sqlite-harness/src/bench/index.ts` (hrtime, median).
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (default 5000), BENCH_TXN (1000), BENCH_PAGE (4096), BENCH_ROUNDS (3),
//      BENCH_POINT (1000), BENCH_RANGE (200), BENCH_MUTATE (1000), BENCH_SYNCHRONOUS (off|on),
//      BENCH_LIMIT (200), BENCH_AGG (20), BENCH_JOIN (10), BENCH_DISTINCT (5), BENCH_SUBQUERY (20),
//      BENCH_MULTI (10), BENCH_UPSERT (500)

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createWriter, openDatabase, openWriter, SQLite } from "../../../packages/sqlite/src/index.ts";
import { workspace } from "../src/shared.ts";
import { loadSqlJs, type SqlJsStatic } from "../src/sql-js.ts";
import { elapsedMs, median, p95 } from "../src/timing.ts";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROWS = Number(process.env.BENCH_ROWS ?? 5_000);
const ROWS_PER_TXN = Number(process.env.BENCH_TXN ?? 1_000);
const PAGE_SIZE = Number(process.env.BENCH_PAGE ?? 4_096);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const POINT_OPS = Number(process.env.BENCH_POINT ?? 1_000);
const RANGE_OPS = Number(process.env.BENCH_RANGE ?? 200);
const RANGE_WIDTH = 50;
const MUTATE_OPS = Number(process.env.BENCH_MUTATE ?? 1_000);
const LIMIT_OPS = Number(process.env.BENCH_LIMIT ?? 200);
const AGG_OPS = Number(process.env.BENCH_AGG ?? 20);
const JOIN_OPS = Number(process.env.BENCH_JOIN ?? 10);
const DISTINCT_OPS = Number(process.env.BENCH_DISTINCT ?? 5);
const SUBQUERY_OPS = Number(process.env.BENCH_SUBQUERY ?? 20);
const MULTI_STATEMENTS = Number(process.env.BENCH_MULTI ?? 10);
const MULTI_ROWS_PER_STATEMENT = 100;
const UPSERT_OPS = Number(process.env.BENCH_UPSERT ?? 500);
const SYNC = process.env.BENCH_SYNCHRONOUS ?? "off";

// Fixed shapes for the analytic workloads (same statement text on every engine).
const ORDER_LIMIT_ROWS = 50;
const JOIN_MODULO = 50;
const UK_INDEX_DDL = "create unique index items_uk on items(label)";
const POINT_UK_SQL = "select id, label, score from items where label = ?";
const ORDER_LIMIT_SQL = `select id, label, score from items order by id limit ${ORDER_LIMIT_ROWS}`;
const GROUP_BY_SQL = "select cast(score as integer) as bucket, count(*) as total from items group by cast(score as integer)";
const JOIN_SQL = `select count(*) as matched from items join items as b on b.id = items.id % ${JOIN_MODULO}`;
const DISTINCT_SQL = "select distinct label from items";
const AGGREGATE_SQL = "select count(*) as n, sum(score) as total, min(score) as lo, max(score) as hi from items";
const SUBQUERY_THRESHOLD = 1_000;
const SUBQUERY_SQL = `select count(*) as n from items where id in (select id from items where score > ${SUBQUERY_THRESHOLD})`;
const INDEX_RANGE_LOWER = "row-1000";
const INDEX_RANGE_UPPER = "row-1499";
const INDEX_RANGE_SQL = `select id from items where label between '${INDEX_RANGE_LOWER}' and '${INDEX_RANGE_UPPER}' order by label`;
const UPSERT_SQL = "insert into items (id, label, score) values (?, ?, ?) on conflict(id) do update set score = excluded.score";

function expectedJoinMatches(): number {
  let matches = 0;
  for (let id = 1; id <= ROWS; id += 1) {
    const key = id % JOIN_MODULO;
    if (key !== 0 && key <= ROWS) matches += 1;
  }
  return matches;
}

function expectedGroupBuckets(): number {
  const buckets = new Set<number>();
  for (let id = 1; id <= ROWS; id += 1) buckets.add(Math.floor(id / 4));
  return buckets.size;
}

function expectedSubqueryRows(): number {
  let count = 0;
  for (let id = 1; id <= ROWS; id += 1) if (id / 4 > SUBQUERY_THRESHOLD) count += 1;
  return count;
}

function expectedIndexRangeRows(): number {
  let count = 0;
  for (let id = 1; id <= ROWS; id += 1) {
    const label = `row-${id}`;
    if (label >= INDEX_RANGE_LOWER && label <= INDEX_RANGE_UPPER) count += 1;
  }
  return count;
}

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

type WorkloadKey =
  | "batch" | "scan" | "point" | "point_sql" | "point_uk" | "range" | "indexed"
  | "order_limit" | "group_by" | "join"
  | "distinct" | "aggregate" | "subquery" | "index_range" | "insert_multi" | "upsert"
  | "update" | "delete" | "rollback" | "open";
const WORKLOADS: WorkloadKey[] = [
  "batch", "scan", "point", "point_sql", "point_uk", "range", "indexed",
  "order_limit", "group_by", "join",
  "distinct", "aggregate", "subquery", "index_range", "insert_multi", "upsert",
  "update", "delete", "rollback", "open",
];

// Ops per workload for throughput normalization (batch/scan count rows; the rest count queries/mutations/opens).
function workloadOps(workload: WorkloadKey): number {
  if (workload === "batch" || workload === "scan") return ROWS;
  if (workload === "range" || workload === "index_range") return RANGE_OPS;
  if (workload === "order_limit") return LIMIT_OPS;
  if (workload === "group_by" || workload === "aggregate") return AGG_OPS;
  if (workload === "join") return JOIN_OPS;
  if (workload === "distinct") return DISTINCT_OPS;
  if (workload === "subquery") return SUBQUERY_OPS;
  if (workload === "insert_multi") return MULTI_STATEMENTS * MULTI_ROWS_PER_STATEMENT;
  if (workload === "upsert") return UPSERT_OPS;
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

function nativePointUk(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const writable = factory(path);
  writable.exec("create unique index if not exists items_uk on items(label)");
  writable.close();
  const database = factory(path, true);
  const select = database.prepare(POINT_UK_SQL);
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const run = () => {
    for (const label of labels) {
      if (select.get(label) === undefined) throw new Error(`point_uk miss label=${label}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeOrderLimit(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(ORDER_LIMIT_SQL);
  const expected = Math.min(ORDER_LIMIT_ROWS, ROWS);
  const run = () => {
    for (let op = 0; op < LIMIT_OPS; op += 1) {
      const rows = select.all();
      if (rows.length !== expected) throw new Error(`order_limit returned ${rows.length}, expected ${expected}`);
      const first = rows[0] as { id: number } | undefined;
      if (!first || Number(first.id) !== 1) throw new Error(`order_limit key order broken: ${JSON.stringify(first)}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeGroupBy(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(GROUP_BY_SQL);
  const expected = expectedGroupBuckets();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = select.all() as { bucket: number; total: number }[];
      if (rows.length !== expected) throw new Error(`group_by returned ${rows.length} groups, expected ${expected}`);
      const total = rows.reduce((sum, row) => sum + Number(row.total), 0);
      if (total !== ROWS) throw new Error(`group_by totals ${total}, expected ${ROWS}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeJoin(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(JOIN_SQL);
  const expected = expectedJoinMatches();
  const run = () => {
    for (let op = 0; op < JOIN_OPS; op += 1) {
      const row = select.get() as { matched: number } | undefined;
      if (!row || Number(row.matched) !== expected) throw new Error(`join matched ${JSON.stringify(row)}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
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

function nativeDistinct(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(DISTINCT_SQL);
  const run = () => {
    for (let op = 0; op < DISTINCT_OPS; op += 1) {
      const rows = select.all();
      if (rows.length !== ROWS) throw new Error(`distinct returned ${rows.length}, expected ${ROWS}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeAggregate(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(AGGREGATE_SQL);
  const expectedSum = (ROWS * (ROWS + 1)) / 8;
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n?: number; total?: number; lo?: number; hi?: number } | undefined;
      if (!row || Number(row.n) !== ROWS) throw new Error(`aggregate rows ${JSON.stringify(row)}, expected ${ROWS}`);
      if (Math.abs(Number(row.total) - expectedSum) > 1e-6) throw new Error(`aggregate sum ${row.total}, expected ${expectedSum}`);
      if (Number(row.lo) !== 0.25 || Number(row.hi) !== ROWS / 4) throw new Error(`aggregate bounds ${JSON.stringify(row)}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeSubquery(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare("select count(*) as n from items where id in (select id from items where score > ?)");
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < SUBQUERY_OPS; op += 1) {
      const row = select.get(SUBQUERY_THRESHOLD) as { n: number } | undefined;
      if (!row || Number(row.n) !== expected) throw new Error(`subquery returned ${JSON.stringify(row)}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeIndexRange(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const writable = factory(path);
  writable.exec("create index if not exists items_label on items(label)");
  writable.close();
  const database = factory(path, true);
  const select = database.prepare(INDEX_RANGE_SQL);
  const expected = expectedIndexRangeRows();
  const run = () => {
    for (let op = 0; op < RANGE_OPS; op += 1) {
      const rows = select.all();
      if (rows.length !== expected) throw new Error(`index_range returned ${rows.length}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nativeInsertMulti(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    rmSync(path, { force: true });
    const database = factory(path);
    database.exec(`pragma page_size = ${PAGE_SIZE}`);
    database.exec(`pragma synchronous = ${SYNC === "on" ? "full" : "off"}`);
    database.exec("pragma journal_mode = memory");
    database.exec("create table items (id integer primary key, label text, score real)");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let statement = 0; statement < MULTI_STATEMENTS; statement += 1) {
      const values: string[] = [];
      for (let row = 0; row < MULTI_ROWS_PER_STATEMENT; row += 1) {
        const id = statement * MULTI_ROWS_PER_STATEMENT + row + 1;
        values.push(`(${id}, 'multi-${id}', ${id / 4})`);
      }
      database.exec(`insert into items (id, label, score) values ${values.join(", ")}`);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
    if (!count || Number(count.n) !== MULTI_STATEMENTS * MULTI_ROWS_PER_STATEMENT) {
      throw new Error(`insert_multi rows ${JSON.stringify(count)}`);
    }
    database.close();
  }
  return samples;
}

function nativeUpsert(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  nativeBatchLoad(factory, path);
  const database = factory(path);
  const upsert = database.prepare(UPSERT_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < UPSERT_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      upsert.run(id, `row-${id}`, 7.25);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.prepare("select score from items where id = 1").get() as { score: number } | undefined;
  if (!row || Number(row.score) !== 7.25) throw new Error(`upsert did not update: ${JSON.stringify(row)}`);
  database.close();
  return samples;
}

// ---------------------------------------------------------------------------
// `@yydb/sqlite` (public `new SQLite()` for SQL workloads + format-3
// writer/reader for the workloads the public API does not expose)
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
  const database = buildDatabase();
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      if (database.get(`select id, label, score from items where id = ${id}`) === undefined) {
        throw new Error(`point miss id=${id}`);
      }
    }
    samples.push(elapsedMs(start));
  }
  database.close();
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
  const database = buildDatabase("label");
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const label of labels) {
      if (database.get(`select id, label, score from items where label = '${label}'`) === undefined) {
        throw new Error(`indexed miss label=${label}`);
      }
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

type IndexKind = "none" | "label" | "uk";

function buildDatabase(index: IndexKind = "none"): SQLite {
  const database = new SQLite();
  database.exec("create table items (id integer primary key, label text, score real)");
  if (index === "label") database.exec("create index items_label on items (label)");
  if (index === "uk") database.exec(UK_INDEX_DDL);
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.transaction(() => {
    for (let row = 1; row <= ROWS; row += 1) insert.run([BigInt(row), `row-${row}`, row / 4]);
  });
  return database;
}

function ourPointUk(): number[] {
  const database = buildDatabase("uk");
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const run = () => {
    for (const label of labels) {
      if (database.get(`select id, label, score from items where label = '${label}'`) === undefined) {
        throw new Error(`point_uk miss label=${label}`);
      }
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function ourOrderLimit(database: SQLite): number[] {
  const expected = Math.min(ORDER_LIMIT_ROWS, ROWS);
  const run = () => {
    for (let op = 0; op < LIMIT_OPS; op += 1) {
      const rows = database.all<{ id: bigint }>(ORDER_LIMIT_SQL);
      if (rows.length !== expected) throw new Error(`order_limit returned ${rows.length}, expected ${expected}`);
      for (let index = 0; index < rows.length; index += 1) {
        if (Number(rows[index].id) !== index + 1) throw new Error(`order_limit key order broken at ${index}`);
      }
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourGroupBy(database: SQLite): number[] {
  const expected = expectedGroupBuckets();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = database.all<{ bucket: bigint; total: bigint }>(GROUP_BY_SQL);
      if (rows.length !== expected) throw new Error(`group_by returned ${rows.length} groups, expected ${expected}`);
      const total = rows.reduce((sum, row) => sum + Number(row.total), 0);
      if (total !== ROWS) throw new Error(`group_by totals ${total}, expected ${ROWS}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourJoin(database: SQLite): number[] {
  const expected = expectedJoinMatches();
  const run = () => {
    for (let op = 0; op < JOIN_OPS; op += 1) {
      const rows = database.all<{ matched: bigint }>(JOIN_SQL);
      const matched = Number(rows[0]?.matched);
      if (matched !== expected) throw new Error(`join matched ${matched}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
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

function ourDistinct(database: SQLite): number[] {
  const run = () => {
    for (let op = 0; op < DISTINCT_OPS; op += 1) {
      const rows = database.all<{ label: string }>(DISTINCT_SQL);
      if (rows.length !== ROWS) throw new Error(`distinct returned ${rows.length}, expected ${ROWS}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourAggregate(database: SQLite): number[] {
  const expectedSum = (ROWS * (ROWS + 1)) / 8;
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = database.get<{ n: bigint; total: number; lo: number; hi: number }>(AGGREGATE_SQL);
      if (!row) throw new Error("aggregate returned no row");
      if (Number(row.n) !== ROWS) throw new Error(`aggregate rows ${row.n}, expected ${ROWS}`);
      if (Math.abs(Number(row.total) - expectedSum) > 1e-6) throw new Error(`aggregate sum ${row.total}, expected ${expectedSum}`);
      if (Number(row.lo) !== 0.25 || Number(row.hi) !== ROWS / 4) throw new Error(`aggregate bounds ${JSON.stringify(row)}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourSubquery(database: SQLite): number[] {
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < SUBQUERY_OPS; op += 1) {
      const rows = database.all<{ n: bigint }>(SUBQUERY_SQL);
      if (rows.length !== 1 || Number(rows[0].n) !== expected) {
        throw new Error(`subquery returned ${JSON.stringify(rows)}, expected ${expected}`);
      }
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourIndexRange(): number[] {
  const database = buildDatabase("uk");
  const expected = expectedIndexRangeRows();
  const run = () => {
    for (let op = 0; op < RANGE_OPS; op += 1) {
      const rows = database.all<{ id: bigint }>(INDEX_RANGE_SQL);
      if (rows.length !== expected) throw new Error(`index_range returned ${rows.length}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function ourInsertMulti(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQLite();
    database.exec("create table items (id integer primary key, label text, score real)");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let statement = 0; statement < MULTI_STATEMENTS; statement += 1) {
      const values: string[] = [];
      for (let row = 0; row < MULTI_ROWS_PER_STATEMENT; row += 1) {
        const id = statement * MULTI_ROWS_PER_STATEMENT + row + 1;
        values.push(`(${id}, 'multi-${id}', ${id / 4})`);
      }
      database.run(`insert into items (id, label, score) values ${values.join(", ")}`);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.get<{ n: bigint }>("select count(*) as n from items");
    if (!count || Number(count.n) !== MULTI_STATEMENTS * MULTI_ROWS_PER_STATEMENT) {
      throw new Error(`insert_multi rows ${JSON.stringify(count)}`);
    }
    database.close();
  }
  return samples;
}

function ourUpsert(): number[] {
  const database = buildDatabase();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < UPSERT_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      database.run(`insert into items (id, label, score) values (${id}, 'row-${id}', 7.25) on conflict(id) do update set score = excluded.score`);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.get<{ score: number }>("select score from items where id = 1");
  if (!row || Number(row.score) !== 7.25) throw new Error(`upsert did not update: ${JSON.stringify(row)}`);
  database.close();
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

function sqlJsPointUk(SQL: SqlJsStatic, path: string): number[] {
  const writable = new SQL.Database(readFileSync(path));
  writable.run("create unique index if not exists items_uk on items(label)");
  writeFileSync(path, Buffer.from(writable.export()));
  writable.close();
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(POINT_UK_SQL);
  const labels = Array.from({ length: POINT_OPS }, (_, index) => `row-${(index % ROWS) + 1}`);
  const run = () => {
    for (const label of labels) {
      statement.bind([label]);
      if (!statement.step()) throw new Error(`point_uk miss label=${label}`);
      statement.getAsObject();
      statement.reset();
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsOrderLimit(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(ORDER_LIMIT_SQL);
  const expected = Math.min(ORDER_LIMIT_ROWS, ROWS);
  const run = () => {
    for (let op = 0; op < LIMIT_OPS; op += 1) {
      let count = 0;
      while (statement.step()) {
        statement.getAsObject();
        count += 1;
      }
      statement.reset();
      if (count !== expected) throw new Error(`order_limit returned ${count}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsGroupBy(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(GROUP_BY_SQL);
  const expected = expectedGroupBuckets();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      let groups = 0;
      let total = 0;
      while (statement.step()) {
        const row = statement.getAsObject() as { total?: number };
        total += Number(row.total ?? 0);
        groups += 1;
      }
      statement.reset();
      if (groups !== expected) throw new Error(`group_by returned ${groups} groups, expected ${expected}`);
      if (total !== ROWS) throw new Error(`group_by totals ${total}, expected ${ROWS}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

function sqlJsJoin(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(JOIN_SQL);
  const expected = expectedJoinMatches();
  const run = () => {
    for (let op = 0; op < JOIN_OPS; op += 1) {
      if (!statement.step()) throw new Error("join returned no row");
      const row = statement.getAsObject() as { matched?: number };
      if (Number(row.matched) !== expected) throw new Error(`join matched ${JSON.stringify(row)}, expected ${expected}`);
      statement.reset();
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
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

function wasmExecRows(database: WasmDatabase, sql: string): unknown[][] {
  return (JSON.parse(database.exec(sql))[0]?.rows ?? []) as unknown[][];
}

function wasmOrderLimit(database: WasmDatabase): number[] {
  const expected = Math.min(ORDER_LIMIT_ROWS, ROWS);
  const run = () => {
    for (let op = 0; op < LIMIT_OPS; op += 1) {
      const rows = wasmExecRows(database, ORDER_LIMIT_SQL);
      if (rows.length !== expected) throw new Error(`order_limit returned ${rows.length}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function wasmGroupBy(database: WasmDatabase): number[] {
  const expected = expectedGroupBuckets();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, GROUP_BY_SQL);
      if (rows.length !== expected) throw new Error(`group_by returned ${rows.length} groups, expected ${expected}`);
      const total = rows.reduce((sum, row) => sum + Number(row[1]), 0);
      if (total !== ROWS) throw new Error(`group_by totals ${total}, expected ${ROWS}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function wasmJoin(database: WasmDatabase): number[] {
  const expected = expectedJoinMatches();
  const run = () => {
    for (let op = 0; op < JOIN_OPS; op += 1) {
      const rows = wasmExecRows(database, JOIN_SQL);
      const matched = Number(rows[0]?.[0]);
      if (matched !== expected) throw new Error(`join matched ${matched}, expected ${expected}`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    run();
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
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_TXN=${ROWS_PER_TXN}, BENCH_PAGE=${PAGE_SIZE}, BENCH_ROUNDS=${ROUNDS}, BENCH_POINT=${POINT_OPS}, BENCH_RANGE=${RANGE_OPS}, BENCH_MUTATE=${MUTATE_OPS}, BENCH_LIMIT=${LIMIT_OPS}, BENCH_AGG=${AGG_OPS}, BENCH_JOIN=${JOIN_OPS}, BENCH_SYNCHRONOUS=${SYNC}`,
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

// Absolute round timings (median / p95 ms via the harness `benchSummary`, never local stats).
type LibrarySamples = { name: string; samples: Partial<Record<WorkloadKey, number[]>> };

function markdownAbsoluteTable(entries: LibrarySamples[]): string {
  const names = entries.map((entry) => entry.name);
  const lines = [
    `| Workload | ${names.map((name) => `${name} median / p95 (ms)`).join(" | ")} |`,
    `|---------:|${names.map(() => "-------:").join("|")}|`,
  ];
  for (const workload of WORKLOADS) {
    const cells = entries.map((entry) => {
      const values = entry.samples[workload];
      if (!values || values.length === 0) return "n/a";
      return `${median(values).toFixed(2)} / ${p95(values).toFixed(2)}`;
    });
    lines.push(`| ${workload} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

// Provenance: toolchain + revisions + data scale, so a report row can be re-attributed later.
function commandOutput(file: string, args: string[], cwd?: string): string {
  try {
    const result = spawnSync(file, args, { cwd, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

const projectsDir = join(exampleRoot, "..", "..", "..");
const repoRoot = join(projectsDir, "..");

function bindingPinnedRev(): string {
  try {
    const text = readFileSync(join(projectsDir, "sqlite.rs", "Cargo.toml"), "utf8");
    const match = /sqlite = \{[^}]*rev = "([0-9a-f]{7,40})"/.exec(text);
    return match?.[1]?.slice(0, 7) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function provenanceLines(): string {
  return [
    `- node: \`${process.version}\``,
    `- rustc: \`${commandOutput("rustc", ["-V"])}\``,
    `- repo rev: \`${commandOutput("git", ["rev-parse", "--short", "HEAD"], repoRoot)}\``,
    `- binding rev (\`database.rs\` pin in \`projects/sqlite.rs/Cargo.toml\`): \`${bindingPinnedRev()}\``,
    `- data: \`${ROWS}\` rows (page \`${PAGE_SIZE}\`), \`BENCH_ROUNDS=${ROUNDS}\`, point/indexed \`${POINT_OPS}\`, range \`${RANGE_OPS}\`, order_limit \`${LIMIT_OPS}\`, group_by \`${AGG_OPS}\`, join \`${JOIN_OPS}\`, distinct \`${DISTINCT_OPS}\`, subquery \`${SUBQUERY_OPS}\`, multi \`${MULTI_STATEMENTS}x${MULTI_ROWS_PER_STATEMENT}\`, upsert \`${UPSERT_OPS}\`, mutate \`${MUTATE_OPS}\``,
  ].join("\n");
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
const nodeFeatureSpace = workspace("sqlite-vs-js-libraries-node-feature");
const betterFeatureSpace = workspace("sqlite-vs-js-libraries-better-feature");
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
    point_uk: nativePointUk(openNode, nodeSpace.path),
    range: nativeRange(openNode, nodeSpace.path),
    indexed: nativeIndexed(openNode, nodeSpace.path),
    order_limit: nativeOrderLimit(openNode, nodeSpace.path),
    group_by: nativeGroupBy(openNode, nodeSpace.path),
    join: nativeJoin(openNode, nodeSpace.path),
    distinct: nativeDistinct(openNode, nodeSpace.path),
    aggregate: nativeAggregate(openNode, nodeSpace.path),
    subquery: nativeSubquery(openNode, nodeSpace.path),
    index_range: nativeIndexRange(openNode, nodeSpace.path),
    insert_multi: nativeInsertMulti(openNode, nodeFeatureSpace.path),
    upsert: nativeUpsert(openNode, nodeFeatureSpace.path),
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
    point_uk: ourPointUk(),
    range: ourRange(oursSpace.path),
    indexed: ourIndexed(),
    rollback: ourRollback(oursSpace.path),
    open: ourOpen(oursSpace.path),
  };
  const analyticDatabase = buildDatabase();
  oursSamples.order_limit = ourOrderLimit(analyticDatabase);
  oursSamples.group_by = ourGroupBy(analyticDatabase);
  oursSamples.join = ourJoin(analyticDatabase);
  oursSamples.distinct = ourDistinct(analyticDatabase);
  oursSamples.aggregate = ourAggregate(analyticDatabase);
  oursSamples.subquery = ourSubquery(analyticDatabase);
  analyticDatabase.close();
  oursSamples.index_range = ourIndexRange();
  oursSamples.insert_multi = ourInsertMulti();
  oursSamples.upsert = ourUpsert();
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
    point_uk: nativePointUk(openBetter, betterSpace.path),
    range: nativeRange(openBetter, betterSpace.path),
    indexed: nativeIndexed(openBetter, betterSpace.path),
    order_limit: nativeOrderLimit(openBetter, betterSpace.path),
    group_by: nativeGroupBy(openBetter, betterSpace.path),
    join: nativeJoin(openBetter, betterSpace.path),
    distinct: nativeDistinct(openBetter, betterSpace.path),
    aggregate: nativeAggregate(openBetter, betterSpace.path),
    subquery: nativeSubquery(openBetter, betterSpace.path),
    index_range: nativeIndexRange(openBetter, betterSpace.path),
    insert_multi: nativeInsertMulti(openBetter, betterFeatureSpace.path),
    upsert: nativeUpsert(openBetter, betterFeatureSpace.path),
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
    point_uk: sqlJsPointUk(SQL, sqlJsSpace.path),
    range: sqlJsRange(SQL, sqlJsSpace.path),
    indexed: sqlJsIndexed(SQL, sqlJsSpace.path),
    order_limit: sqlJsOrderLimit(SQL, sqlJsSpace.path),
    group_by: sqlJsGroupBy(SQL, sqlJsSpace.path),
    join: sqlJsJoin(SQL, sqlJsSpace.path),
    rollback: sqlJsRollback(SQL, sqlJsSpace.path),
    open: sqlJsOpen(SQL, sqlJsSpace.path),
    update: sqlJsUpdate(SQL, sqlJsMutateSpace.path),
    delete: sqlJsDelete(SQL, sqlJsDeleteSpace.path),
  };
  sqlJsSamples.point_sql = sqlJsSamples.point;
  const sqlJsRates = ratesFromSamples(sqlJsSamples);

  // @yydb/sqlite-unknown-wasm32 (skipped with `n/a` when the glue is not built).
  let wasmRates: Partial<Record<WorkloadKey, number>> | null = null;
  let wasmSamples: Partial<Record<WorkloadKey, number[]>> = {};
  if (wasmMemoryDatabase) {
    wasmSamples = {
      batch: [wasmBatchLoad(wasmSpace.path), wasmBatchLoad(wasmSpace.path), wasmBatchLoad(wasmSpace.path)],
    };
    const readDatabase = wasmReadDatabase();
    wasmSamples.scan = wasmScan(readDatabase);
    wasmSamples.point_sql = wasmPointSql(readDatabase);
    wasmSamples.range = wasmRange(readDatabase);
    wasmSamples.order_limit = wasmOrderLimit(readDatabase);
    wasmSamples.group_by = wasmGroupBy(readDatabase);
    wasmSamples.join = wasmJoin(readDatabase);
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
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_TXN=${ROWS_PER_TXN}\`, \`BENCH_PAGE=${PAGE_SIZE}\`, \`BENCH_ROUNDS=${ROUNDS}\`, \`BENCH_POINT=${POINT_OPS}\`, \`BENCH_RANGE=${RANGE_OPS}\`, \`BENCH_MUTATE=${MUTATE_OPS}\`, \`BENCH_LIMIT=${LIMIT_OPS}\`, \`BENCH_AGG=${AGG_OPS}\`, \`BENCH_JOIN=${JOIN_OPS}\`, \`BENCH_DISTINCT=${DISTINCT_OPS}\`, \`BENCH_SUBQUERY=${SUBQUERY_OPS}\`, \`BENCH_MULTI=${MULTI_STATEMENTS}\`, \`BENCH_UPSERT=${UPSERT_OPS}\`, \`BENCH_SYNCHRONOUS=${SYNC}\`
Baseline: \`node:sqlite\` (\`DatabaseSync\`) = \`1.00x\`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

${provenanceLines()}

## Relative to \`node:sqlite\`

${markdownRelativeTable(libraries, baselineRates)}

## Absolute round timings (median / p95 ms)

${markdownAbsoluteTable([
    { name: "node:sqlite", samples: nodeSamples },
    { name: "@yydb/sqlite", samples: oursSamples },
    { name: "better-sqlite3", samples: betterSamples },
    { name: "sql.js", samples: sqlJsSamples },
    { name: "@yydb/sqlite-unknown-wasm32", samples: wasmSamples },
  ])}

## Workloads

- \`batch\`: create table, ${ROWS} rows in transactions of ${ROWS_PER_TXN}, save file. \`BENCH_SYNCHRONOUS=on\` moves every library to \`synchronous=FULL\`.
- \`scan\`: open + full table scan per round.
- \`point\`: reader \`rowByRowid\` vs each peer's prepared \`get\`.
- \`point_sql\`: our public \`new SQLite()\` \`select ... where id = N\` vs the same peer prepared \`get\` (peer cells reuse \`point\`).
- \`point_uk\`: point lookup through a **unique** index on \`label\`; our side runs \`select ... where label = '...'\` on \`new SQLite()\` carrying \`create unique index\`, peers through their unique index (one untimed warmup round first).
- \`range\`: ${RANGE_WIDTH}-row \`between\` windows, reader \`range\` vs peers' prepared range.
- \`indexed\`: equality on an indexed \`label\` column; our side runs through \`new SQLite()\`, peers through their index.
- \`order_limit\`: \`select ... order by id limit ${ORDER_LIMIT_ROWS}\` — repeated ${LIMIT_OPS}x per round; separates the key-order scan constant from the per-statement fixed cost.
- \`group_by\`: \`select cast(score as integer), count(*) ... group by cast(score as integer)\` (${AGG_OPS} queries per round, ${expectedGroupBuckets()} groups over ${ROWS} rows).
- \`join\`: \`select count(*) from items join items as b on b.id = items.id % ${JOIN_MODULO}\` (${JOIN_OPS} queries per round, ${expectedJoinMatches()} matched pairs) — exposes a nested full scan of the inner side.
- \`distinct\`: \`select distinct label from items\` (${DISTINCT_OPS} queries per round, ${ROWS} distinct labels) — worst case for the dedup structure because nothing collapses.
- \`aggregate\`: \`select count(*), sum(score), min(score), max(score) from items\` (${AGG_OPS} queries per round) — single-pass aggregate without grouping.
- \`subquery\`: \`select count(*) ... where id in (select id from items where score > ${SUBQUERY_THRESHOLD})\` (${SUBQUERY_OPS} queries per round, ${expectedSubqueryRows()} matches) — uncorrelated \`IN\` subquery.
- \`index_range\`: \`select id from items where label between '${INDEX_RANGE_LOWER}' and '${INDEX_RANGE_UPPER}' order by label\` (${RANGE_OPS} queries per round, ${expectedIndexRangeRows()} rows) — range predicate on an indexed column.
- \`insert_multi\`: ${MULTI_STATEMENTS} statements of ${MULTI_ROWS_PER_STATEMENT} literal rows in one transaction (${MULTI_STATEMENTS * MULTI_ROWS_PER_STATEMENT} rows total).
- \`upsert\`: ${UPSERT_OPS} \`insert ... on conflict(id) do update\` statements in one transaction.
- \`update\` / \`delete\`: ${MUTATE_OPS} mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- \`rollback\`: begin + ${MUTATE_OPS} inserts + rollback (nothing persisted).
- \`open\`: open + close of the main file, no reads.
- \`@yydb/sqlite-unknown-wasm32\` is the in-memory SQL binding: it runs \`batch\` (inserts + snapshot export + file write), \`scan\`, \`point_sql\`, \`range\`, \`order_limit\`, \`group_by\` and \`join\` through \`exec\`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are \`n/a\`.

## Intentional deltas

- Our writer is snapshot-based: \`update\`/\`delete\` include the full-image \`save()\`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include \`export()\`.
- \`point_sql\` has no separate peer path — peers' prepared \`get\` is the reference.
- The wasm column reads the same in-memory image every round (\`SELECT\` re-scans the image; the binding has no seek), and its \`batch\` includes \`snapshot()\` + the file write.
- sql.js and the wasm binding do not run the six SQL-feature workloads (\`distinct\`, \`aggregate\`, \`subquery\`, \`index_range\`, \`insert_multi\`, \`upsert\`), so those cells stay \`n/a\`; they are compared only on \`node:sqlite\` and \`better-sqlite3\`.
- \`insert_multi\` and \`upsert\` on our side run on an in-memory \`new SQLite()\`, while the two peer columns write through their file pager; the row set is validated on both sides.
- The ten SQL-engine workloads (\`point_uk\`, \`order_limit\`, \`group_by\`, \`join\`, \`distinct\`, \`aggregate\`, \`subquery\`, \`index_range\`, \`insert_multi\`, \`upsert\`) run one untimed warmup round before \`BENCH_ROUNDS\` timed rounds; median/p95 come from the harness \`benchSummary\`, not local stats.
- \`batch\`, \`scan\`, \`point\`, \`range\`, \`update\`, \`delete\`, \`rollback\` and \`open\` still use the format-3 writer/reader primitives. The public \`SQLite\` entry does not expose raw record decoding, \`rowByRowid\`/\`range\` rowid windows, or the full-image \`save()\` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (\`rowByRowid\`) and inclusive rowid range read (\`range\`) without SQL parsing.
- Raw record decoding via a table cursor (\`openDatabase(...).table(...)\`) for \`scan\`.
- Writer-side \`update\`/\`delete\` slots and the explicit full-image \`save()\` that \`update\`/\`delete\`/\`batch\` include in their timings.
- Writer \`begin\`/\`rollback\` without SQL transaction control, used by \`rollback\`.
- A pure open/close handle over the main file with no statement preparation, used by \`open\`.

Regenerate: \`pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark\`
`;
  writeFileSync(join(exampleRoot, "reports", "benchmark.md"), report, "utf8");

  console.log(
    "Notes: baseline is node:sqlite (DatabaseSync). Batch/scan/open use the format-3 writer/reader for @yydb/sqlite vs peer file I/O. point uses the reader rowByRowid API; the SQL workloads use the public new SQLite() entry. BENCH_SYNCHRONOUS=on puts every library on synchronous=FULL. update/delete on our side include save(); sql.js includes export().",
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
  nodeFeatureSpace.dispose();
  betterFeatureSpace.dispose();
  wasmSpace.dispose();
}
