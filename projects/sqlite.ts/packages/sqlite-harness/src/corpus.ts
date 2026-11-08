// `corpus` subcommand: a seeded deterministic differential corpus.
//
// Every generated statement runs on the same fixture in three engines:
// this repository's engine, `better-sqlite3` and CPython `sqlite3`. The two
// external engines decide the expected value. A statement they disagree on is
// discarded and reported as an oracle disagreement, never compared with this
// repository. Values that all three produce differently are mismatches and
// are reported with a minimal repro and the upstream facade coordinates.
//
// `--seed` and `--count` fully determine the run. No wall clock, no locale and
// no unseeded randomness takes part.
//
// Every case replays the fixture on a fresh engine and every oracle call opens
// a fresh in-memory database, so no case shares state with another case or
// with the hand-written gates. Running cases in any order or in parallel
// produces the same result.
//
// `--check` is the regression gate. It first verifies that the generated
// corpus still matches the baseline digest, then requires every observed
// difference to match one baseline entry exactly. `--update-baseline` rewrites
// the baseline from the current run and drops entries that no longer differ.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEngine, type ExecValue } from "../../sqlite/src/index.ts";
import { openEngine, type Cell, type Engine, type StepOutcome } from "./oracle.ts";
import { emit, renderTable, type CliOptions } from "./util.ts";

type Cluster = "ddl" | "dml" | "expression" | "aggregate" | "window" | "transaction";

interface CorpusCase {
  readonly id: number;
  readonly cluster: Cluster;
  readonly sql: string;
  readonly check?: string;
  readonly mode: "select" | "mutation";
  readonly tables: string[];
}

interface Spec {
  readonly sql: string;
  readonly check?: string;
  readonly mode?: "select" | "mutation";
  readonly tables?: string[];
}

interface Side {
  readonly rows?: string[][];
  readonly checkRows?: string[][];
  readonly error?: string;
}

const CLUSTERS: Array<{ name: Cluster; ratio: number }> = [
  { name: "ddl", ratio: 20 },
  { name: "dml", ratio: 20 },
  { name: "expression", ratio: 20 },
  { name: "aggregate", ratio: 15 },
  { name: "window", ratio: 15 },
  { name: "transaction", ratio: 10 },
];

const USERS_CREATE = "create table users (id integer primary key, name text, age integer, score real, grp integer, note text)";
const USERS_ROWS =
  "insert into users values (1, 'ada', 36, 9.5, 1, 'alpha'), (2, 'bob', 28, 7.25, 1, null), " +
  "(3, 'cy', 45, 8.0, 2, 'beta'), (4, 'dan', 19, 6.5, 2, ''), (5, 'eve', 52, 9.0, 3, 'gamma'), " +
  "(6, 'fay', 31, 7.75, 3, 'delta')";
const ORDERS_CREATE = "create table orders (id integer primary key, user_id integer, amount real, qty integer)";
const ORDERS_ROWS =
  "insert into orders values (1, 1, 120.5, 2), (2, 1, 80.0, 1), (3, 2, 15.25, 3), (4, 3, 200.0, 1), " +
  "(5, 3, 45.5, 2), (6, 5, 99.0, 1)";
const EMPTY_CREATE = "create table empty (v integer)";
const SCRATCH_CREATE = "create table scratch (a integer, b text)";
const USERS_AGE_INDEX = "create index users_age on users (age)";

const TABLES: Record<string, { create: string; rows: string[] }> = {
  users: { create: USERS_CREATE, rows: [USERS_ROWS] },
  orders: { create: ORDERS_CREATE, rows: [ORDERS_ROWS] },
  empty: { create: EMPTY_CREATE, rows: [] },
  scratch: { create: SCRATCH_CREATE, rows: [] },
};

// One fixture for every case. Every engine replays exactly these steps first.
const FIXTURE_STEPS = [
  USERS_CREATE,
  USERS_ROWS,
  ORDERS_CREATE,
  ORDERS_ROWS,
  EMPTY_CREATE,
  SCRATCH_CREATE,
  USERS_AGE_INDEX,
];

// Boundary values are generated on purpose. Random decimals almost never land
// on a rounding tie or a negative precision, and those are exactly the shapes
// that drift between engines. The first four expression cases are pinned to
// this list so a default run always exercises the boundaries.
const EDGE_EXPRESSIONS: Spec[] = [
  { sql: "select round(1.2345, 3)", tables: [] },
  { sql: "select round(123.456, -1)", tables: [] },
  { sql: "select round(1.005, 2), round(2.675, 2), round(-1.005, 2)", tables: [] },
  { sql: "select round(0.5), round(1.5), round(-0.5)", tables: [] },
  { sql: "select 9223372036854775807 + 1", tables: [] },
  { sql: "select 0.1 + 0.2, 5 / 2.0, -5 / 2", tables: [] },
  { sql: "select substr('abcdef', 0, 2), substr('abcdef', -2), substr('abcdef', 2, 0)", tables: [] },
  { sql: "select '10' < 9, '10' = 10, typeof('10' < 9)", tables: [] },
  { sql: "select cast(' 12 ' as integer), cast('0x10' as integer), cast('-0' as integer)", tables: [] },
  { sql: "select 1e20, 1e-7, -0.0", tables: [] },
];

