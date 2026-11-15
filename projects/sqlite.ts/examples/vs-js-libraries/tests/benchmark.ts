// Side-by-side throughput with `node:sqlite` (`DatabaseSync`) as baseline.
// Console + report show relative uplift/gap vs baseline only (same measurements underneath).
// Timing style matches `packages/sqlite-harness/src/bench/index.ts` (hrtime, median).
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (default 5000), BENCH_TXN (1000), BENCH_PAGE (4096), BENCH_ROUNDS (3),
//      BENCH_POINT (1000), BENCH_RANGE (200), BENCH_MUTATE (1000), BENCH_SYNCHRONOUS (off|on),
//      BENCH_LIMIT (200), BENCH_AGG (20), BENCH_JOIN (10), BENCH_DISTINCT (5), BENCH_SUBQUERY (20),
//      BENCH_MULTI (10), BENCH_UPSERT (500), BENCH_PROJECTION (10), BENCH_JOIN_INDEXED (10),
//      BENCH_SAVEPOINT (200), BENCH_REPLACE (500), BENCH_TRIGGER (500), BENCH_CASCADE (500)

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
const PROJECTION_OPS = Number(process.env.BENCH_PROJECTION ?? 10);
const JOIN_INDEXED_OPS = Number(process.env.BENCH_JOIN_INDEXED ?? 10);
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
// 非递归 CTE：子查询体先物化一次，再由外层聚合，测临时关系而非 IN 探测。
const CTE_SQL = `with c as (select id, label, score from items where score > ${SUBQUERY_THRESHOLD}) select count(*) as n from c`;
const INDEX_RANGE_LOWER = "row-1000";
const INDEX_RANGE_UPPER = "row-1499";
const INDEX_RANGE_SQL = `select id from items where label between '${INDEX_RANGE_LOWER}' and '${INDEX_RANGE_UPPER}' order by label`;
const UPSERT_SQL = "insert into items (id, label, score) values (?, ?, ?) on conflict(id) do update set score = excluded.score";
// 100 个散射 rowid：测 IN 列表的规划与谓词派发，而不是顺序游标。
const IN_LIST_SIZE = 100;
const IN_LIST_IDS: number[] = Array.from({ length: IN_LIST_SIZE }, (_, index) => ((index * 37) % ROWS) + 1);
const IN_LIST_ROWS = new Set(IN_LIST_IDS).size;
const IN_LIST_SQL = `select count(*) as n from items where id in (${IN_LIST_IDS.join(", ")})`;
// 无索引排序列：测排序 + 截断的真实代价。
const SORT_MIXED_SQL = `select id, label, score from items order by score desc, id desc limit ${ORDER_LIMIT_ROWS}`;
const SORT_MIXED_ROWS = Math.min(ORDER_LIMIT_ROWS, ROWS);
// 前缀 LIKE：无索引全表扫描上的模式匹配，只保留一个固定前缀字面量。
const LIKE_PREFIX_SQL = "select count(*) as n from items where label like 'row-1%'";
// 批量区间删除：一条语句删掉一段连续 rowid，随后在计时窗口外补回。
const RANGE_DELETE_LOWER = Math.max(1, Math.min(1_000, Math.floor(ROWS / 4)));
const RANGE_DELETE_UPPER = Math.min(RANGE_DELETE_LOWER + 999, ROWS);
const RANGE_DELETE_ROWS = Math.max(0, RANGE_DELETE_UPPER - RANGE_DELETE_LOWER + 1);
// 全表表达式更新：一条语句改写每一行，用于固定“逐行写路径 + 冲突判定”的成本。
const UPDATE_EXPR_SQL = "update items set score = score + 1";
// 每条 round 更新一次全表；写类 workload 与既有变速箱一致，不做额外预热。
const UPDATE_EXPR_RUNS = ROUNDS;
// 列投影：同一条全表扫描只取一列，与 `select *` 共用同一份数据。
const PROJECTION_NARROW_SQL = "select id from items";
const PROJECTION_WIDE_SQL = "select * from items";
// 索引列上的等值连接：`ON b.label = a.label`，外层只取前 20 行把内层扫描次数固定下来。
const JOIN_INDEXED_OUTER = 20;
const JOIN_INDEXED_SQL = `select count(*) as matched from items as a join items as b on b.label = a.label where a.id <= ${JOIN_INDEXED_OUTER}`;
// 索引列区间删除：与 delete_range 同形，但键落在有索引的 label 上。
const INDEX_DELETE_LOWER = "row-1000";
const INDEX_DELETE_UPPER = "row-1099";
// 被删掉的连续 rowid，计时窗口外按这个区间补回。
const INDEX_DELETE_ID_LOWER = 1_000;
const INDEX_DELETE_ID_UPPER = 1_099;
// 跨列 OR：一半行由整数列决定，一半由文本列决定，两侧都不能被单列下推吃掉。
const OR_FILTER_SQL = "select count(*) as n from items where id < 1000 or label > 'row-4500'";
// 带索引的批量插入：每条 row 都要维护一份二级索引键。
const INSERT_INDEXED_ROWS = Number(process.env.BENCH_INSERT_INDEXED ?? 2_000);
// 整表改写被索引列：一条语句让每个索引键都变化。
const UPDATE_INDEXED_SQL = "update items set label = 'u-' || id";
// 窗口函数：按分数桶分区、按 id 排序取行号。
const WINDOW_OPS = Number(process.env.BENCH_WINDOW ?? 5);
const WINDOW_SQL = "select id, row_number() over (partition by cast(score as integer) order by id) as rn from items";
// 左连接：与 join_indexed 同一个等值条件，但必须保留未匹配的左行。
const JOIN_LEFT_SQL = `select count(*) as matched from items as a left join items as b on b.label = a.label where a.id <= ${JOIN_INDEXED_OUTER}`;
// 相关 EXISTS：外层每行都要探一次内层，内层只保留前 100 个 rowid。
const EXISTS_INNER = 100;
const EXISTS_SQL = `select count(*) as n from items as a where exists (select 1 from items as b where b.label = a.label and b.id <= ${EXISTS_INNER})`;
// Savepoint churn：每个 op 开一个 savepoint、写一行、回滚到该点并释放，外层事务提交后一行不剩。
const SAVEPOINT_OPS = Number(process.env.BENCH_SAVEPOINT ?? 200);
const SAVEPOINT_INSERT_SQL = "insert into items (id, label, score) values (?, ?, ?)";
// INSERT OR REPLACE：冲突行走“删旧行再写新行”，与 upsert 的 ON CONFLICT 路径不同。
const REPLACE_OPS = Number(process.env.BENCH_REPLACE ?? 500);
// AFTER INSERT 触发器：每插入一行就多一次审计表写入。
const TRIGGER_ROWS = Number(process.env.BENCH_TRIGGER ?? 500);
const TRIGGER_ITEMS_DDL = "create table trigger_items (id integer primary key, label text, score real)";
const TRIGGER_AUDIT_DDL = "create table trigger_audit (item_id integer)";
const TRIGGER_DDL = "create trigger trigger_audit_ai after insert on trigger_items begin insert into trigger_audit (item_id) values (new.id); end";
const TRIGGER_INSERT_SQL = "insert into trigger_items (id, label, score) values (?, ?, ?)";
// 外键 ON DELETE CASCADE：删掉每个父行就连带删掉对应子行。
const CASCADE_ROWS = Number(process.env.BENCH_CASCADE ?? 500);
const CASCADE_PARENT_DDL = "create table cascade_parent (id integer primary key)";
const CASCADE_CHILD_DDL = "create table cascade_child (id integer primary key, pid integer references cascade_parent (id) on delete cascade)";
const CASCADE_DELETE_SQL = "delete from cascade_parent where id <= ?";
// 视图读取：视图体在每次 select 时重新执行。
const VIEW_DDL = "create view item_view as select id, label, score from items where score > 1000";
const VIEW_COUNT_SQL = "select count(*) as n from item_view";
// HAVING：分组聚合之后再过滤分组。
const HAVING_THRESHOLD = 1_000;
const HAVING_SQL = `select cast(score as integer) as bucket, sum(score) as total from items group by cast(score as integer) having sum(score) > ${HAVING_THRESHOLD}`;

function expectedLikePrefixRows(): number {
  let count = 0;
  for (let id = 1; id <= ROWS; id += 1) if (`row-${id}`.startsWith("row-1")) count += 1;
  return count;
}

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

/** `label between INDEX_DELETE_LOWER and INDEX_DELETE_UPPER` under BINARY collation. */
function expectedIndexDeleteRows(): number {
  let count = 0;
  for (let id = 1; id <= ROWS; id += 1) {
    const label = `row-${id}`;
    if (label >= INDEX_DELETE_LOWER && label <= INDEX_DELETE_UPPER) count += 1;
  }
  return count;
}

/** `where id < 1000 or label > 'row-4500'` under BINARY collation. */
function expectedOrFilterRows(): number {
  let count = 0;
  for (let id = 1; id <= ROWS; id += 1) {
    if (id < 1_000 || `row-${id}` > "row-4500") count += 1;
  }
  return count;
}