const USERS_DUMP = "select id, name, age, score, grp, note from users order by id";
const SCRATCH_DUMP = "select a, b from scratch order by a, b";

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function distribute(count: number): Record<Cluster, number> {
  const result = {} as Record<Cluster, number>;
  const remainders: Array<{ name: Cluster; fraction: number; order: number }> = [];
  let assigned = 0;
  CLUSTERS.forEach((cluster, order) => {
    const exact = (count * cluster.ratio) / 100;
    result[cluster.name] = Math.floor(exact);
    assigned += result[cluster.name];
    remainders.push({ name: cluster.name, fraction: exact - Math.floor(exact), order });
  });
  remainders
    .sort((left, right) => right.fraction - left.fraction || left.order - right.order)
    .slice(0, count - assigned)
    .forEach((entry) => {
      result[entry.name] += 1;
    });
  return result;
}

function ddlSpec(random: () => number): Spec {
  const supported: Spec[] = [
    {
      sql: `create table probe (id integer primary key autoincrement, name text not null unique default 'x', score real check (score between 0 and ${between(random, 5, 10)}))`,
      check: "select count(*) from probe",
      tables: [],
    },
    { sql: "create table probe (a integer, b text, primary key (a, b))", check: "select count(*) from probe", tables: [] },
    {
      sql: "create table probe (id integer primary key, tag text unique, n integer default 7)",
      check: "select count(*) from sqlite_master where name = 'probe'",
      tables: [],
    },
    {
      sql: `create index probe on users (${pick(random, ["age", "score", "grp"])})`,
      check: "select count(*) from sqlite_master where name = 'probe'",
      tables: ["users"],
    },
    {
      sql: `alter table users add column extra_${between(random, 1, 3)} integer not null default ${between(random, 0, 9)}`,
      check: "select id, note from users order by id",
      tables: ["users"],
    },
    { sql: "drop index users_age", check: "select count(*) from sqlite_master where name = 'users_age'", tables: ["users"] },
    { sql: "drop table scratch", check: "select count(*) from sqlite_master where name = 'scratch'", tables: ["scratch"] },
  ];
  const unsupported: Spec[] = [
    { sql: "create temp table probe (a integer)", check: "select count(*) from probe", tables: [] },
    { sql: "create view probe as select id from users where age > 30", check: "select id from probe order by id", tables: ["users"] },
    {
      sql: "create trigger probe after insert on scratch begin insert into scratch values (1, 'x'); end",
      check: "select count(*) from scratch",
      tables: ["scratch"],
    },
    { sql: "create table probe (a text primary key) without rowid", check: "select count(*) from probe", tables: [] },
    { sql: "create table probe (a integer) strict", check: "select count(*) from probe", tables: [] },
    {
      sql: "create index probe on users (age) where age > 30",
      check: "select count(*) from sqlite_master where name = 'probe'",
      tables: ["users"],
    },
    {
      sql: "create index probe on users (age + 1)",
      check: "select count(*) from sqlite_master where name = 'probe'",
      tables: ["users"],
    },
    { sql: "alter table users drop column note", check: "select id from users order by id", tables: ["users"] },
  ];
  return pick(random, random() < 0.7 ? supported : unsupported);
}

function dmlSpec(random: () => number): Spec {
  const supported: Spec[] = [
    {
      sql: `insert into users values (${between(random, 7, 9)}, 'k${between(random, 1, 9)}', ${between(random, 18, 60)}, ${between(random, 5, 10)}.25, ${between(random, 1, 3)}, null)`,
      check: USERS_DUMP,
      tables: ["users"],
    },
    {
      sql: `insert into users (name, age) values ('n${between(random, 1, 9)}', ${between(random, 18, 60)})`,
      check: USERS_DUMP,
      tables: ["users"],
    },
    { sql: "insert into scratch default values", check: SCRATCH_DUMP, tables: ["scratch"] },
    {
      sql: `insert into users (name, age, grp) values ('r${between(random, 1, 9)}', ${between(random, 18, 60)}, ${between(random, 1, 3)}) returning id, name, age`,
      mode: "select",
      check: USERS_DUMP,
      tables: ["users"],
    },
    {
      sql: `update users set score = score + ${between(random, 0, 9) / 4} where grp = ${between(random, 1, 3)}`,
      check: USERS_DUMP,
      tables: ["users"],
    },
    {
      sql: `update users set age = age + ${between(random, 1, 5)} where id = ${between(random, 1, 6)} returning id, age`,
      mode: "select",
      check: USERS_DUMP,
      tables: ["users"],
    },
    { sql: "delete from users where age > 40 returning id, name", mode: "select", check: USERS_DUMP, tables: ["users"] },
    {
      sql: `delete from users where grp = ${between(random, 1, 3)}`,
      check: USERS_DUMP,
      tables: ["users"],
    },
    { sql: "delete from scratch as x where x.a = 1", check: SCRATCH_DUMP, tables: ["scratch"] },
  ];
  const unsupported: Spec[] = [
    { sql: "insert or replace into users values (1, 'z', 20, 1.0, 1, null)", check: USERS_DUMP, tables: ["users"] },
    {
      sql: "insert into users values (1, 'z', 20, 1.0, 1, null) on conflict (id) do update set age = excluded.age",
      check: USERS_DUMP,
      tables: ["users"],
    },
    { sql: "insert into users (name) select name from users where id = 1", check: USERS_DUMP, tables: ["users"] },
    { sql: "replace into users values (1, 'z', 20, 1.0, 1, null)", check: USERS_DUMP, tables: ["users"] },
    { sql: "insert into users values (1 + 1, 'z', 20, 1.0, 1, null)", check: USERS_DUMP, tables: ["users"] },
    { sql: "update users set name = orders.amount from orders where users.id = orders.user_id", check: USERS_DUMP, tables: ["users", "orders"] },
    { sql: "update users set (name, age) = ('z', 20) where id = 1", check: USERS_DUMP, tables: ["users"] },
  ];
  return pick(random, random() < 0.7 ? supported : unsupported);
}

function expressionSpec(random: () => number): Spec {
  const id = between(random, 1, 6);
  const supported: Array<() => Spec> = [
    () => ({ sql: `select ${between(random, -9, 9)} + ${between(random, -9, 9)} * ${between(random, 1, 9)} from users where id = ${id}`, tables: ["users"] }),
    () => ({ sql: `select (${between(random, 1, 9)} + ${between(random, 1, 9)}) * ${between(random, 1, 9)}, ${between(random, 1, 9)} - ${between(random, 1, 9)} - ${between(random, 1, 9)} from users where id = ${id}`, tables: ["users"] }),
    () => ({ sql: `select ${between(random, 1, 20)} / ${between(random, 1, 6)}, ${between(random, 0, 5)} / 0 from users where id = ${id}`, tables: ["users"] }),
    () => ({ sql: "select ~5, 5 & 3, 5 | 2, 5 << 1, -8 >> 1 from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select 'ab' || 'cd', 'a' || 1 || 2.5 from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select null = null, null is null, 2 between 1 and 3, null between 1 and 2 from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select true, false, true = 1, false = 0, 0x1f, 1e3 from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select cast('12abc' as integer), cast(1.9 as integer), cast('1.5' as real), typeof(1), typeof(1.5), typeof('x') from users where id = 1", tables: ["users"] }),
    () => ({
      sql: `select length('hello'), upper('ab'), lower('AB'), substr('abcdef', ${between(random, -3, 6)}, ${between(random, 0, 5)}) from users where id = 1`,
      tables: ["users"],
    }),
    () => ({ sql: "select abs(-7), coalesce(null, 7), round(2.5), round(-2.5) from users where id = 1", tables: ["users"] }),
    () => ({
      sql: `select round(${between(random, 0, 9)}.${between(random, 0, 9)}${between(random, 0, 9)}${between(random, 0, 9)}, ${between(random, -1, 3)}) from users where id = 1`,
      tables: ["users"],
    }),
    () => ({ sql: "select hex('abc'), quote('a''b'), quote(null), quote(1.5) from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select 'a_b' like 'a!_b' escape '!', 'abc' like 'A%' from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select case when 1 then 'a' else 'b' end, case 2 when 1 then 'a' when 2 then 'b' else 'c' end from users where id = 1", tables: ["users"] }),
    () => ({ sql: `select name, age, score from users where age >= ${between(random, 20, 50)} order by id`, tables: ["users"] }),
    () => ({ sql: "select id from users where age in (19, 36, 52) order by id", tables: ["users"] }),
    () => ({ sql: "select id, note from users where note is null", tables: ["users"] }),
    () => ({ sql: "select id, typeof(score), typeof(note) from users order by id", tables: ["users"] }),
    () => ({ sql: "select id, score from users order by score desc, id asc limit 3", tables: ["users"] }),
  ];
  const unsupported: Array<() => Spec> = [
    () => ({ sql: `select ${between(random, 1, 9)} % 3 from users where id = 1`, tables: ["users"] }),
    () => ({ sql: "select 'abc' glob 'a*' from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select 'a' = 'A' collate nocase from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select 1 is distinct from 2 from users where id = 1", tables: ["users"] }),
    () => ({ sql: "select distinct grp from users order by grp", tables: ["users"] }),
    () => ({ sql: "select id from users order by score nulls first", tables: ["users"] }),
  ];
  if (random() < 0.25) return pick(random, EDGE_EXPRESSIONS);
  const pool = random() < 0.8 ? supported : unsupported;
  return pick(random, pool)();
}

function aggregateSpec(random: () => number): Spec {
  const supported: Spec[] = [
    { sql: "select count(*), sum(age), avg(score), min(age), max(score), total(age) from users", tables: ["users"] },
    { sql: "select grp, count(*), sum(age) from users group by grp order by grp", tables: ["users"] },
    { sql: "select grp, avg(score), min(age) from users group by grp having count(*) > 1 order by grp", tables: ["users"] },
    { sql: "select count(*) from empty", tables: ["empty"] },
    { sql: "select avg(v), min(v), max(v), count(v) from empty", tables: ["empty"] },
    { sql: "select group_concat(name, '|') from users", tables: ["users"] },
    { sql: "select group_concat(v, '|') from empty", tables: ["empty"] },
    { sql: "select sum(age) from users where 0", tables: ["users"] },
  ];
  const unsupported: Spec[] = [
    { sql: "select count(distinct grp) from users", tables: ["users"] },
    { sql: "select sum(age) filter (where age > 30) from users", tables: ["users"] },
    { sql: "select group_concat(name, '|' order by name) from users", tables: ["users"] },
    { sql: "select min(3, 1, 2), max(3, 1, 2)", tables: [] },
    { sql: `select grp, sum(age) from users group by grp having sum(age) > ${between(random, 40, 90)} order by grp`, tables: ["users"] },
  ];
  return pick(random, random() < 0.8 ? supported : unsupported);
}