/** Groups of `cast(score as integer)` whose `sum(score)` clears the HAVING threshold. */
function expectedHavingGroups(): number {
  const totals = new Map<number, number>();
  for (let id = 1; id <= ROWS; id += 1) {
    const bucket = Math.floor(id / 4);
    totals.set(bucket, (totals.get(bucket) ?? 0) + id / 4);
  }
  let groups = 0;
  for (const total of totals.values()) if (total > HAVING_THRESHOLD) groups += 1;
  return groups;
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
  | "batch" | "batch_sql" | "scan" | "point" | "point_sql" | "point_param" | "point_uk" | "range" | "indexed"
  | "order_limit" | "group_by" | "join"
  | "distinct" | "aggregate" | "subquery" | "index_range" | "insert_multi" | "upsert" | "upsert_param"
  | "update" | "update_sql" | "update_idx" | "delete" | "delete_sql" | "delete_idx" | "txn" | "rollback" | "open"
  | "in_list" | "sort_mixed" | "like_prefix" | "delete_range" | "update_expr" | "cte"
  | "projection_narrow" | "projection_wide" | "join_indexed" | "delete_index_range" | "or_filter"
  | "insert_indexed" | "update_expr_idx" | "window_rank" | "join_left" | "exists_filter"
  | "savepoint" | "insert_replace" | "trigger_insert" | "fk_cascade" | "view_select" | "having";
const WORKLOADS: WorkloadKey[] = [
  "batch", "batch_sql", "scan", "point", "point_sql", "point_param", "point_uk", "range", "indexed",
  "order_limit", "group_by", "join",
  "distinct", "aggregate", "subquery", "index_range", "insert_multi", "upsert", "upsert_param",
  "update", "update_sql", "update_idx", "delete", "delete_sql", "delete_idx", "txn", "rollback", "open",
  "in_list", "sort_mixed", "like_prefix", "delete_range", "update_expr", "cte",
  "projection_narrow", "projection_wide", "join_indexed", "delete_index_range", "or_filter",
  "insert_indexed", "update_expr_idx", "window_rank", "join_left", "exists_filter",
  "savepoint", "insert_replace", "trigger_insert", "fk_cascade", "view_select", "having",
];

// Ops per workload for throughput normalization (batch/scan count rows; the rest count queries/mutations/opens).
function workloadOps(workload: WorkloadKey): number {
  if (workload === "batch" || workload === "batch_sql" || workload === "scan") return ROWS;
  if (workload === "range" || workload === "index_range") return RANGE_OPS;
  if (workload === "order_limit") return LIMIT_OPS;
  if (workload === "group_by" || workload === "aggregate" || workload === "in_list" || workload === "sort_mixed" || workload === "like_prefix" || workload === "or_filter" || workload === "exists_filter" || workload === "cte" || workload === "view_select" || workload === "having") {
    return AGG_OPS;
  }
  if (workload === "savepoint") return SAVEPOINT_OPS;
  if (workload === "insert_replace") return REPLACE_OPS;
  if (workload === "trigger_insert") return TRIGGER_ROWS;
  if (workload === "fk_cascade") return CASCADE_ROWS;
  if (workload === "projection_narrow" || workload === "projection_wide") return PROJECTION_OPS;
  if (workload === "join_indexed" || workload === "join_left") return JOIN_INDEXED_OPS;
  if (workload === "window_rank") return WINDOW_OPS;
  if (workload === "insert_indexed") return INSERT_INDEXED_ROWS;
  if (workload === "delete_index_range") return Math.max(1, expectedIndexDeleteRows());
  if (workload === "update_expr" || workload === "update_expr_idx") return ROWS;
  if (workload === "delete_range") return Math.max(1, RANGE_DELETE_ROWS);
  if (workload === "join") return JOIN_OPS;
  if (workload === "distinct") return DISTINCT_OPS;
  if (workload === "subquery") return SUBQUERY_OPS;
  if (workload === "insert_multi") return MULTI_STATEMENTS * MULTI_ROWS_PER_STATEMENT;
  if (workload === "upsert" || workload === "upsert_param") return UPSERT_OPS;
  if (
    workload === "update" || workload === "update_sql" || workload === "update_idx"
    || workload === "delete" || workload === "delete_sql" || workload === "delete_idx"
    || workload === "txn" || workload === "rollback"
  ) {
    return MUTATE_OPS;
  }
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

function nativeCte(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(CTE_SQL);
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n: number } | undefined;
      if (!row || Number(row.n) !== expected) throw new Error(`cte returned ${JSON.stringify(row)}, expected ${expected}`);
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

function nativeInList(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(IN_LIST_SQL);
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n: number } | undefined;
      if (!row || Number(row.n) !== IN_LIST_ROWS) throw new Error(`in_list returned ${JSON.stringify(row)}, expected ${IN_LIST_ROWS}`);
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

function nativeSortMixed(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(SORT_MIXED_SQL);
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = select.all();
      if (rows.length !== SORT_MIXED_ROWS) throw new Error(`sort_mixed returned ${rows.length}, expected ${SORT_MIXED_ROWS}`);
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

function nativeLikePrefix(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(LIKE_PREFIX_SQL);
  const expected = expectedLikePrefixRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n: number } | undefined;
      if (!row || Number(row.n) !== expected) throw new Error(`like_prefix returned ${JSON.stringify(row)}, expected ${expected}`);
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

function nativeProjection(
  factory: (path: string, readOnly?: boolean) => PeerHandle,
  path: string,
  sql: string,
  width: number,
): number[] {
  const database = factory(path, true);
  const select = database.prepare(sql);
  const run = () => {
    for (let op = 0; op < PROJECTION_OPS; op += 1) {
      const rows = select.all() as Record<string, unknown>[];
      if (rows.length !== ROWS) throw new Error(`projection returned ${rows.length}, expected ${ROWS}`);
      const columns = Object.keys(rows[0] ?? {}).length;
      if (columns !== width) throw new Error(`projection width ${columns}, expected ${width}`);
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

function nativeJoinIndexed(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const writable = factory(path);
  writable.exec("create index if not exists items_label on items(label)");
  writable.close();
  const database = factory(path, true);
  const select = database.prepare(JOIN_INDEXED_SQL);
  const run = () => {
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      const row = select.get() as { matched: number } | undefined;
      if (!row || Number(row.matched) !== JOIN_INDEXED_OUTER) {
        throw new Error(`join_indexed matched ${JSON.stringify(row)}, expected ${JOIN_INDEXED_OUTER}`);
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

function nativeOrFilter(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(OR_FILTER_SQL);
  const expected = expectedOrFilterRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n: number } | undefined;
      if (!row || Number(row.n) !== expected) throw new Error(`or_filter returned ${JSON.stringify(row)}, expected ${expected}`);
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

function peerDeleteIndexRange(factory: () => PeerHandle): number[] {
  const database = factory();
  database.exec("create table items (id integer primary key, label text, score real)");
  database.exec("create index items_label on items(label)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const remove = database.prepare("delete from items where label between ? and ?");
  database.exec("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
  database.exec("commit");
  const expected = expectedIndexDeleteRows();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    remove.run(INDEX_DELETE_LOWER, INDEX_DELETE_UPPER);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
    if (!count || Number(count.n) !== ROWS - expected) {
      throw new Error(`delete_index_range rows ${JSON.stringify(count)}, expected ${ROWS - expected}`);
    }
    database.exec("begin");
    for (let id = INDEX_DELETE_ID_LOWER; id <= INDEX_DELETE_ID_UPPER; id += 1) insert.run(id, `row-${id}`, id / 4);
    database.exec("commit");
  }
  database.close();
  return samples;
}

function nativeInsertIndexed(factory: () => PeerHandle): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory();
    database.exec("create table items (id integer primary key, label text, score real)");
    database.exec("create index items_label on items(label)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let row = 1; row <= INSERT_INDEXED_ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
    if (!count || Number(count.n) !== INSERT_INDEXED_ROWS) {
      throw new Error(`insert_indexed rows ${JSON.stringify(count)}, expected ${INSERT_INDEXED_ROWS}`);
    }
    const probe = database.prepare("select id from items where label = 'row-7'").get() as { id: number } | undefined;
    if (!probe || Number(probe.id) !== 7) throw new Error(`insert_indexed index miss: ${JSON.stringify(probe)}`);
    database.close();
  }
  return samples;
}

function nativeUpdateExprIndexed(factory: () => PeerHandle): number[] {
  const database = factory();
  database.exec("create table items (id integer primary key, label text, score real)");
  database.exec("create index items_label on items(label)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.exec("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
  database.exec("commit");
  const update = database.prepare(UPDATE_INDEXED_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    update.run();
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.prepare("select label from items where id = 1").get() as { label: string } | undefined;
  if (!row || row.label !== "u-1") throw new Error(`update_expr_idx did not rewrite the indexed column: ${JSON.stringify(row)}`);
  database.close();
  return samples;
}

function nativeWindow(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(WINDOW_SQL);
  const run = () => {
    for (let op = 0; op < WINDOW_OPS; op += 1) {
      const rows = select.all() as { id: number; rn: number }[];
      if (rows.length !== ROWS) throw new Error(`window_rank returned ${rows.length}, expected ${ROWS}`);
      const first = rows[0];
      if (!first || Number(first.id) !== 1 || Number(first.rn) !== 1) {
        throw new Error(`window_rank first row ${JSON.stringify(first)}, expected id 1 rn 1`);
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

function nativeJoinLeft(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const writable = factory(path);
  writable.exec("create index if not exists items_label on items(label)");
  writable.close();
  const database = factory(path, true);
  const select = database.prepare(JOIN_LEFT_SQL);
  const run = () => {
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      const row = select.get() as { matched: number } | undefined;
      if (!row || Number(row.matched) !== JOIN_INDEXED_OUTER) {
        throw new Error(`join_left matched ${JSON.stringify(row)}, expected ${JOIN_INDEXED_OUTER}`);
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

function nativeExists(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(EXISTS_SQL);
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n: number } | undefined;
      if (!row || Number(row.n) !== EXISTS_INNER) throw new Error(`exists_filter returned ${JSON.stringify(row)}, expected ${EXISTS_INNER}`);
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

function nativeSavepoint(factory: () => PeerHandle): number[] {
  const database = factory();
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare(SAVEPOINT_INSERT_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < SAVEPOINT_OPS; op += 1) {
      database.exec("savepoint sp1");
      insert.run(2_000_000 + op, `savepoint-${op}`, 0);
      database.exec("rollback to sp1");
      database.exec("release sp1");
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
  if (!count || Number(count.n) !== 0) throw new Error(`savepoint rows ${JSON.stringify(count)}, expected 0`);
  database.close();
  return samples;
}

function nativeInsertReplace(factory: () => PeerHandle): number[] {
  const database = factory();
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.exec("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
  database.exec("commit");
  const replace = database.prepare("insert or replace into items (id, label, score) values (?, ?, ?)");
  const run = () => {
    for (let op = 0; op < REPLACE_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      replace.run(id, `row-${id}`, 7.25);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    run();
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
  if (!count || Number(count.n) !== ROWS) throw new Error(`insert_replace rows ${JSON.stringify(count)}, expected ${ROWS}`);
  const row = database.prepare("select score from items where id = 1").get() as { score: number } | undefined;
  if (!row || Number(row.score) !== 7.25) throw new Error(`insert_replace did not replace: ${JSON.stringify(row)}`);
  database.close();
  return samples;
}

function nativeTriggerInsert(factory: () => PeerHandle): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory();
    database.exec(TRIGGER_ITEMS_DDL);
    database.exec(TRIGGER_AUDIT_DDL);
    database.exec(TRIGGER_DDL);
    const insert = database.prepare(TRIGGER_INSERT_SQL);
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let row = 1; row <= TRIGGER_ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const items = database.prepare("select count(*) as n from trigger_items").get() as { n: number } | undefined;
    const audit = database.prepare("select count(*) as n from trigger_audit").get() as { n: number } | undefined;
    if (!items || Number(items.n) !== TRIGGER_ROWS) throw new Error(`trigger_insert rows ${JSON.stringify(items)}, expected ${TRIGGER_ROWS}`);
    if (!audit || Number(audit.n) !== TRIGGER_ROWS) throw new Error(`trigger_insert audit ${JSON.stringify(audit)}, expected ${TRIGGER_ROWS}`);
    database.close();
  }
  return samples;
}

function nativeFkCascade(factory: () => PeerHandle): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory();
    database.exec("pragma foreign_keys = on");
    database.exec(CASCADE_PARENT_DDL);
    database.exec(CASCADE_CHILD_DDL);
    const insertParent = database.prepare("insert into cascade_parent (id) values (?)");
    const insertChild = database.prepare("insert into cascade_child (id, pid) values (?, ?)");
    database.exec("begin");
    for (let row = 1; row <= CASCADE_ROWS; row += 1) {
      insertParent.run(row);
      insertChild.run(row, row);
    }
    database.exec("commit");
    const remove = database.prepare(CASCADE_DELETE_SQL);
    const start = process.hrtime.bigint();
    database.exec("begin");
    remove.run(CASCADE_ROWS);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const parents = database.prepare("select count(*) as n from cascade_parent").get() as { n: number } | undefined;
    const children = database.prepare("select count(*) as n from cascade_child").get() as { n: number } | undefined;
    if (!parents || Number(parents.n) !== 0) throw new Error(`fk_cascade parents ${JSON.stringify(parents)}, expected 0`);
    if (!children || Number(children.n) !== 0) throw new Error(`fk_cascade children ${JSON.stringify(children)}, expected 0`);
    database.close();
  }
  return samples;
}

function nativeViewSelect(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const writable = factory(path);
  writable.exec(VIEW_DDL);
  writable.close();
  const database = factory(path, true);
  const select = database.prepare(VIEW_COUNT_SQL);
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = select.get() as { n: number } | undefined;
      if (!row || Number(row.n) !== expected) throw new Error(`view_select returned ${JSON.stringify(row)}, expected ${expected}`);
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

function nativeHaving(factory: (path: string, readOnly?: boolean) => PeerHandle, path: string): number[] {
  const database = factory(path, true);
  const select = database.prepare(HAVING_SQL);
  const expected = expectedHavingGroups();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = select.all() as { bucket: number; total: number }[];
      if (rows.length !== expected) throw new Error(`having returned ${rows.length} groups, expected ${expected}`);
      for (const row of rows) {
        if (Number(row.total) <= HAVING_THRESHOLD) throw new Error(`having kept ${JSON.stringify(row)}, expected total > ${HAVING_THRESHOLD}`);
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

function nativeUpdateExpr(factory: () => PeerHandle): number[] {
  const database = factory();
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.exec("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
  database.exec("commit");
  const update = database.prepare(UPDATE_EXPR_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    update.run();
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.prepare("select score from items where id = 1").get() as { score: number } | undefined;
  if (!row || Math.abs(Number(row.score) - (1 / 4 + UPDATE_EXPR_RUNS)) > 1e-6) {
    throw new Error(`update_expr did not increment every row: ${JSON.stringify(row)}`);
  }
  database.close();
  return samples;
}

function nativeDeleteRange(factory: () => PeerHandle): number[] {
  const database = factory();
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const remove = database.prepare("delete from items where id between ? and ?");
  const load = () => {
    database.exec("begin");
    for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
    database.exec("commit");
  };
  load();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    remove.run(RANGE_DELETE_LOWER, RANGE_DELETE_UPPER);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
    if (!count || Number(count.n) !== ROWS - RANGE_DELETE_ROWS) {
      throw new Error(`delete_range rows ${JSON.stringify(count)}, expected ${ROWS - RANGE_DELETE_ROWS}`);
    }
    database.exec("begin");
    for (let id = RANGE_DELETE_LOWER; id <= RANGE_DELETE_UPPER; id += 1) insert.run(id, `row-${id}`, id / 4);
    database.exec("commit");
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
// Additional public-API peer scenarios: bulk insert through SQL, transaction
// batching, and indexed-column writes. All run on an in-memory database so the
// pager's file publication does not decide the comparison.
// ---------------------------------------------------------------------------

function peerBatchSql(factory: () => PeerHandle): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory();
    database.exec("create table items (id integer primary key, label text, score real)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
    if (!count || Number(count.n) !== ROWS) throw new Error(`batch_sql rows ${JSON.stringify(count)}`);
    database.close();
  }
  return samples;
}

function peerTxn(factory: () => PeerHandle): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory();
    database.exec("create table items (id integer primary key, label text, score real)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    for (let row = 1; row <= MUTATE_OPS; row += 1) {
      if ((row - 1) % 10 === 0) database.exec("begin");
      insert.run(row, `txn-${row}`, row / 4);
      if (row % 10 === 0) database.exec("commit");
    }
    samples.push(elapsedMs(start));
    const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
    if (!count || Number(count.n) !== MUTATE_OPS) throw new Error(`txn rows ${JSON.stringify(count)}`);
    database.close();
  }
  return samples;
}

function peerIndexedWrite(factory: () => PeerHandle, kind: "update" | "delete"): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = factory();
    database.exec("create table items (id integer primary key, label text, score real)");
    database.exec("create index items_label on items(label)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    database.exec("begin");
    for (let row = 1; row <= ROWS; row += 1) insert.run(row, `row-${row}`, row / 4);
    database.exec("commit");
    const statement = kind === "update"
      ? database.prepare("update items set score = ? where label = ?")
      : database.prepare("delete from items where label = ?");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      const label = `row-${(op % ROWS) + 1}`;
      if (kind === "update") statement.run(7.25, label);
      else statement.run(label);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
    if (kind === "update") {
      const row = database.prepare("select score from items where label = 'row-1'").get() as { score: number } | undefined;
      if (!row || Number(row.score) !== 7.25) throw new Error(`update_idx missed: ${JSON.stringify(row)}`);
    }
    else {
      const count = database.prepare("select count(*) as n from items").get() as { n: number } | undefined;
      if (!count || Number(count.n) !== ROWS - MUTATE_OPS) throw new Error(`delete_idx rows ${JSON.stringify(count)}`);
    }
    database.close();
  }
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

function ourPointParam(): number[] {
  const database = buildDatabase();
  const select = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      if (select.get([id]) === undefined) throw new Error(`point_param miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  select.close();
  database.close();
  return samples;
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

function ourUpdateSql(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = buildDatabase();
    const update = database.prepare("update items set score = ? where id = ?");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) update.run([7.25, BigInt((op % ROWS) + 1)]);
    database.exec("commit");
    samples.push(elapsedMs(start));
    update.close();
    database.close();
  }
  return samples;
}

function ourDeleteSql(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = buildDatabase();
    const remove = database.prepare("delete from items where id = ?");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) remove.run([BigInt(op + 1)]);
    database.exec("commit");
    samples.push(elapsedMs(start));
    remove.close();
    database.close();
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

function ourCte(database: SQLite): number[] {
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = database.all<{ n: bigint }>(CTE_SQL);
      if (rows.length !== 1 || Number(rows[0].n) !== expected) {
        throw new Error(`cte returned ${JSON.stringify(rows)}, expected ${expected}`);
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

function ourInList(database: SQLite): number[] {
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = database.get<{ n: bigint }>(IN_LIST_SQL);
      if (!row || Number(row.n) !== IN_LIST_ROWS) throw new Error(`in_list returned ${JSON.stringify(row)}, expected ${IN_LIST_ROWS}`);
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

function ourSortMixed(database: SQLite): number[] {
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = database.all<{ id: bigint }>(SORT_MIXED_SQL);
      if (rows.length !== SORT_MIXED_ROWS) throw new Error(`sort_mixed returned ${rows.length}, expected ${SORT_MIXED_ROWS}`);
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

function ourLikePrefix(database: SQLite): number[] {
  const expected = expectedLikePrefixRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = database.get<{ n: bigint }>(LIKE_PREFIX_SQL);
      if (!row || Number(row.n) !== expected) throw new Error(`like_prefix returned ${JSON.stringify(row)}, expected ${expected}`);
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

function ourProjection(database: SQLite, sql: string, width: number): number[] {
  const run = () => {
    for (let op = 0; op < PROJECTION_OPS; op += 1) {
      const rows = database.all<Record<string, unknown>>(sql);
      if (rows.length !== ROWS) throw new Error(`projection returned ${rows.length}, expected ${ROWS}`);
      const columns = Object.keys(rows[0] ?? {}).length;
      if (columns !== width) throw new Error(`projection width ${columns}, expected ${width}`);
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

function ourJoinIndexed(): number[] {
  const database = buildDatabase("label");
  const run = () => {
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      const rows = database.all<{ matched: bigint }>(JOIN_INDEXED_SQL);
      const matched = Number(rows[0]?.matched);
      if (matched !== JOIN_INDEXED_OUTER) {
        throw new Error(`join_indexed matched ${matched}, expected ${JOIN_INDEXED_OUTER}`);
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

function ourOrFilter(database: SQLite): number[] {
  const expected = expectedOrFilterRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = database.get<{ n: bigint }>(OR_FILTER_SQL);
      if (!row || Number(row.n) !== expected) throw new Error(`or_filter returned ${JSON.stringify(row)}, expected ${expected}`);
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

function ourDeleteIndexRange(): number[] {
  const database = buildDatabase("label");
  const remove = database.prepare("delete from items where label between ? and ?");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const expected = expectedIndexDeleteRows();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    remove.run([INDEX_DELETE_LOWER, INDEX_DELETE_UPPER]);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.get<{ n: bigint }>("select count(*) as n from items");
    if (!count || Number(count.n) !== ROWS - expected) {
      throw new Error(`delete_index_range rows ${JSON.stringify(count)}, expected ${ROWS - expected}`);
    }
    database.transaction(() => {
      for (let id = INDEX_DELETE_ID_LOWER; id <= INDEX_DELETE_ID_UPPER; id += 1) {
        insert.run([BigInt(id), `row-${id}`, id / 4]);
      }
    });
  }
  remove.close();
  insert.close();
  database.close();
  return samples;
}

function ourInsertIndexed(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQLite();
    database.exec("create table items (id integer primary key, label text, score real)");
    database.exec("create index items_label on items (label)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    database.transaction(() => {
      for (let row = 1; row <= INSERT_INDEXED_ROWS; row += 1) insert.run([BigInt(row), `row-${row}`, row / 4]);
    });
    samples.push(elapsedMs(start));
    const count = database.get<{ n: bigint }>("select count(*) as n from items");
    if (!count || Number(count.n) !== INSERT_INDEXED_ROWS) {
      throw new Error(`insert_indexed rows ${JSON.stringify(count)}, expected ${INSERT_INDEXED_ROWS}`);
    }
    const probe = database.get<{ id: bigint }>("select id from items where label = 'row-7'");
    if (!probe || Number(probe.id) !== 7) throw new Error(`insert_indexed index miss: ${JSON.stringify(probe)}`);
    insert.close();
    database.close();
  }
  return samples;
}

function ourUpdateExprIndexed(): number[] {
  const database = buildDatabase("label");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    database.run(UPDATE_INDEXED_SQL);
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.get<{ label: string }>("select label from items where id = 1");
  if (!row || row.label !== "u-1") throw new Error(`update_expr_idx did not rewrite the indexed column: ${JSON.stringify(row)}`);
  database.close();
  return samples;
}

function ourWindow(database: SQLite): number[] {
  const run = () => {
    for (let op = 0; op < WINDOW_OPS; op += 1) {
      const rows = database.all<{ id: bigint; rn: bigint }>(WINDOW_SQL);
      if (rows.length !== ROWS) throw new Error(`window_rank returned ${rows.length}, expected ${ROWS}`);
      if (Number(rows[0]?.id) !== 1 || Number(rows[0]?.rn) !== 1) {
        throw new Error(`window_rank first row ${JSON.stringify(rows[0])}, expected id 1 rn 1`);
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

function ourJoinLeft(): number[] {
  const database = buildDatabase("label");
  const run = () => {
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      const rows = database.all<{ matched: bigint }>(JOIN_LEFT_SQL);
      const matched = Number(rows[0]?.matched);
      if (matched !== JOIN_INDEXED_OUTER) {
        throw new Error(`join_left matched ${matched}, expected ${JOIN_INDEXED_OUTER}`);
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

function ourExists(database: SQLite): number[] {
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = database.get<{ n: bigint }>(EXISTS_SQL);
      if (!row || Number(row.n) !== EXISTS_INNER) throw new Error(`exists_filter returned ${JSON.stringify(row)}, expected ${EXISTS_INNER}`);
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

function ourSavepoint(): number[] {
  const database = new SQLite();
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare(SAVEPOINT_INSERT_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < SAVEPOINT_OPS; op += 1) {
      database.exec("savepoint sp1");
      insert.run([BigInt(2_000_000 + op), `savepoint-${op}`, 0]);
      database.exec("rollback to sp1");
      database.exec("release sp1");
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const count = database.get<{ n: bigint }>("select count(*) as n from items");
  if (!count || Number(count.n) !== 0) throw new Error(`savepoint rows ${JSON.stringify(count)}, expected 0`);
  insert.close();
  database.close();
  return samples;
}

function ourInsertReplace(): number[] {
  const database = buildDatabase();
  const replace = database.prepare("insert or replace into items (id, label, score) values (?, ?, ?)");
  const run = () => {
    for (let op = 0; op < REPLACE_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      replace.run([BigInt(id), `row-${id}`, 7.25]);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    run();
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const count = database.get<{ n: bigint }>("select count(*) as n from items");
  if (!count || Number(count.n) !== ROWS) throw new Error(`insert_replace rows ${JSON.stringify(count)}, expected ${ROWS}`);
  const row = database.get<{ score: number }>("select score from items where id = 1");
  if (!row || Number(row.score) !== 7.25) throw new Error(`insert_replace did not replace: ${JSON.stringify(row)}`);
  replace.close();
  database.close();
  return samples;
}

function ourTriggerInsert(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQLite();
    database.exec(TRIGGER_ITEMS_DDL);
    database.exec(TRIGGER_AUDIT_DDL);
    database.exec(TRIGGER_DDL);
    const insert = database.prepare(TRIGGER_INSERT_SQL);
    const start = process.hrtime.bigint();
    database.transaction(() => {
      for (let row = 1; row <= TRIGGER_ROWS; row += 1) insert.run([BigInt(row), `row-${row}`, row / 4]);
    });
    samples.push(elapsedMs(start));
    const items = database.get<{ n: bigint }>("select count(*) as n from trigger_items");
    const audit = database.get<{ n: bigint }>("select count(*) as n from trigger_audit");
    if (!items || Number(items.n) !== TRIGGER_ROWS) throw new Error(`trigger_insert rows ${JSON.stringify(items)}, expected ${TRIGGER_ROWS}`);
    if (!audit || Number(audit.n) !== TRIGGER_ROWS) throw new Error(`trigger_insert audit ${JSON.stringify(audit)}, expected ${TRIGGER_ROWS}`);
    insert.close();
    database.close();
  }
  return samples;
}

function ourFkCascade(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQLite();
    database.pragma("foreign_keys", { value: true });
    database.exec(CASCADE_PARENT_DDL);
    database.exec(CASCADE_CHILD_DDL);
    const insertParent = database.prepare("insert into cascade_parent (id) values (?)");
    const insertChild = database.prepare("insert into cascade_child (id, pid) values (?, ?)");
    database.transaction(() => {
      for (let row = 1; row <= CASCADE_ROWS; row += 1) {
        insertParent.run([BigInt(row)]);
        insertChild.run([BigInt(row), BigInt(row)]);
      }
    });
    const remove = database.prepare(CASCADE_DELETE_SQL);
    const start = process.hrtime.bigint();
    database.exec("begin");
    remove.run([BigInt(CASCADE_ROWS)]);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const parents = database.get<{ n: bigint }>("select count(*) as n from cascade_parent");
    const children = database.get<{ n: bigint }>("select count(*) as n from cascade_child");
    if (!parents || Number(parents.n) !== 0) throw new Error(`fk_cascade parents ${JSON.stringify(parents)}, expected 0`);
    if (!children || Number(children.n) !== 0) throw new Error(`fk_cascade children ${JSON.stringify(children)}, expected 0`);
    insertParent.close();
    insertChild.close();
    remove.close();
    database.close();
  }
  return samples;
}

function ourViewSelect(): number[] {
  const database = buildDatabase();
  database.exec(VIEW_DDL);
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const row = database.get<{ n: bigint }>(VIEW_COUNT_SQL);
      if (!row || Number(row.n) !== expected) throw new Error(`view_select returned ${JSON.stringify(row)}, expected ${expected}`);
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

function ourHaving(database: SQLite): number[] {
  const expected = expectedHavingGroups();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = database.all<{ bucket: bigint; total: number }>(HAVING_SQL);
      if (rows.length !== expected) throw new Error(`having returned ${rows.length} groups, expected ${expected}`);
      for (const row of rows) {
        if (Number(row.total) <= HAVING_THRESHOLD) throw new Error(`having kept ${JSON.stringify(row)}, expected total > ${HAVING_THRESHOLD}`);
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

function ourUpdateExpr(): number[] {
  const database = buildDatabase();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    database.run(UPDATE_EXPR_SQL);
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.get<{ score: number }>("select score from items where id = 1");
  if (!row || Math.abs(Number(row.score) - (1 / 4 + UPDATE_EXPR_RUNS)) > 1e-6) {
    throw new Error(`update_expr did not increment every row: ${JSON.stringify(row)}`);
  }
  database.close();
  return samples;
}

function ourDeleteRange(): number[] {
  const database = buildDatabase();
  const remove = database.prepare("delete from items where id between ? and ?");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    remove.run([BigInt(RANGE_DELETE_LOWER), BigInt(RANGE_DELETE_UPPER)]);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const count = database.get<{ n: bigint }>("select count(*) as n from items");
    if (!count || Number(count.n) !== ROWS - RANGE_DELETE_ROWS) {
      throw new Error(`delete_range rows ${JSON.stringify(count)}, expected ${ROWS - RANGE_DELETE_ROWS}`);
    }
    database.transaction(() => {
      for (let id = RANGE_DELETE_LOWER; id <= RANGE_DELETE_UPPER; id += 1) {
        insert.run([BigInt(id), `row-${id}`, id / 4]);
      }
    });
  }
  remove.close();
  insert.close();
  database.close();
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

function ourUpsertParam(): number[] {
  const database = buildDatabase();
  const upsert = database.prepare(UPSERT_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < UPSERT_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      upsert.run([BigInt(id), `row-${id}`, 7.25]);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const row = database.get<{ score: number }>("select score from items where id = 1");
  if (!row || Number(row.score) !== 7.25) throw new Error(`upsert_param did not update: ${JSON.stringify(row)}`);
  upsert.close();
  database.close();
  return samples;
}

// ---------------------------------------------------------------------------
// `@yydb/sqlite` public-API counterparts of the peer scenarios above.
// ---------------------------------------------------------------------------

function ourBatchSql(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQLite();
    database.exec("create table items (id integer primary key, label text not null, score real)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    database.transaction(() => {
      for (let row = 1; row <= ROWS; row += 1) insert.run([BigInt(row), `row-${row}`, row / 4]);
    });
    samples.push(elapsedMs(start));
    const count = database.get<{ n: bigint }>("select count(*) as n from items");
    if (!count || Number(count.n) !== ROWS) throw new Error(`batch_sql rows ${JSON.stringify(count)}`);
    insert.close();
    database.close();
  }
  return samples;
}

function ourTxn(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQLite();
    database.exec("create table items (id integer primary key, label text not null, score real)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    for (let row = 1; row <= MUTATE_OPS; row += 1) {
      if ((row - 1) % 10 === 0) database.exec("begin");
      insert.run([BigInt(row), `txn-${row}`, row / 4]);
      if (row % 10 === 0) database.exec("commit");
    }
    samples.push(elapsedMs(start));
    const count = database.get<{ n: bigint }>("select count(*) as n from items");
    if (!count || Number(count.n) !== MUTATE_OPS) throw new Error(`txn rows ${JSON.stringify(count)}`);
    insert.close();
    database.close();
  }
  return samples;
}

function ourIndexedWrite(kind: "update" | "delete"): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = buildDatabase("label");
    const statement = kind === "update"
      ? database.prepare("update items set score = ? where label = ?")
      : database.prepare("delete from items where label = ?");
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      const label = `row-${(op % ROWS) + 1}`;
      if (kind === "update") statement.run([7.25, label]);
      else statement.run([label]);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
    if (kind === "update") {
      const row = database.get<{ score: number }>("select score from items where label = 'row-1'");
      if (!row || Number(row.score) !== 7.25) throw new Error(`update_idx missed: ${JSON.stringify(row)}`);
    }
    else {
      const count = database.get<{ n: bigint }>("select count(*) as n from items");
      if (!count || Number(count.n) !== ROWS - MUTATE_OPS) throw new Error(`delete_idx rows ${JSON.stringify(count)}`);
    }
    statement.close();
    database.close();
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

// sql.js counterparts of the in-memory peer scenarios: same DDL, same prepared
// statements, no serialization inside the timed window.

function sqlJsBatchSql(SQL: SqlJsStatic): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run("create table items (id integer primary key, label text, score real)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
    database.run("commit");
    samples.push(elapsedMs(start));
    const count = database.exec("select count(*) as n from items")[0]?.values[0]?.[0];
    if (Number(count) !== ROWS) throw new Error(`batch_sql rows ${count}`);
    insert.free();
    database.close();
  }
  return samples;
}

function sqlJsTxn(SQL: SqlJsStatic): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run("create table items (id integer primary key, label text, score real)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    for (let row = 1; row <= MUTATE_OPS; row += 1) {
      if ((row - 1) % 10 === 0) database.run("begin");
      insert.run([row, `txn-${row}`, row / 4]);
      if (row % 10 === 0) database.run("commit");
    }
    samples.push(elapsedMs(start));
    const count = database.exec("select count(*) as n from items")[0]?.values[0]?.[0];
    if (Number(count) !== MUTATE_OPS) throw new Error(`txn rows ${count}`);
    insert.free();
    database.close();
  }
  return samples;
}

function sqlJsIndexedWrite(SQL: SqlJsStatic, kind: "update" | "delete"): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run("create table items (id integer primary key, label text, score real)");
    database.run("create index items_label on items(label)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    database.run("begin");
    for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
    database.run("commit");
    insert.free();
    const statement = database.prepare(
      kind === "update" ? "update items set score = ? where label = ?" : "delete from items where label = ?",
    );
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let op = 0; op < MUTATE_OPS; op += 1) {
      const label = `row-${(op % ROWS) + 1}`;
      if (kind === "update") statement.run([7.25, label]);
      else statement.run([label]);
    }
    database.run("commit");
    samples.push(elapsedMs(start));
    if (kind === "update") {
      const score = database.exec("select score from items where label = 'row-1'")[0]?.values[0]?.[0];
      if (Number(score) !== 7.25) throw new Error(`update_idx missed: ${score}`);
    }
    else {
      const count = database.exec("select count(*) as n from items")[0]?.values[0]?.[0];
      if (Number(count) !== ROWS - MUTATE_OPS) throw new Error(`delete_idx rows ${count}`);
    }
    statement.free();
    database.close();
  }
  return samples;
}

function sqlJsProjection(SQL: SqlJsStatic, path: string, sql: string, width: number): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(sql);
  const run = () => {
    for (let op = 0; op < PROJECTION_OPS; op += 1) {
      let count = 0;
      let columns = 0;
      while (statement.step()) {
        const row = statement.getAsObject();
        if (count === 0) columns = Object.keys(row).length;
        count += 1;
      }
      statement.reset();
      if (count !== ROWS) throw new Error(`projection returned ${count}, expected ${ROWS}`);
      if (columns !== width) throw new Error(`projection width ${columns}, expected ${width}`);
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

function sqlJsJoinIndexed(SQL: SqlJsStatic): number[] {
  const database = new SQL.Database();
  database.run("create table items (id integer primary key, label text, score real)");
  database.run("create index items_label on items(label)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.run("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
  database.run("commit");
  insert.free();
  const statement = database.prepare(JOIN_INDEXED_SQL);
  const run = () => {
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      if (!statement.step()) throw new Error("join_indexed returned no row");
      const row = statement.getAsObject() as { matched?: number };
      if (Number(row.matched) !== JOIN_INDEXED_OUTER) {
        throw new Error(`join_indexed matched ${JSON.stringify(row)}, expected ${JOIN_INDEXED_OUTER}`);
      }
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

function sqlJsOrFilter(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(OR_FILTER_SQL);
  const expected = expectedOrFilterRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      if (!statement.step()) throw new Error("or_filter returned no row");
      const row = statement.getAsObject() as { n?: number };
      if (Number(row.n) !== expected) throw new Error(`or_filter returned ${JSON.stringify(row)}, expected ${expected}`);
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

function sqlJsDeleteIndexRange(SQL: SqlJsStatic): number[] {
  const database = new SQL.Database();
  database.run("create table items (id integer primary key, label text, score real)");
  database.run("create index items_label on items(label)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.run("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
  database.run("commit");
  insert.free();
  const remove = database.prepare("delete from items where label between ? and ?");
  const expected = expectedIndexDeleteRows();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.run("begin");
    remove.run([INDEX_DELETE_LOWER, INDEX_DELETE_UPPER]);
    database.run("commit");
    samples.push(elapsedMs(start));
    const count = database.exec("select count(*) as n from items")[0]?.values[0]?.[0];
    if (Number(count) !== ROWS - expected) throw new Error(`delete_index_range rows ${count}, expected ${ROWS - expected}`);
    const restore = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    database.run("begin");
    for (let id = INDEX_DELETE_ID_LOWER; id <= INDEX_DELETE_ID_UPPER; id += 1) restore.run([id, `row-${id}`, id / 4]);
    database.run("commit");
    restore.free();
  }
  remove.free();
  database.close();
  return samples;
}

function sqlJsInsertIndexed(SQL: SqlJsStatic): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run("create table items (id integer primary key, label text, score real)");
    database.run("create index items_label on items(label)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let row = 1; row <= INSERT_INDEXED_ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
    database.run("commit");
    samples.push(elapsedMs(start));
    insert.free();
    const count = database.exec("select count(*) as n from items")[0]?.values[0]?.[0];
    if (Number(count) !== INSERT_INDEXED_ROWS) throw new Error(`insert_indexed rows ${count}, expected ${INSERT_INDEXED_ROWS}`);
    const probe = database.exec("select id from items where label = 'row-7'")[0]?.values[0]?.[0];
    if (Number(probe) !== 7) throw new Error(`insert_indexed index miss: ${probe}`);
    database.close();
  }
  return samples;
}

function sqlJsUpdateExprIndexed(SQL: SqlJsStatic): number[] {
  const database = new SQL.Database();
  database.run("create table items (id integer primary key, label text, score real)");
  database.run("create index items_label on items(label)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.run("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
  database.run("commit");
  insert.free();
  const update = database.prepare(UPDATE_INDEXED_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.run("begin");
    update.step();
    update.reset();
    database.run("commit");
    samples.push(elapsedMs(start));
  }
  update.free();
  const label = database.exec("select label from items where id = 1")[0]?.values[0]?.[0];
  if (label !== "u-1") throw new Error(`update_expr_idx did not rewrite the indexed column: ${label}`);
  database.close();
  return samples;
}

function sqlJsWindow(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(WINDOW_SQL);
  const run = () => {
    for (let op = 0; op < WINDOW_OPS; op += 1) {
      let count = 0;
      let first: { id?: number; rn?: number } | undefined;
      while (statement.step()) {
        const row = statement.getAsObject() as { id?: number; rn?: number };
        if (count === 0) first = row;
        count += 1;
      }
      statement.reset();
      if (count !== ROWS) throw new Error(`window_rank returned ${count}, expected ${ROWS}`);
      if (Number(first?.id) !== 1 || Number(first?.rn) !== 1) {
        throw new Error(`window_rank first row ${JSON.stringify(first)}, expected id 1 rn 1`);
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
  statement.free();
  database.close();
  return samples;
}

function sqlJsJoinLeft(SQL: SqlJsStatic): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run("create table items (id integer primary key, label text, score real)");
    database.run("create index items_label on items(label)");
    const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
    database.run("begin");
    for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
    database.run("commit");
    insert.free();
    const statement = database.prepare(JOIN_LEFT_SQL);
    const start = process.hrtime.bigint();
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      if (!statement.step()) throw new Error("join_left returned no row");
      const row = statement.getAsObject() as { matched?: number };
      if (Number(row.matched) !== JOIN_INDEXED_OUTER) {
        throw new Error(`join_left matched ${JSON.stringify(row)}, expected ${JOIN_INDEXED_OUTER}`);
      }
      statement.reset();
    }
    samples.push(elapsedMs(start));
    statement.free();
    database.close();
  }
  return samples;
}

function sqlJsExists(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(EXISTS_SQL);
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      if (!statement.step()) throw new Error("exists_filter returned no row");
      const row = statement.getAsObject() as { n?: number };
      if (Number(row.n) !== EXISTS_INNER) throw new Error(`exists_filter returned ${JSON.stringify(row)}, expected ${EXISTS_INNER}`);
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

function sqlJsSavepoint(SQL: SqlJsStatic): number[] {
  const database = new SQL.Database();
  database.run("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare(SAVEPOINT_INSERT_SQL);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let op = 0; op < SAVEPOINT_OPS; op += 1) {
      database.run("savepoint sp1");
      insert.run([2_000_000 + op, `savepoint-${op}`, 0]);
      database.run("rollback to sp1");
      database.run("release sp1");
    }
    database.run("commit");
    samples.push(elapsedMs(start));
  }
  const rows = database.exec("select count(*) as n from items")[0]?.values ?? [];
  if (Number(rows[0]?.[0]) !== 0) throw new Error(`savepoint rows ${JSON.stringify(rows)}, expected 0`);
  insert.free();
  database.close();
  return samples;
}

function sqlJsInsertReplace(SQL: SqlJsStatic): number[] {
  const database = new SQL.Database();
  database.run("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  database.run("begin");
  for (let row = 1; row <= ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
  database.run("commit");
  insert.free();
  const replace = database.prepare("insert or replace into items (id, label, score) values (?, ?, ?)");
  const run = () => {
    for (let op = 0; op < REPLACE_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      replace.run([id, `row-${id}`, 7.25]);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.run("begin");
    run();
    database.run("commit");
    samples.push(elapsedMs(start));
  }
  const count = database.exec("select count(*) as n from items")[0]?.values ?? [];
  if (Number(count[0]?.[0]) !== ROWS) throw new Error(`insert_replace rows ${JSON.stringify(count)}, expected ${ROWS}`);
  const row = database.exec("select score from items where id = 1")[0]?.values ?? [];
  if (Number(row[0]?.[0]) !== 7.25) throw new Error(`insert_replace did not replace: ${JSON.stringify(row)}`);
  replace.free();
  database.close();
  return samples;
}

function sqlJsTriggerInsert(SQL: SqlJsStatic): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run(TRIGGER_ITEMS_DDL);
    database.run(TRIGGER_AUDIT_DDL);
    database.run(TRIGGER_DDL);
    const insert = database.prepare(TRIGGER_INSERT_SQL);
    const start = process.hrtime.bigint();
    database.run("begin");
    for (let row = 1; row <= TRIGGER_ROWS; row += 1) insert.run([row, `row-${row}`, row / 4]);
    database.run("commit");
    samples.push(elapsedMs(start));
    const items = database.exec("select count(*) as n from trigger_items")[0]?.values ?? [];
    const audit = database.exec("select count(*) as n from trigger_audit")[0]?.values ?? [];
    if (Number(items[0]?.[0]) !== TRIGGER_ROWS) throw new Error(`trigger_insert rows ${JSON.stringify(items)}, expected ${TRIGGER_ROWS}`);
    if (Number(audit[0]?.[0]) !== TRIGGER_ROWS) throw new Error(`trigger_insert audit ${JSON.stringify(audit)}, expected ${TRIGGER_ROWS}`);
    insert.free();
    database.close();
  }
  return samples;
}

function sqlJsFkCascade(SQL: SqlJsStatic): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new SQL.Database();
    database.run("pragma foreign_keys = on");
    database.run(CASCADE_PARENT_DDL);
    database.run(CASCADE_CHILD_DDL);
    const insertParent = database.prepare("insert into cascade_parent (id) values (?)");
    const insertChild = database.prepare("insert into cascade_child (id, pid) values (?, ?)");
    database.run("begin");
    for (let row = 1; row <= CASCADE_ROWS; row += 1) {
      insertParent.run([row]);
      insertChild.run([row, row]);
    }
    database.run("commit");
    insertParent.free();
    insertChild.free();
    const remove = database.prepare(CASCADE_DELETE_SQL);
    const start = process.hrtime.bigint();
    database.run("begin");
    remove.run([CASCADE_ROWS]);
    database.run("commit");
    samples.push(elapsedMs(start));
    const parents = database.exec("select count(*) as n from cascade_parent")[0]?.values ?? [];
    const children = database.exec("select count(*) as n from cascade_child")[0]?.values ?? [];
    if (Number(parents[0]?.[0]) !== 0) throw new Error(`fk_cascade parents ${JSON.stringify(parents)}, expected 0`);
    if (Number(children[0]?.[0]) !== 0) throw new Error(`fk_cascade children ${JSON.stringify(children)}, expected 0`);
    remove.free();
    database.close();
  }
  return samples;
}

function sqlJsViewSelect(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  database.run(VIEW_DDL);
  const statement = database.prepare(VIEW_COUNT_SQL);
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      if (!statement.step()) throw new Error("view_select returned no row");
      const row = statement.getAsObject() as { n?: number };
      if (Number(row.n) !== expected) throw new Error(`view_select returned ${JSON.stringify(row)}, expected ${expected}`);
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

function sqlJsHaving(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare(HAVING_SQL);
  const expected = expectedHavingGroups();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      let rows = 0;
      while (statement.step()) {
        const row = statement.getAsObject() as { total?: number };
        if (Number(row.total) <= HAVING_THRESHOLD) throw new Error(`having kept ${JSON.stringify(row)}, expected total > ${HAVING_THRESHOLD}`);
        rows += 1;
      }
      statement.reset();
      if (rows !== expected) throw new Error(`having returned ${rows} groups, expected ${expected}`);
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

// ---------------------------------------------------------------------------
// `@yydb/sqlite-unknown-wasm32` (in-memory SQL binding; no reader point API,
// no file open — unsupported workloads report `n/a`)
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

function wasmInList(database: WasmDatabase): number[] {
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, IN_LIST_SQL);
      if (Number(rows[0]?.[0]) !== IN_LIST_ROWS) throw new Error(`in_list returned ${JSON.stringify(rows)}, expected ${IN_LIST_ROWS}`);
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

function wasmSortMixed(database: WasmDatabase): number[] {
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, SORT_MIXED_SQL);
      if (rows.length !== SORT_MIXED_ROWS) throw new Error(`sort_mixed returned ${rows.length}, expected ${SORT_MIXED_ROWS}`);
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

function wasmLikePrefix(database: WasmDatabase): number[] {
  const expected = expectedLikePrefixRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, LIKE_PREFIX_SQL);
      if (Number(rows[0]?.[0]) !== expected) throw new Error(`like_prefix returned ${JSON.stringify(rows)}, expected ${expected}`);
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

function wasmProjection(database: WasmDatabase, sql: string, width: number): number[] {
  const run = () => {
    for (let op = 0; op < PROJECTION_OPS; op += 1) {
      const rows = wasmExecRows(database, sql);
      if (rows.length !== ROWS) throw new Error(`projection returned ${rows.length}, expected ${ROWS}`);
      const columns = rows[0]?.length ?? 0;
      if (columns !== width) throw new Error(`projection width ${columns}, expected ${width}`);
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

function wasmOrFilter(database: WasmDatabase): number[] {
  const expected = expectedOrFilterRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, OR_FILTER_SQL);
      if (Number(rows[0]?.[0]) !== expected) throw new Error(`or_filter returned ${JSON.stringify(rows)}, expected ${expected}`);
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

function wasmWindow(database: WasmDatabase): number[] {
  const run = () => {
    for (let op = 0; op < WINDOW_OPS; op += 1) {
      const rows = wasmExecRows(database, WINDOW_SQL);
      if (rows.length !== ROWS) throw new Error(`window_rank returned ${rows.length}, expected ${ROWS}`);
      if (Number(rows[0]?.[0]) !== 1 || Number(rows[0]?.[1]) !== 1) {
        throw new Error(`window_rank first row ${JSON.stringify(rows[0])}, expected id 1 rn 1`);
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

function wasmJoinLeft(database: WasmDatabase): number[] {
  const run = () => {
    for (let op = 0; op < JOIN_INDEXED_OPS; op += 1) {
      const rows = wasmExecRows(database, JOIN_LEFT_SQL);
      const matched = Number(rows[0]?.[0]);
      if (matched !== JOIN_INDEXED_OUTER) throw new Error(`join_left matched ${matched}, expected ${JOIN_INDEXED_OUTER}`);
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

function wasmExists(database: WasmDatabase): number[] {
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, EXISTS_SQL);
      if (Number(rows[0]?.[0]) !== EXISTS_INNER) throw new Error(`exists_filter returned ${JSON.stringify(rows)}, expected ${EXISTS_INNER}`);
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

function wasmSavepoint(): number[] {
  const database = new wasmMemoryDatabase!(PAGE_SIZE);
  database.exec("create table items (id integer primary key, label text, score real)");
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let op = 0; op < SAVEPOINT_OPS; op += 1) {
      database.exec("savepoint sp1");
      database.exec(`insert into items (id, label, score) values (${2_000_000 + op}, 'savepoint-${op}', 0)`);
      database.exec("rollback to sp1");
      database.exec("release sp1");
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const rows = wasmExecRows(database, "select count(*) as n from items");
  if (Number(rows[0]?.[0]) !== 0) throw new Error(`savepoint rows ${JSON.stringify(rows)}, expected 0`);
  database.free();
  return samples;
}

function wasmInsertReplace(): number[] {
  const database = wasmReadDatabase();
  const run = () => {
    for (let op = 0; op < REPLACE_OPS; op += 1) {
      const id = (op % ROWS) + 1;
      database.exec(`insert or replace into items (id, label, score) values (${id}, 'row-${id}', 7.25)`);
    }
  };
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    database.exec("begin");
    run();
    database.exec("commit");
    samples.push(elapsedMs(start));
  }
  const count = wasmExecRows(database, "select count(*) as n from items");
  if (Number(count[0]?.[0]) !== ROWS) throw new Error(`insert_replace rows ${JSON.stringify(count)}, expected ${ROWS}`);
  const row = wasmExecRows(database, "select score from items where id = 1");
  if (Number(row[0]?.[0]) !== 7.25) throw new Error(`insert_replace did not replace: ${JSON.stringify(row)}`);
  database.free();
  return samples;
}

function wasmTriggerInsert(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new wasmMemoryDatabase!(PAGE_SIZE);
    database.exec(TRIGGER_ITEMS_DDL);
    database.exec(TRIGGER_AUDIT_DDL);
    database.exec(TRIGGER_DDL);
    const start = process.hrtime.bigint();
    database.exec("begin");
    for (let row = 1; row <= TRIGGER_ROWS; row += 1) {
      database.exec(`insert into trigger_items (id, label, score) values (${row}, 'row-${row}', ${row / 4})`);
    }
    database.exec("commit");
    samples.push(elapsedMs(start));
    const items = wasmExecRows(database, "select count(*) as n from trigger_items");
    const audit = wasmExecRows(database, "select count(*) as n from trigger_audit");
    if (Number(items[0]?.[0]) !== TRIGGER_ROWS) throw new Error(`trigger_insert rows ${JSON.stringify(items)}, expected ${TRIGGER_ROWS}`);
    if (Number(audit[0]?.[0]) !== TRIGGER_ROWS) throw new Error(`trigger_insert audit ${JSON.stringify(audit)}, expected ${TRIGGER_ROWS}`);
    database.free();
  }
  return samples;
}

function wasmFkCascade(): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const database = new wasmMemoryDatabase!(PAGE_SIZE);
    database.exec("pragma foreign_keys = on");
    database.exec(CASCADE_PARENT_DDL);
    database.exec(CASCADE_CHILD_DDL);
    database.exec("begin");
    for (let row = 1; row <= CASCADE_ROWS; row += 1) {
      database.exec(`insert into cascade_parent (id) values (${row})`);
      database.exec(`insert into cascade_child (id, pid) values (${row}, ${row})`);
    }
    database.exec("commit");
    const start = process.hrtime.bigint();
    database.exec("begin");
    database.exec(`delete from cascade_parent where id <= ${CASCADE_ROWS}`);
    database.exec("commit");
    samples.push(elapsedMs(start));
    const parents = wasmExecRows(database, "select count(*) as n from cascade_parent");
    const children = wasmExecRows(database, "select count(*) as n from cascade_child");
    if (Number(parents[0]?.[0]) !== 0) throw new Error(`fk_cascade parents ${JSON.stringify(parents)}, expected 0`);
    if (Number(children[0]?.[0]) !== 0) throw new Error(`fk_cascade children ${JSON.stringify(children)}, expected 0`);
    database.free();
  }
  return samples;
}

function wasmViewSelect(database: WasmDatabase): number[] {
  database.exec(VIEW_DDL);
  const expected = expectedSubqueryRows();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, VIEW_COUNT_SQL);
      if (Number(rows[0]?.[0]) !== expected) throw new Error(`view_select returned ${JSON.stringify(rows)}, expected ${expected}`);
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

function wasmHaving(database: WasmDatabase): number[] {
  const expected = expectedHavingGroups();
  const run = () => {
    for (let op = 0; op < AGG_OPS; op += 1) {
      const rows = wasmExecRows(database, HAVING_SQL);
      if (rows.length !== expected) throw new Error(`having returned ${rows.length} groups, expected ${expected}`);
      for (const row of rows) {
        if (Number(row[1]) <= HAVING_THRESHOLD) throw new Error(`having kept ${JSON.stringify(row)}, expected total > ${HAVING_THRESHOLD}`);
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
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_TXN=${ROWS_PER_TXN}, BENCH_PAGE=${PAGE_SIZE}, BENCH_ROUNDS=${ROUNDS}, BENCH_POINT=${POINT_OPS}, BENCH_RANGE=${RANGE_OPS}, BENCH_MUTATE=${MUTATE_OPS}, BENCH_LIMIT=${LIMIT_OPS}, BENCH_AGG=${AGG_OPS}, BENCH_JOIN=${JOIN_OPS}, BENCH_SAVEPOINT=${SAVEPOINT_OPS}, BENCH_REPLACE=${REPLACE_OPS}, BENCH_TRIGGER=${TRIGGER_ROWS}, BENCH_CASCADE=${CASCADE_ROWS}, BENCH_SYNCHRONOUS=${SYNC}`,
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
    `- data: \`${ROWS}\` rows (page \`${PAGE_SIZE}\`), \`BENCH_ROUNDS=${ROUNDS}\`, point/indexed \`${POINT_OPS}\`, range \`${RANGE_OPS}\`, order_limit \`${LIMIT_OPS}\`, group_by \`${AGG_OPS}\`, join \`${JOIN_OPS}\`, distinct \`${DISTINCT_OPS}\`, subquery \`${SUBQUERY_OPS}\`, multi \`${MULTI_STATEMENTS}x${MULTI_ROWS_PER_STATEMENT}\`, upsert \`${UPSERT_OPS}\`, mutate \`${MUTATE_OPS}\`, projection \`${PROJECTION_OPS}\`, join_indexed \`${JOIN_INDEXED_OPS}\`, savepoint \`${SAVEPOINT_OPS}\`, replace \`${REPLACE_OPS}\`, trigger \`${TRIGGER_ROWS}\`, cascade \`${CASCADE_ROWS}\``,
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
    batch_sql: peerBatchSql(() => openNode(":memory:")),
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
    cte: nativeCte(openNode, nodeSpace.path),
    index_range: nativeIndexRange(openNode, nodeSpace.path),
    insert_multi: nativeInsertMulti(openNode, nodeFeatureSpace.path),
    upsert: nativeUpsert(openNode, nodeFeatureSpace.path),
    rollback: nativeRollback(openNode, nodeSpace.path),
    open: nativeOpen(openNode, nodeSpace.path),
    update: nativeUpdate(openNode, nodeMutateSpace.path),
    delete: nativeDelete(openNode, nodeDeleteSpace.path),
    txn: peerTxn(() => openNode(":memory:")),
    update_idx: peerIndexedWrite(() => openNode(":memory:"), "update"),
    delete_idx: peerIndexedWrite(() => openNode(":memory:"), "delete"),
    in_list: nativeInList(openNode, nodeSpace.path),
    sort_mixed: nativeSortMixed(openNode, nodeSpace.path),
    like_prefix: nativeLikePrefix(openNode, nodeSpace.path),
    update_expr: nativeUpdateExpr(() => openNode(":memory:")),
    delete_range: nativeDeleteRange(() => openNode(":memory:")),
    projection_narrow: nativeProjection(openNode, nodeSpace.path, PROJECTION_NARROW_SQL, 1),
    projection_wide: nativeProjection(openNode, nodeSpace.path, PROJECTION_WIDE_SQL, 3),
    join_indexed: nativeJoinIndexed(openNode, nodeSpace.path),
    or_filter: nativeOrFilter(openNode, nodeSpace.path),
    delete_index_range: peerDeleteIndexRange(() => openNode(":memory:")),
    insert_indexed: nativeInsertIndexed(() => openNode(":memory:")),
    update_expr_idx: nativeUpdateExprIndexed(() => openNode(":memory:")),
    window_rank: nativeWindow(openNode, nodeSpace.path),
    join_left: nativeJoinLeft(openNode, nodeSpace.path),
    exists_filter: nativeExists(openNode, nodeSpace.path),
    savepoint: nativeSavepoint(() => openNode(":memory:")),
    insert_replace: nativeInsertReplace(() => openNode(":memory:")),
    trigger_insert: nativeTriggerInsert(() => openNode(":memory:")),
    fk_cascade: nativeFkCascade(() => openNode(":memory:")),
    view_select: nativeViewSelect(openNode, nodeSpace.path),
    having: nativeHaving(openNode, nodeSpace.path),
  };
  nodeSamples.point_sql = nodeSamples.point;
  nodeSamples.point_param = nodeSamples.point;
  nodeSamples.update_sql = nodeSamples.update;
  nodeSamples.delete_sql = nodeSamples.delete;
  nodeSamples.upsert_param = nodeSamples.upsert;
  const baselineRates = ratesFromSamples(nodeSamples);

  // @yydb/sqlite.
  const oursSamples: Partial<Record<WorkloadKey, number[]>> = {
    batch: [ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path)],
    batch_sql: ourBatchSql(),
    scan: ourScan(oursSpace.path),
    point: ourPoint(oursSpace.path),
    point_sql: ourPointSql(),
    point_param: ourPointParam(),
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
  oursSamples.cte = ourCte(analyticDatabase);
  oursSamples.in_list = ourInList(analyticDatabase);
  oursSamples.sort_mixed = ourSortMixed(analyticDatabase);
  oursSamples.like_prefix = ourLikePrefix(analyticDatabase);
  oursSamples.projection_narrow = ourProjection(analyticDatabase, PROJECTION_NARROW_SQL, 1);
  oursSamples.projection_wide = ourProjection(analyticDatabase, PROJECTION_WIDE_SQL, 3);
  oursSamples.or_filter = ourOrFilter(analyticDatabase);
  oursSamples.window_rank = ourWindow(analyticDatabase);
  oursSamples.having = ourHaving(analyticDatabase);
  analyticDatabase.close();
  oursSamples.update_expr = ourUpdateExpr();
  oursSamples.delete_range = ourDeleteRange();
  oursSamples.join_indexed = ourJoinIndexed();
  oursSamples.join_left = ourJoinLeft();
  oursSamples.delete_index_range = ourDeleteIndexRange();
  oursSamples.insert_indexed = ourInsertIndexed();
  oursSamples.update_expr_idx = ourUpdateExprIndexed();
  const existsDatabase = buildDatabase("label");
  oursSamples.exists_filter = ourExists(existsDatabase);
  existsDatabase.close();
  oursSamples.index_range = ourIndexRange();
  oursSamples.insert_multi = ourInsertMulti();
  oursSamples.upsert = ourUpsert();
  oursSamples.upsert_param = ourUpsertParam();
  oursSamples.savepoint = ourSavepoint();
  oursSamples.insert_replace = ourInsertReplace();
  oursSamples.trigger_insert = ourTriggerInsert();
  oursSamples.fk_cascade = ourFkCascade();
  oursSamples.view_select = ourViewSelect();
  ourBatchLoad(oursMutateSpace.path);
  oursSamples.update = ourUpdate(oursMutateSpace.path);
  oursSamples.update_sql = ourUpdateSql();
  oursSamples.update_idx = ourIndexedWrite("update");
  oursSamples.delete = ourDelete(oursDeleteSpace.path);
  oursSamples.delete_sql = ourDeleteSql();
  oursSamples.delete_idx = ourIndexedWrite("delete");
  oursSamples.txn = ourTxn();
  const oursRates = ratesFromSamples(oursSamples);

  // better-sqlite3.
  const betterSamples: Partial<Record<WorkloadKey, number[]>> = {
    batch: [
      nativeBatchLoad(openBetter, betterSpace.path),
      nativeBatchLoad(openBetter, betterSpace.path),
      nativeBatchLoad(openBetter, betterSpace.path),
    ],
    batch_sql: peerBatchSql(() => openBetter(":memory:")),
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
    cte: nativeCte(openBetter, betterSpace.path),
    index_range: nativeIndexRange(openBetter, betterSpace.path),
    insert_multi: nativeInsertMulti(openBetter, betterFeatureSpace.path),
    upsert: nativeUpsert(openBetter, betterFeatureSpace.path),
    rollback: nativeRollback(openBetter, betterSpace.path),
    open: nativeOpen(openBetter, betterSpace.path),
    update: nativeUpdate(openBetter, betterMutateSpace.path),
    delete: nativeDelete(openBetter, betterDeleteSpace.path),
    txn: peerTxn(() => openBetter(":memory:")),
    update_idx: peerIndexedWrite(() => openBetter(":memory:"), "update"),
    delete_idx: peerIndexedWrite(() => openBetter(":memory:"), "delete"),
    in_list: nativeInList(openBetter, betterSpace.path),
    sort_mixed: nativeSortMixed(openBetter, betterSpace.path),
    like_prefix: nativeLikePrefix(openBetter, betterSpace.path),
    update_expr: nativeUpdateExpr(() => openBetter(":memory:")),
    delete_range: nativeDeleteRange(() => openBetter(":memory:")),
    projection_narrow: nativeProjection(openBetter, betterSpace.path, PROJECTION_NARROW_SQL, 1),
    projection_wide: nativeProjection(openBetter, betterSpace.path, PROJECTION_WIDE_SQL, 3),
    join_indexed: nativeJoinIndexed(openBetter, betterSpace.path),
    or_filter: nativeOrFilter(openBetter, betterSpace.path),
    delete_index_range: peerDeleteIndexRange(() => openBetter(":memory:")),
    insert_indexed: nativeInsertIndexed(() => openBetter(":memory:")),
    update_expr_idx: nativeUpdateExprIndexed(() => openBetter(":memory:")),
    window_rank: nativeWindow(openBetter, betterSpace.path),
    join_left: nativeJoinLeft(openBetter, betterSpace.path),
    exists_filter: nativeExists(openBetter, betterSpace.path),
    savepoint: nativeSavepoint(() => openBetter(":memory:")),
    insert_replace: nativeInsertReplace(() => openBetter(":memory:")),
    trigger_insert: nativeTriggerInsert(() => openBetter(":memory:")),
    fk_cascade: nativeFkCascade(() => openBetter(":memory:")),
    view_select: nativeViewSelect(openBetter, betterSpace.path),
    having: nativeHaving(openBetter, betterSpace.path),
  };
  betterSamples.point_sql = betterSamples.point;
  betterSamples.point_param = betterSamples.point;
  betterSamples.update_sql = betterSamples.update;
  betterSamples.delete_sql = betterSamples.delete;
  betterSamples.upsert_param = betterSamples.upsert;
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
    batch_sql: sqlJsBatchSql(SQL),
    txn: sqlJsTxn(SQL),
    update_idx: sqlJsIndexedWrite(SQL, "update"),
    delete_idx: sqlJsIndexedWrite(SQL, "delete"),
    projection_narrow: sqlJsProjection(SQL, sqlJsSpace.path, PROJECTION_NARROW_SQL, 1),
    projection_wide: sqlJsProjection(SQL, sqlJsSpace.path, PROJECTION_WIDE_SQL, 3),
    join_indexed: sqlJsJoinIndexed(SQL),
    or_filter: sqlJsOrFilter(SQL, sqlJsSpace.path),
    delete_index_range: sqlJsDeleteIndexRange(SQL),
    insert_indexed: sqlJsInsertIndexed(SQL),
    update_expr_idx: sqlJsUpdateExprIndexed(SQL),
    window_rank: sqlJsWindow(SQL, sqlJsSpace.path),
    join_left: sqlJsJoinLeft(SQL),
    exists_filter: sqlJsExists(SQL, sqlJsSpace.path),
    savepoint: sqlJsSavepoint(SQL),
    insert_replace: sqlJsInsertReplace(SQL),
    trigger_insert: sqlJsTriggerInsert(SQL),
    fk_cascade: sqlJsFkCascade(SQL),
    view_select: sqlJsViewSelect(SQL, sqlJsSpace.path),
    having: sqlJsHaving(SQL, sqlJsSpace.path),
  };
  sqlJsSamples.point_sql = sqlJsSamples.point;
  sqlJsSamples.point_param = sqlJsSamples.point;
  sqlJsSamples.update_sql = sqlJsSamples.update;
  sqlJsSamples.delete_sql = sqlJsSamples.delete;
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
    wasmSamples.in_list = wasmInList(readDatabase);
    wasmSamples.sort_mixed = wasmSortMixed(readDatabase);
    wasmSamples.like_prefix = wasmLikePrefix(readDatabase);
    wasmSamples.projection_narrow = wasmProjection(readDatabase, PROJECTION_NARROW_SQL, 1);
    wasmSamples.projection_wide = wasmProjection(readDatabase, PROJECTION_WIDE_SQL, 3);
    wasmSamples.or_filter = wasmOrFilter(readDatabase);
    wasmSamples.window_rank = wasmWindow(readDatabase);
    wasmSamples.join_left = wasmJoinLeft(readDatabase);
    wasmSamples.exists_filter = wasmExists(readDatabase);
    wasmSamples.view_select = wasmViewSelect(readDatabase);
    wasmSamples.having = wasmHaving(readDatabase);
    wasmSamples.savepoint = wasmSavepoint();
    wasmSamples.insert_replace = wasmInsertReplace();
    wasmSamples.trigger_insert = wasmTriggerInsert();
    wasmSamples.fk_cascade = wasmFkCascade();
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
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_TXN=${ROWS_PER_TXN}\`, \`BENCH_PAGE=${PAGE_SIZE}\`, \`BENCH_ROUNDS=${ROUNDS}\`, \`BENCH_POINT=${POINT_OPS}\`, \`BENCH_RANGE=${RANGE_OPS}\`, \`BENCH_MUTATE=${MUTATE_OPS}\`, \`BENCH_LIMIT=${LIMIT_OPS}\`, \`BENCH_AGG=${AGG_OPS}\`, \`BENCH_JOIN=${JOIN_OPS}\`, \`BENCH_DISTINCT=${DISTINCT_OPS}\`, \`BENCH_SUBQUERY=${SUBQUERY_OPS}\`, \`BENCH_MULTI=${MULTI_STATEMENTS}\`, \`BENCH_UPSERT=${UPSERT_OPS}\`, \`BENCH_SAVEPOINT=${SAVEPOINT_OPS}\`, \`BENCH_REPLACE=${REPLACE_OPS}\`, \`BENCH_TRIGGER=${TRIGGER_ROWS}\`, \`BENCH_CASCADE=${CASCADE_ROWS}\`, \`BENCH_SYNCHRONOUS=${SYNC}\`
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
- \`batch_sql\`: the same row set through the public \`new SQLite()\` entry — one prepared INSERT inside one transaction on an in-memory database, against the peers' equivalent. This is the bulk-insert path users actually call, separate from the writer primitive in \`batch\`.
- \`scan\`: open + full table scan per round.
- \`point\`: reader \`rowByRowid\` vs each peer's prepared \`get\`.
- \`point_sql\`: our public \`new SQLite()\` \`select ... where id = N\` vs the same peer prepared \`get\` (peer cells reuse \`point\`).
- \`point_param\`: the same point lookup through a prepared statement with a **bound** key (\`where id = ?\`); peer cells reuse \`point\`. This separates the literal pushdown in \`point_sql\` from the bound-parameter pushdown.
- \`point_uk\`: point lookup through a **unique** index on \`label\`; our side runs \`select ... where label = '...'\` on \`new SQLite()\` carrying \`create unique index\`, peers through their unique index (one untimed warmup round first).
- \`range\`: ${RANGE_WIDTH}-row \`between\` windows, reader \`range\` vs peers' prepared range.
- \`indexed\`: equality on an indexed \`label\` column; our side runs through \`new SQLite()\`, peers through their index.
- \`order_limit\`: \`select ... order by id limit ${ORDER_LIMIT_ROWS}\` — repeated ${LIMIT_OPS}x per round; separates the key-order scan constant from the per-statement fixed cost.
- \`group_by\`: \`select cast(score as integer), count(*) ... group by cast(score as integer)\` (${AGG_OPS} queries per round, ${expectedGroupBuckets()} groups over ${ROWS} rows).
- \`join\`: \`select count(*) from items join items as b on b.id = items.id % ${JOIN_MODULO}\` (${JOIN_OPS} queries per round, ${expectedJoinMatches()} matched pairs) — exposes a nested full scan of the inner side.
- \`distinct\`: \`select distinct label from items\` (${DISTINCT_OPS} queries per round, ${ROWS} distinct labels) — worst case for the dedup structure because nothing collapses.
- \`aggregate\`: \`select count(*), sum(score), min(score), max(score) from items\` (${AGG_OPS} queries per round) — single-pass aggregate without grouping.
- \`subquery\`: \`select count(*) ... where id in (select id from items where score > ${SUBQUERY_THRESHOLD})\` (${SUBQUERY_OPS} queries per round, ${expectedSubqueryRows()} matches) — uncorrelated \`IN\` subquery.
- \`cte\`: \`with c as (select id, label, score from items where score > ${SUBQUERY_THRESHOLD}) select count(*) from c\` (${AGG_OPS} queries per round, ${expectedSubqueryRows()} rows materialized) — non-recursive CTE materialization.
- \`having\`: \`select cast(score as integer), sum(score) ... group by cast(score as integer) having sum(score) > ${HAVING_THRESHOLD}\` (${AGG_OPS} queries per round, ${expectedHavingGroups()} groups kept) — the aggregate rows are filtered after grouping.
- \`view_select\`: \`create view item_view as select ... where score > 1000\`, then \`select count(*) from item_view\` (${AGG_OPS} queries per round, ${expectedSubqueryRows()} rows) — the view body is re-run on every read.
- \`in_list\`: \`select count(*) ... where id in (<${IN_LIST_SIZE} scattered rowids>)\` (${AGG_OPS} queries per round, ${IN_LIST_ROWS} matches) — literal \`IN\` list planning and predicate dispatch.
- \`sort_mixed\`: \`select ... order by score desc, id desc limit ${SORT_MIXED_ROWS}\` (${AGG_OPS} queries per round) — unindexed sort plus truncation.
- \`like_prefix\`: \`select count(*) ... where label like 'row-1%'\` (${AGG_OPS} queries per round, ${expectedLikePrefixRows()} matches) — prefix pattern over an unindexed full scan, with the row count asserted on every engine.
- \`projection_narrow\` / \`projection_wide\`: the same ${ROWS}-row scan projected to one column (\`select id\`) vs every column (\`select *\`), ${PROJECTION_OPS}x per round. The pair isolates per-column decoding and row-copy cost from the scan itself.
- \`join_indexed\`: \`select count(*) ... where a.id <= ${JOIN_INDEXED_OUTER} join ... on b.label = a.label\` (${JOIN_INDEXED_OPS} queries per round, ${JOIN_INDEXED_OUTER} matches) — the equality join runs on an indexed \`label\` column on every engine, so it measures the index probe instead of the nested scan in \`join\`.
- \`delete_index_range\`: one \`delete ... where label between '${INDEX_DELETE_LOWER}' and '${INDEX_DELETE_UPPER}'\` in a transaction on an in-memory database carrying the \`label\` index (${expectedIndexDeleteRows()} rows removed, the surviving count asserted), then the interval is re-inserted outside the timed window. This is the index-driven bulk delete path, against the rowid path in \`delete_range\`.
- \`or_filter\`: \`select count(*) ... where id < 1000 or label > 'row-4500'\` (${AGG_OPS} queries per round, ${expectedOrFilterRows()} matches) — a cross-column \`OR\` where neither side can be answered by a single-column pushdown.
- \`insert_indexed\`: ${INSERT_INDEXED_ROWS} prepared INSERTs into an in-memory table carrying a \`label\` index, one transaction (the secondary index has to be maintained per row), then the row count and one index lookup are asserted.
- \`update_expr_idx\`: one \`update items set label = 'u-' || id\` over every row of an indexed table in a transaction — every secondary key changes, so it pins index maintenance rather than the plain table write in \`update_expr\`.
- \`window_rank\`: \`select id, row_number() over (partition by cast(score as integer) order by id) from items\` (${WINDOW_OPS} queries per round, ${ROWS} rows in ${expectedGroupBuckets()} partitions) — window partitioning and ordering.
- \`join_left\`: the \`join_indexed\` equality as a \`LEFT JOIN\` (${JOIN_INDEXED_OPS} queries per round, ${JOIN_INDEXED_OUTER} matched left rows) — the outer path has to keep unmatched left rows instead of dropping them.
- \`exists_filter\`: \`select count(*) ... where exists (select 1 from items b where b.label = a.label and b.id <= ${EXISTS_INNER})\` (${AGG_OPS} queries per round, ${EXISTS_INNER} matches) — a correlated \`EXISTS\` probed once per outer row.
- \`delete_range\`: one \`delete from items where id between ${RANGE_DELETE_LOWER} and ${RANGE_DELETE_UPPER}\` in a transaction on an in-memory database (${RANGE_DELETE_ROWS} rows removed, the surviving count asserted), then the deleted interval is re-inserted outside the timed window. This is the bulk range-delete path rather than the per-rowid loop in \`delete\`/\`delete_sql\`.
- \`update_expr\`: one \`update items set score = score + 1\` over every row in a transaction (${ROWS} rows updated, \`score\` of row 1 asserted to include every run), then the next round updates again. This pins the whole-table write path and its per-row conflict detection instead of a single-rowid update.
- \`index_range\`: \`select id from items where label between '${INDEX_RANGE_LOWER}' and '${INDEX_RANGE_UPPER}' order by label\` (${RANGE_OPS} queries per round, ${expectedIndexRangeRows()} rows) — range predicate on an indexed column.
- \`insert_multi\`: ${MULTI_STATEMENTS} statements of ${MULTI_ROWS_PER_STATEMENT} literal rows in one transaction (${MULTI_STATEMENTS * MULTI_ROWS_PER_STATEMENT} rows total).
- \`upsert\`: ${UPSERT_OPS} \`insert ... on conflict(id) do update\` statements in one transaction.
- \`upsert_param\`: the same upsert through a prepared statement with bound values; peer cells reuse \`upsert\`. \`upsert\` re-parses interpolated SQL text, so the pair shows the parse cost separately from execution.
- \`insert_replace\`: ${REPLACE_OPS} \`insert or replace\` statements in one transaction over the seeded rows (row count and the rewritten \`score\` asserted) — the delete-then-insert conflict path instead of \`ON CONFLICT\`.
- \`trigger_insert\`: ${TRIGGER_ROWS} prepared INSERTs into an in-memory table carrying an \`AFTER INSERT\` trigger that writes one audit row each (both row counts asserted) — per-row trigger dispatch and the nested audit write.
- \`fk_cascade\`: \`delete from cascade_parent where id <= ${CASCADE_ROWS}\` on a database with foreign keys on and ${CASCADE_ROWS} parent/child pairs (both tables asserted empty) — \`ON DELETE CASCADE\` child removal per parent row.
- \`savepoint\`: begin + ${SAVEPOINT_OPS} iterations of \`savepoint sp1\` / one INSERT / \`rollback to sp1\` / \`release sp1\` + commit, asserting nothing persists — savepoint bookkeeping separate from the plain \`rollback\`.
- \`update\` / \`delete\`: ${MUTATE_OPS} mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- \`update_sql\` / \`delete_sql\`: ${MUTATE_OPS} prepared SQL mutations by bound rowid in one transaction on \`new SQLite()\`; peer cells reuse \`update\` / \`delete\`. These exercise the SQL write path (rowid narrowing) rather than the writer primitives.
- \`update_idx\` / \`delete_idx\`: ${MUTATE_OPS} prepared mutations by an **indexed** \`label\` column in one transaction, on an in-memory database with the same index on every engine. This covers the indexed write path (probe candidates instead of a full decode) and has no peer-cell reuse.
- \`txn\`: ${MUTATE_OPS} prepared INSERTs split into transactions of 10 (100 commits), on an in-memory database, so transaction boundaries rather than row count dominate.
- \`rollback\`: begin + ${MUTATE_OPS} inserts + rollback (nothing persisted).
- \`open\`: open + close of the main file, no reads.
- \`@yydb/sqlite-unknown-wasm32\` is the in-memory SQL binding: it runs \`batch\` (inserts + snapshot export + file write), \`scan\`, \`point_sql\`, \`range\`, \`order_limit\`, \`group_by\`, \`join\`, \`in_list\`, \`sort_mixed\`, \`like_prefix\`, \`projection_narrow\`, \`projection_wide\`, \`or_filter\`, \`view_select\`, \`having\`, \`savepoint\`, \`insert_replace\`, \`trigger_insert\` and \`fk_cascade\` through \`exec\`; it has no reader point API, no file open and no index-driven primitives, so the remaining cells are \`n/a\`.

## Intentional deltas

- Our writer is snapshot-based: \`update\`/\`delete\` include the full-image \`save()\`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include \`export()\`.
- \`point_sql\` has no separate peer path — peers' prepared \`get\` is the reference.
- The wasm column reads the same in-memory image every round (\`SELECT\` re-scans the image; the binding has no seek), and its \`batch\` includes \`snapshot()\` + the file write.
- sql.js does not run the SQL-feature workloads (\`distinct\`, \`aggregate\`, \`subquery\`, \`cte\`, \`index_range\`, \`insert_multi\`, \`upsert\`, \`in_list\`, \`sort_mixed\`, \`like_prefix\`, \`delete_range\`, \`update_expr\`), so those cells stay \`n/a\`; the wasm binding runs \`in_list\`, \`sort_mixed\`, \`like_prefix\`, \`projection_narrow\`, \`projection_wide\`, \`or_filter\`, \`window_rank\`, \`join_left\`, \`exists_filter\`, \`view_select\`, \`having\`, \`savepoint\`, \`insert_replace\`, \`trigger_insert\` and \`fk_cascade\`, but not the index-driven mutation primitives (\`insert_indexed\`, \`update_expr_idx\`, \`delete_index_range\`).
- \`insert_indexed\`, \`upsert\`, \`update_expr\`, \`update_expr_idx\`, \`delete_range\`, \`savepoint\`, \`insert_replace\`, \`trigger_insert\` and \`fk_cascade\` on our side run on an in-memory \`new SQLite()\`, while the two peer columns write through their pager; the row set is validated on both sides.
- \`batch_sql\`, \`update_idx\`, \`delete_idx\`, \`txn\`, \`update_expr\` and \`delete_range\` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the SQL ones through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays \`n/a\`.
- The SQL-engine workloads (\`point_param\`, \`point_uk\`, \`order_limit\`, \`group_by\`, \`join\`, \`distinct\`, \`aggregate\`, \`subquery\`, \`cte\`, \`having\`, \`view_select\`, \`in_list\`, \`sort_mixed\`, \`like_prefix\`, \`or_filter\`, \`projection_narrow\`, \`projection_wide\`, \`join_indexed\`, \`join_left\`, \`exists_filter\`, \`window_rank\`, \`insert_indexed\`, \`index_range\`, \`insert_multi\`, \`upsert\`, \`upsert_param\`, \`insert_replace\`, \`trigger_insert\`, \`fk_cascade\`, \`savepoint\`, \`update_sql\`, \`delete_sql\`, \`update_expr\`, \`update_expr_idx\`, \`delete_range\`, \`delete_index_range\`) run one untimed warmup round before \`BENCH_ROUNDS\` timed rounds; median/p95 come from the harness \`benchSummary\`, not local stats.
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