function windowSpec(random: () => number): Spec {
  const supported: Spec[] = [
    { sql: "select id, row_number() over (partition by grp order by score) from users order by id", tables: ["users"] },
    { sql: "select id, rank() over (order by age), dense_rank() over (order by age) from users order by id", tables: ["users"] },
    { sql: "select id, lag(age, 1, 99) over (order by id), lead(age, 1, -1) over (order by id) from users order by id", tables: ["users"] },
    { sql: "select id, first_value(age) over (order by score), last_value(age) over (order by score), nth_value(age, 2) over (order by score) from users order by id", tables: ["users"] },
    { sql: "select id, sum(age) over (partition by grp) from users order by id", tables: ["users"] },
    {
      sql: `select id, sum(age) over (order by id rows between ${between(random, 1, 2)} preceding and ${between(random, 0, 2)} following) from users order by id`,
      tables: ["users"],
    },
    {
      sql: `select id, sum(age) over (order by age range between ${between(random, 1, 3)} preceding and ${between(random, 1, 3)} following) from users order by id`,
      tables: ["users"],
    },
    { sql: "select id, count(*) over (), sum(age) over () from users order by id", tables: ["users"] },
    { sql: "select id, percent_rank() over (order by score), cume_dist() over (order by score), ntile(2) over (order by score) from users order by id", tables: ["users"] },
    { sql: "select id, row_number() over (order by score) from empty", tables: ["empty"] },
  ];
  const unsupported: Spec[] = [
    { sql: "select id, sum(age) over (order by id groups between 1 preceding and current row) from users order by id", tables: ["users"] },
    {
      sql: "select id, sum(age) over (order by id rows between 1 preceding and 1 following exclude ties) from users order by id",
      tables: ["users"],
    },
  ];
  return pick(random, random() < 0.85 ? supported : unsupported);
}

function transactionSpec(random: () => number): Spec {
  const statements = ["begin", "begin immediate", "begin exclusive", "commit", "rollback", "savepoint sp1", "release sp1", "rollback to sp1"];
  return { sql: pick(random, statements), tables: [] };
}

const BUILDERS: Record<Cluster, (random: () => number) => Spec> = {
  ddl: ddlSpec,
  dml: dmlSpec,
  expression: expressionSpec,
  aggregate: aggregateSpec,
  window: windowSpec,
  transaction: transactionSpec,
};

export function generate(seed: number, count: number): CorpusCase[] {
  const random = makeRng(seed);
  const counts = distribute(count);
  const cases: CorpusCase[] = [];
  let id = 1;
  for (const cluster of CLUSTERS) {
    for (let index = 0; index < counts[cluster.name]; index += 1) {
      const spec =
        cluster.name === "expression" && index % 10 === 0
          ? EDGE_EXPRESSIONS[(index / 10) % EDGE_EXPRESSIONS.length]
          : BUILDERS[cluster.name](random);
      const reads = cluster.name === "expression" || cluster.name === "aggregate" || cluster.name === "window";
      cases.push({
        id,
        cluster: cluster.name,
        sql: spec.sql,
        check: spec.check,
        mode: spec.mode ?? (reads ? "select" : "mutation"),
        tables: spec.tables ?? [],
      });
      id += 1;
    }
  }
  return cases;
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Number.isSafeInteger(value)) return BigInt(value).toString();
  return String(value);
}

function normCell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return `n:${numberText(value)}`;
  if (typeof value === "bigint") return `n:${value.toString()}`;
  if (typeof value === "boolean") return `n:${value ? "1" : "0"}`;
  if (typeof value === "string") return `t:${value}`;
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString("hex")}`;
  const cell = value as Cell | ExecValue;
  if (typeof cell === "object" && cell !== null) {
    if ("i" in cell && typeof cell.i === "string") return `n:${cell.i}`;
    if ("r" in cell && typeof cell.r === "string") return `n:${numberText(Number(cell.r))}`;
    if ("t" in cell && typeof cell.t === "string") return `t:${cell.t}`;
    if ("b" in cell && typeof cell.b === "string") return `b:${cell.b}`;
    if ("$blob" in cell && typeof cell.$blob === "string") return `b:${cell.$blob}`;
  }
  return `t:${String(value)}`;
}

function normRows(rows: readonly unknown[][]): string[][] {
  return rows.map((row) => row.map(normCell));
}

function oursError(error: { code: string; clause?: string | null; message: string } | undefined): string {
  if (!error) return "unknown error";
  return error.clause ? `${error.code} [${error.clause}] ${error.message}` : `${error.code} ${error.message}`;
}

function runOurs(fixture: readonly string[], item: CorpusCase): Side {
  const engine = createEngine(4096);
  try {
    for (const step of fixture) engine.execute(step);
    const result = engine.tryExecute(item.sql);
    if (!result.ok) return { error: oursError(result.error) };
    const side: { rows?: string[][]; checkRows?: string[][] } = {};
    if (item.mode === "select") side.rows = normRows(result.result?.rows ?? []);
    if (item.check) {
      const checked = engine.tryExecute(item.check);
      if (!checked.ok) return { error: `check failed: ${oursError(checked.error)}` };
      side.checkRows = normRows(checked.result?.rows ?? []);
    }
    return side;
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function oracleSide(outcome: StepOutcome): Side {
  if (outcome.error) return { error: outcome.error };
  return { rows: normRows(outcome.rows ?? []) };
}

async function runOracle(engine: Engine, fixture: readonly string[], item: CorpusCase): Promise<Side> {
  const steps = [...fixture, item.sql, ...(item.check ? [item.check] : [])];
  const outcomes = await engine.run(steps.map((sql) => ({ sql })));
  const offset = fixture.length;
  const main = outcomes[offset];
  if (!main) return { error: "oracle returned no outcome" };
  if (main.error) return { error: main.error };
  const side: { rows?: string[][]; checkRows?: string[][] } = {};
  if (item.mode === "select") side.rows = normRows(main.rows ?? []);
  if (item.check) {
    const check = outcomes[offset + 1];
    if (!check) return { error: "oracle returned no check outcome" };
    if (check.error) return { error: `check failed: ${check.error}` };
    side.checkRows = normRows(check.rows ?? []);
  }
  return side;
}

function rowsText(side: Side): string {
  if (side.error) return `error ${side.error}`;
  const parts: string[] = [];
  if (side.rows) parts.push(`rows ${JSON.stringify(side.rows)}`);
  if (side.checkRows) parts.push(`check ${JSON.stringify(side.checkRows)}`);
  return parts.length > 0 ? parts.join(" / ") : "no rows";
}

function sameSide(left: Side, right: Side): boolean {
  if (left.error || right.error) return Boolean(left.error) === Boolean(right.error);
  return JSON.stringify(left.rows ?? null) === JSON.stringify(right.rows ?? null) &&
    JSON.stringify(left.checkRows ?? null) === JSON.stringify(right.checkRows ?? null);
}

function minimalRepro(item: CorpusCase): string {
  const parts: string[] = [];
  for (const table of item.tables) {
    const definition = TABLES[table];
    if (definition) parts.push(definition.create, ...definition.rows);
  }
  if (/users_age/.test(item.sql) && !item.tables.includes("users_age")) parts.push(USERS_AGE_INDEX);
  parts.push(item.sql);
  if (item.check) parts.push(item.check);
  return parts.join("; ");
}

function coordinates(item: CorpusCase): string {
  if (item.cluster === "transaction") return "sql.rs:2769-2858 (statement dispatch), engine.rs:451 (run_statement)";
  if (/\bround\s*\(/i.test(item.sql)) return "engine.rs:5540-5565 (round_cell)";
  if (/\s%\s/.test(item.sql)) return "sql.rs:2139-2181 (multiplicative_expr)";
  if (/\bglob\b/i.test(item.sql)) return "sql.rs:2004-2138 (comparison_expr)";
  if (/\bcollate\b/i.test(item.sql)) return "sql.rs:2004-2138 (comparison_expr)";
  if (/\bdistinct\b/i.test(item.sql)) return "sql.rs:3703-3932 (select_core)";
  if (/\bfilter\s*\(/i.test(item.sql)) return "sql.rs:2315-2387 (function_expr)";
  if (/\bcount\s*\(\s*distinct\b/i.test(item.sql)) return "sql.rs:2315-2387 (function_expr)";
  if (/\b(group_concat|group\s+concat)\b/i.test(item.sql)) return "sql.rs:2315-2387 (function_expr)";
  if (/\bmin\s*\([^)]*,[^)]*\)/i.test(item.sql)) return "sql.rs:2315-2387 (function_expr)";
  if (/\b(groups|exclude)\b/i.test(item.sql)) return "sql.rs:2499-2556 (window_spec)";
  if (/\b(temp|view|trigger)\b/i.test(item.sql)) return "sql.rs:2769-2858 (statement dispatch)";
  if (/\b(without\s+rowid|strict)\b/i.test(item.sql)) return "sql.rs:2980-3420 (create_table)";
  if (/\bcreate\s+(unique\s+)?index\b/i.test(item.sql)) return "sql.rs:3085-3140 (create_index)";
  if (/\b(drop\s+column)\b/i.test(item.sql)) return "sql.rs:2897-2979 (alter_table)";
  if (/\b(on\s+conflict|or\s+(replace|ignore)|replace\s+into)\b/i.test(item.sql)) return "sql.rs:3450-3513 (insert)";
  if (/\b(nulls\s+(first|last))\b/i.test(item.sql)) return "sql.rs:2629-2639 (order_key)";
  if (item.cluster === "window") return "sql.rs:2499-2556 (window_spec)";
  if (item.cluster === "aggregate") return "sql.rs:2315-2387 (function_expr)";
  if (item.cluster === "ddl") return "sql.rs:2980 (create_table), sql.rs:3085 (create_index), sql.rs:2897 (alter_table)";
  if (item.cluster === "dml") return "sql.rs:3450 (insert), sql.rs:3590 (update), sql.rs:3618 (delete)";
  return "engine.rs:5351 (eval_function), sql.rs:3703 (select_core)";
}

function signature(item: CorpusCase): string {
  return `${item.cluster} ${item.sql.replace(/-?\d+(?:\.\d+)?/g, "#")}`;
}

// ---------------------------------------------------------------------------
// Baseline
//
// The baseline is the only allowed set of differences. Each entry names one
// case, why it is expected to differ and the exact signal observed when the
// baseline was generated. `--check` refuses to run when the corpus digest
// moved, and refuses to pass when an observed difference is unlisted, when a
// listed signal changed, or when a listed case stopped differing.

const DEFAULT_SEED = 20261106;
const DEFAULT_COUNT = 200;

const BASELINE_VERSION = 1;
const BASELINE_PATH = fileURLToPath(new URL("../corpus/sql-differential-baseline.json", import.meta.url));

type DifferenceKind = "mismatch" | "discarded";
type BaselineReason = "structured-rejection" | "not-implemented" | "known-drift" | "oracle-disagreement";

export interface BaselineEntry {
  readonly id: number;
  readonly cluster: Cluster;
  readonly sql: string;
  readonly check: string | null;
  readonly kind: DifferenceKind;
  readonly reason: BaselineReason;
  readonly detail: string;
  readonly coordinates: string;
  readonly signal: readonly string[];
}

export interface BaselineFile {
  readonly version: number;
  readonly seed: number;
  readonly count: number;
  readonly digest: string;
  readonly engines: Record<string, string>;
  readonly entries: readonly BaselineEntry[];
}

interface Discarded {
  readonly id: number;
  readonly cluster: Cluster;
  readonly sql: string;
  readonly better: Side;
  readonly python: Side;
}

interface Mismatch {
  readonly item: CorpusCase;
  readonly ours: Side;
  readonly better: Side;
  readonly python: Side;
}

export interface ObservedDifference {
  readonly id: number;
  readonly cluster: Cluster;
  readonly sql: string;
  readonly check: string | null;
  readonly kind: DifferenceKind;
  readonly entry: BaselineEntry;
  readonly ours?: Side;
  readonly better: Side;
  readonly python: Side;
}

export function entryKey(entry: BaselineEntry): string {
  return `${entry.kind}|${entry.id}|${entry.sql}`;
}

function rowDiffText(left: Side, right: Side): string {
  for (const field of ["rows", "checkRows"] as const) {
    const mine = left[field];
    const theirs = right[field];
    if (!mine || !theirs) continue;
    if (mine.length !== theirs.length) return `${field}: ${mine.length} rows vs ${theirs.length}`;
    for (let row = 0; row < mine.length; row += 1) {
      const width = Math.max(mine[row].length, theirs[row].length);
      for (let column = 0; column < width; column += 1) {
        const a = mine[row][column] ?? "<missing>";
        const b = theirs[row][column] ?? "<missing>";
        if (a !== b) return `${field} row ${row + 1} column ${column + 1}: ${a} vs ${b}`;
      }
    }
  }
  return "result shape differs";
}

function mismatchEntry(item: CorpusCase, ours: Side, better: Side, python: Side): BaselineEntry {
  const signal = [`ours ${rowsText(ours)}`, `better ${rowsText(better)}`, `python ${rowsText(python)}`];
  if (ours.error) {
    const code = ours.error.split(/\s+/)[0] ?? "";
    // Explicitly unimplemented clauses and statements carry an `unsupported-*`
    // code. Parse rejections and argument refusals are still structured but
    // are classified as plain structured rejections.
    const reason: BaselineReason = code.startsWith("unsupported") ? "not-implemented" : "structured-rejection";
    return {
      id: item.id,
      cluster: item.cluster,
      sql: item.sql,
      check: item.check ?? null,
      kind: "mismatch",
      reason,
      detail: `this repository rejects the statement: ${ours.error}`,
      coordinates: coordinates(item),
      signal,
    };
  }
  return {
    id: item.id,
    cluster: item.cluster,
    sql: item.sql,
    check: item.check ?? null,
    kind: "mismatch",
    reason: "known-drift",
    detail: `same result shape, different value: ${rowDiffText(ours, better)}`,
    coordinates: coordinates(item),
    signal,
  };
}

function discardedEntry(entry: Discarded): BaselineEntry {
  const detail =
    entry.cluster === "transaction"
      ? "CPython sqlite3 keeps the fixture inserts inside an implicit transaction while better-sqlite3 autocommits, so the transaction state differs"
      : "the two external oracles disagree with each other";
  return {
    id: entry.id,
    cluster: entry.cluster,
    sql: entry.sql,
    check: null,
    kind: "discarded",
    reason: "oracle-disagreement",
    detail,
    coordinates: "n/a (oracle self-disagreement)",
    signal: [`better ${rowsText(entry.better)}`, `python ${rowsText(entry.python)}`],
  };
}

function observedDifferences(discarded: Discarded[], mismatches: Mismatch[]): ObservedDifference[] {
  const observed: ObservedDifference[] = [];
  for (const entry of discarded) {
    observed.push({
      id: entry.id,
      cluster: entry.cluster,
      sql: entry.sql,
      check: null,
      kind: "discarded",
      entry: discardedEntry(entry),
      better: entry.better,
      python: entry.python,
    });
  }
  for (const entry of mismatches) {
    observed.push({
      id: entry.item.id,
      cluster: entry.item.cluster,
      sql: entry.item.sql,
      check: entry.item.check ?? null,
      kind: "mismatch",
      entry: mismatchEntry(entry.item, entry.ours, entry.better, entry.python),
      ours: entry.ours,
      better: entry.better,
      python: entry.python,
    });
  }
  return observed;
}

function baselineFrom(
  seed: number,
  count: number,
  digest: string,
  engines: Record<string, string>,
  entries: BaselineEntry[],
): BaselineFile {
  const ordered = [...entries].sort((left, right) => left.id - right.id || left.kind.localeCompare(right.kind));
  return { version: BASELINE_VERSION, seed, count, digest, engines, entries: ordered };
}

export function loadBaseline(): BaselineFile {
  let parsed: BaselineFile;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
  } catch (error) {
    throw new Error(`cannot read the differential baseline at ${BASELINE_PATH}: ${(error as Error).message}`);
  }
  if (parsed.version !== BASELINE_VERSION) {
    throw new Error(`baseline version ${parsed.version} is not supported, expected ${BASELINE_VERSION}`);
  }
  return parsed;
}

export function identityProblems(baseline: BaselineFile, options: CorpusOptions, digest: string): string[] {
  const problems: string[] = [];
  if (baseline.seed !== options.seed) problems.push(`seed: baseline ${baseline.seed}, current ${options.seed}`);
  if (baseline.count !== options.count) problems.push(`count: baseline ${baseline.count}, current ${options.count}`);
  if (baseline.digest !== digest) problems.push(`corpus digest: baseline ${baseline.digest}, current ${digest}`);
  return problems;
}

function describeOutput(diff: ObservedDifference): string[] {
  const lines = [`#${diff.id} [${diff.cluster}] ${diff.sql}`];
  if (diff.check) lines.push(`  check:  ${diff.check}`);
  if (diff.ours) lines.push(`  ours:   ${rowsText(diff.ours)}`);
  lines.push(`  better: ${rowsText(diff.better)}`);
  lines.push(`  python: ${rowsText(diff.python)}`);
  return lines;
}

export function checkBaseline(baseline: BaselineFile, observed: ObservedDifference[]): { problems: string[]; matched: number } {
  const listed = new Map(baseline.entries.map((entry) => [entryKey(entry), entry]));
  const seen = new Set<string>();
  const problems: string[] = [];
  let matched = 0;
  for (const diff of observed) {
    const key = entryKey(diff.entry);
    seen.add(key);
    const expected = listed.get(key);
    if (!expected) {
      problems.push(
        [
          "unexpected difference that the known-difference baseline does not explain",
          ...describeOutput(diff),
          `  coordinates: ${diff.entry.coordinates}`,
        ].join("\n"),
      );
      continue;
    }
    if (JSON.stringify(expected.signal) !== JSON.stringify(diff.entry.signal)) {
      problems.push(
        [
          `known difference changed shape: #${diff.id} [${diff.cluster}] ${diff.sql}`,
          ...describeOutput(diff).slice(1),
          `  baseline signal: ${expected.signal.join(" | ")}`,
          `  current signal:  ${diff.entry.signal.join(" | ")}`,
          `  coordinates: ${diff.entry.coordinates}`,
        ].join("\n"),
      );
      continue;
    }
    matched += 1;
  }
  for (const entry of baseline.entries) {
    if (seen.has(entryKey(entry))) continue;
    problems.push(
      [
        `baseline entry no longer differs: #${entry.id} [${entry.cluster}] ${entry.sql}`,
        `  the case now matches both oracles, drop it with: pnpm corpus -- --update-baseline`,
      ].join("\n"),
    );
  }
  return { problems, matched };
}

function reasonCounts(entries: readonly BaselineEntry[]): Record<BaselineReason, number> {
  const counts: Record<BaselineReason, number> = {
    "structured-rejection": 0,
    "not-implemented": 0,
    "known-drift": 0,
    "oracle-disagreement": 0,
  };
  for (const entry of entries) counts[entry.reason] += 1;
  return counts;
}

function oracleText(current: Record<string, string>, recorded: Record<string, string>): string {
  const now = `better-sqlite3 ${current.better}, python sqlite3 ${current.python}`;
  if (current.better === recorded.better && current.python === recorded.python) return now;
  return `${now} (baseline recorded better-sqlite3 ${recorded.better}, python sqlite3 ${recorded.python})`;
}

export interface CorpusOptions extends CliOptions {
  readonly seed: number;
  readonly count: number;
  readonly check: boolean;
  readonly updateBaseline: boolean;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} needs a value`);
    return value;
  }
  return undefined;
}

export function parseCorpusOptions(argv: string[]): CorpusOptions {
  const seedText = optionValue(argv, "--seed") ?? String(DEFAULT_SEED);
  const countText = optionValue(argv, "--count") ?? String(DEFAULT_COUNT);
  const seed = Number(seedText);
  const count = Number(countText);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed must be a non-negative integer, got ${seedText}`);
  if (!Number.isInteger(count) || count <= 0) throw new Error(`--count must be a positive integer, got ${countText}`);
  const flags = new Set(["--json", "--check", "--update-baseline"]);
  const values = new Set(["--seed", "--count"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (values.has(value)) {
      index += 1;
      continue;
    }
    if (!flags.has(value)) throw new Error(`unknown option: ${value}`);
  }
  const check = argv.includes("--check");
  const updateBaseline = argv.includes("--update-baseline");
  if (check && updateBaseline) throw new Error("--check and --update-baseline cannot be combined");
  return { seed, count, json: argv.includes("--json"), check, updateBaseline };
}

export async function commandCorpus(options: CorpusOptions): Promise<number> {
  const cases = generate(options.seed, options.count);
  const digest = createHash("sha256")
    .update(JSON.stringify(cases.map((item) => [item.cluster, item.sql, item.check ?? null])))
    .digest("hex");

  // The digest is checked before any engine starts. A silently edited corpus
  // fails here instead of quietly relaxing the gate.
  const baseline = options.check ? loadBaseline() : undefined;
  if (baseline) {
    const problems = identityProblems(baseline, options, digest);
    if (problems.length > 0) {
      process.stderr.write(
        [
          "corpus gate failed: the generated corpus no longer matches the baseline digest",
          ...problems.map((problem) => `  ${problem}`),
          "",
          "The corpus changed without regenerating the baseline. Review the change and run:",
          `  pnpm corpus -- --seed ${options.seed} --count ${options.count} --update-baseline`,
          "",
        ].join("\n"),
      );
      return 1;
    }
  }

  const better = await openEngine("better-sqlite3");
  const python = await openEngine("python");

  const discarded: Discarded[] = [];
  const mismatches: Mismatch[] = [];
  const passed: number[] = [];

  for (const item of cases) {
    const ours = runOurs(FIXTURE_STEPS, item);
    const oracleBetter = await runOracle(better, FIXTURE_STEPS, item);
    const oraclePython = await runOracle(python, FIXTURE_STEPS, item);
    if (!sameSide(oracleBetter, oraclePython)) {
      discarded.push({ id: item.id, cluster: item.cluster, sql: item.sql, better: oracleBetter, python: oraclePython });
      continue;
    }
    if (sameSide(ours, oracleBetter)) {
      passed.push(item.id);
      continue;
    }
    mismatches.push({ item, ours, better: oracleBetter, python: oraclePython });
  }

  const distribution: Record<string, number> = {};
  for (const cluster of CLUSTERS) distribution[cluster.name] = 0;
  for (const item of cases) distribution[item.cluster] += 1;

  const classes = new Map<string, Array<{ item: CorpusCase; ours: Side; better: Side; python: Side }>>();
  for (const mismatch of mismatches) {
    const key = signature(mismatch.item);
    const bucket = classes.get(key) ?? [];
    bucket.push(mismatch);
    classes.set(key, bucket);
  }

  const gateable = mismatches.filter((mismatch) => !mismatch.ours.error && !mismatch.better.error && !mismatch.python.error);
  const observed = observedDifferences(discarded, mismatches);
  const currentEngines = { better: better.version, python: python.version };

  if (options.updateBaseline) {
    const baselineFile = baselineFrom(
      options.seed,
      options.count,
      digest,
      currentEngines,
      observed.map((diff) => diff.entry),
    );
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baselineFile, null, 2)}\n`, "utf8");
    const counts = reasonCounts(baselineFile.entries);
    const payload = {
      command: "corpus",
      mode: "update-baseline",
      path: BASELINE_PATH,
      seed: options.seed,
      count: options.count,
      digest,
      engines: currentEngines,
      passed: passed.length,
      mismatched: mismatches.length,
      discarded: discarded.length,
      entries: baselineFile.entries.length,
      reasons: counts,
    };
    const text = () =>
      [
        `baseline written: ${BASELINE_PATH}`,
        `seed=${options.seed} count=${options.count} digest=${digest}`,
        `engines: ${oracleText(currentEngines, baselineFile.engines)}`,
        `${passed.length} passed / ${mismatches.length} mismatched / ${discarded.length} discarded`,
        `entries: ${baselineFile.entries.length} (${Object.entries(counts).map(([reason, value]) => `${reason} ${value}`).join(", ")})`,
      ].join("\n");
    emit(options, payload as unknown as Record<string, unknown>, text);
    return 0;
  }

  if (options.check && baseline) {
    const result = checkBaseline(baseline, observed);
    const ok = result.problems.length === 0;
    const payload = {
      command: "corpus",
      mode: "check",
      seed: options.seed,
      count: options.count,
      digest,
      engines: currentEngines,
      passed: passed.length,
      mismatched: mismatches.length,
      discarded: discarded.length,
      known: result.matched,
      gate: ok,
      problems: result.problems,
    };
    const summary = ok
      ? [
          `corpus gate ok: seed ${options.seed} count ${options.count} digest ${digest}`,
          `${cases.length} cases: ${passed.length} passed / ${mismatches.length} mismatched / ${discarded.length} discarded`,
          `known differences: ${result.matched} matched the baseline`,
          `oracles: ${oracleText(currentEngines, baseline.engines)}`,
        ]
      : [
          `corpus gate failed: ${result.problems.length} problem(s), ${result.matched} known differences matched`,
          `seed ${options.seed} count ${options.count} digest ${digest}`,
          `oracles: ${currentEngines.better} / ${currentEngines.python}`,
          "",
          result.problems.join("\n\n"),
        ];
    const rendered = summary.join("\n");
    if (!ok && !options.json) {
      process.stderr.write(`${rendered}\n`);
      return 1;
    }
    emit(options, payload as unknown as Record<string, unknown>, () => rendered);
    return ok ? 0 : 1;
  }

  const payload = {
    command: "corpus",
    seed: options.seed,
    count: options.count,
    digest,
    engines: currentEngines,
    distribution,
    discarded,
    mismatches: mismatches.map((entry) => ({
      id: entry.item.id,
      cluster: entry.item.cluster,
      sql: entry.item.sql,
      check: entry.item.check ?? null,
      tables: entry.item.tables,
      ours: entry.ours,
      better: entry.better,
      python: entry.python,
      minimal: minimalRepro(entry.item),
      coordinates: coordinates(entry.item),
    })),
    gateable: gateable.map((entry) => entry.item.id),
  };

  const text = () => {
    const classRows = Array.from(classes.entries()).map(([key, bucket]) => {
      const representative = bucket[0];
      return [
        key.split(" ")[0],
        bucket.length,
        rowsText(representative.ours),
        rowsText(representative.better),
        rowsText(representative.python),
        representative.item.sql,
        coordinates(representative.item),
      ];
    });
    const lines = [
      `corpus seed=${options.seed} count=${options.count} digest=${digest}`,
      `engines: better-sqlite3 ${better.version}, python sqlite3 ${python.version}`,
      `distribution: ${CLUSTERS.map((cluster) => `${cluster.name} ${distribution[cluster.name]}`).join(", ")}`,
      `passed ${passed.length} / mismatched ${mismatches.length} / discarded ${discarded.length}`,
    ];
    if (discarded.length > 0) {
      lines.push("", "discarded because the two oracles disagree:");
      for (const entry of discarded) {
        lines.push(`- #${entry.id} ${entry.cluster}: ${entry.sql}`);
        lines.push(`  better: ${rowsText(entry.better)}`);
        lines.push(`  python: ${rowsText(entry.python)}`);
      }
    }
    if (classRows.length > 0) {
      lines.push("", renderTable(["cluster", "cases", "ours", "better", "python", "sql", "coordinates"], classRows));
    }
    if (gateable.length > 0) {
      lines.push("", `row-level differences that can stand alone (${gateable.length}): ${gateable.map((entry) => `#${entry.item.id}`).join(", ")}`);
    }
    return lines.join("\n");
  };

  emit(options, payload as unknown as Record<string, unknown>, text);
  return 0;
}
