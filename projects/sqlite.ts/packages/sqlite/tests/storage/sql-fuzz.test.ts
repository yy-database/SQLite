// SQL 轻量 fuzz 回归：固定种子生成 200 条只读/小写入语句，同一批语句
// 依次在本实现与外部 `better-sqlite3` 上执行，比较每次的行集、行序与
// 受影响行数。
//
// 生成器只使用已支持的语法（建表、点查、投影表达式、WHERE、ORDER BY、
// LIMIT/OFFSET、聚合、DISTINCT、INSERT/UPDATE/DELETE）。没有 “拒绝未知
// 语法即通过” 的分支：本实现抛错、结果不一致或行序不同都直接失败，并把
// 出错的那一条语句原样打印出来（每条语句本身就是一条最小复现 SQL）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLite } from "../../src/index.ts";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): {
    raw(): { all(): unknown[][] };
    run(): { changes: number };
    get(): unknown;
  };
  close(): void;
};

const CASES = 200;
const SEED = 0x5eed_1e55;
const SEED_ROWS = 40;
const TEXT_VALUES = ["'alpha'", "'beta'", "'k-1'", "'k-2'", "'z z'"];

function workspace(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-fuzz-"));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may keep the handle briefly.
      }
    },
  };
}

/** Deterministic 32-bit LCG; the generator is replayed identically every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function integer(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function real(random: () => number): string {
  const quarters = integer(random, -10, 10);
  return (quarters / 4).toFixed(2);
}

function predicate(random: () => number, depth = 0): string {
  const roll = random();
  if (depth < 2 && roll < 0.22) {
    const left = predicate(random, depth + 1);
    const right = predicate(random, depth + 1);
    return random() < 0.5 ? `(${left} and ${right})` : `(${left} or ${right})`;
  }
  if (depth < 2 && roll < 0.32) return `not (${predicate(random, depth + 1)})`;
  const atoms: Array<() => string> = [
    () => `id <= ${integer(random, 1, SEED_ROWS + 40)}`,
    () => `id >= ${integer(random, 1, SEED_ROWS + 40)}`,
    () => `id % ${integer(random, 2, 9)} = ${integer(random, 0, 8)}`,
    () => `a > ${integer(random, -60, 60)}`,
    () => `a = ${integer(random, -60, 60)}`,
    () => "a is null",
    () => "a is not null",
    () => "b is null",
    () => "b is not null",
    () => `b = ${pick(random, TEXT_VALUES)}`,
    () => "b like 'k-%'",
    () => `c > ${real(random)}`,
    () => {
      const low = integer(random, -8, 4) / 4;
      const high = low + integer(random, 1, 8) / 4;
      return `c between ${low.toFixed(2)} and ${high.toFixed(2)}`;
    },
  ];
  return pick(random, atoms)();
}

function orderBy(random: () => number): string {
  return pick(random, [
    () => "id",
    () => "id desc",
    () => "a, id",
    () => "a desc, id",
    () => "b, id",
    () => "b desc, id",
    () => "c, id",
    () => "c desc, id",
  ])();
}

const EXPRESSIONS: ReadonlyArray<() => string> = [
  () => "a",
  () => "a + 3",
  () => "a * 2 - 1",
  () => "-a",
  () => "abs(a)",
  () => "coalesce(a, 0)",
  () => "id % 5",
  () => "length(b)",
  () => "substr(b, 1, 2)",
  () => "case when a > 0 then 1 else 0 end",
  () => "cast(a as text)",
  () => "c * 2.0",
  () => "id + a",
];

function limitClause(random: () => number): string {
  const limit = integer(random, 1, 8);
  if (random() < 0.5) return "";
  const offset = integer(random, 0, 4);
  return offset === 0 ? ` limit ${limit}` : ` limit ${limit} offset ${offset}`;
}

function selectSql(random: () => number): string {
  const kind = random();
  if (kind < 0.18) {
    const where = random() < 0.7 ? ` where ${predicate(random)}` : "";
    return `select id, a, b, c from fuzz${where} order by ${orderBy(random)}${limitClause(random)}`;
  }
  if (kind < 0.36) {
    const where = random() < 0.7 ? ` where ${predicate(random)}` : "";
    return `select id, ${pick(random, EXPRESSIONS)()} as e from fuzz${where} order by ${orderBy(random)}${limitClause(random)}`;
  }
  if (kind < 0.5) {
    const where = random() < 0.6 ? ` where ${predicate(random)}` : "";
    const x = pick(random, EXPRESSIONS)();
    const y = pick(random, EXPRESSIONS)();
    return `select id, ${x} as x, ${y} as y from fuzz${where} order by id${limitClause(random)}`;
  }
  if (kind < 0.72) {
    const where = random() < 0.6 ? ` where ${predicate(random)}` : "";
    const parts = ["count(*) as n"];
    if (random() < 0.7) parts.push("sum(a) as s");
    if (random() < 0.5) parts.push("min(b) as mn");
    if (random() < 0.5) parts.push("max(a) as mx");
    if (random() < 0.5) parts.push("avg(a) as av");
    return `select ${parts.join(", ")} from fuzz${where}`;
  }
  if (kind < 0.86) {
    const where = random() < 0.6 ? ` where ${predicate(random)}` : "";
    const direction = random() < 0.5 ? "" : " desc";
    return `select distinct b from fuzz${where} order by b${direction}`;
  }
  const where = random() < 0.5 ? ` where ${predicate(random)}` : "";
  return `select min(a) as lo, max(c) as hi, count(*) as n from fuzz${where}`;
}

function insertSql(id: number, random: () => number): string {
  const a = random() < 0.2 ? "null" : `${integer(random, -60, 60)}`;
  const b = random() < 0.2 ? "null" : pick(random, TEXT_VALUES);
  const c = random() < 0.2 ? "null" : real(random);
  return `insert into fuzz (id, a, b, c) values (${id}, ${a}, ${b}, ${c})`;
}

const ASSIGNMENTS: ReadonlyArray<() => string> = [
  () => "a + 1",
  () => "-a",
  () => "abs(a)",
  () => "a * 3",
  () => "coalesce(a, 7)",
  () => "null",
  () => "a - 2",
];

// 写入保持“小写入”：新增一行，或按主键命中一两行的更新/删除。
function targetIds(random: () => number): string {
  const first = integer(random, 1, SEED_ROWS + 80);
  if (random() < 0.3) {
    return `${first}, ${first + integer(random, 1, 20)}`;
  }
  return `${first}`;
}

function updateSql(random: () => number): string {
  const a = pick(random, ASSIGNMENTS)();
  const b = random() < 0.3 ? "null" : pick(random, TEXT_VALUES);
  const c = random() < 0.3 ? "null" : real(random);
  const ids = targetIds(random);
  const where = ids.includes(",") ? `id in (${ids})` : `id = ${ids}`;
  return `update fuzz set a = ${a}, b = ${b}, c = ${c} where ${where}`;
}

function deleteSql(random: () => number): string {
  const ids = targetIds(random);
  return ids.includes(",") ? `delete from fuzz where id in (${ids})` : `delete from fuzz where id = ${ids}`;
}

function normalize(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map((cell) => (typeof cell === "bigint" ? Number(cell) : cell)));
}

function seed(target: { exec(sql: string): unknown }): void {
  target.exec("create table fuzz (id integer primary key, a integer, b text, c real)");
  for (let id = 1; id <= SEED_ROWS; id += 1) {
    const a = id % 5 === 0 ? "null" : `${(id * 13) % 97 - 48}`;
    const b = id % 6 === 0 ? "null" : `'${["alpha", "beta", "k-1", "k-2", "z z"][id % 5]}'`;
    const c = id % 4 === 0 ? "null" : `${((id * 7) % 23) / 4 - 2.5}`;
    target.exec(`insert into fuzz (id, a, b, c) values (${id}, ${a}, ${b}, ${c})`);
  }
}

test(`seeded ${CASES}-statement fuzz matches better-sqlite3`, { timeout: 120_000 }, (t) => {
  const oursSpace = workspace();
  const oracleSpace = workspace();
  let ours: SQLite | undefined;
  let oracle: InstanceType<typeof BetterSqlite> | undefined;
  try {
    // 两个引擎各写各的文件：同一批语句重放，比较结果而不是共享同一个句柄。
    const seeder = new SQLite({ filename: oursSpace.path });
    try {
      seed(seeder);
    } finally {
      seeder.close();
    }
    ours = new SQLite({ filename: oursSpace.path });
    oracle = new BetterSqlite(oracleSpace.path);
    seed(oracle);

    const random = lcg(SEED);
    let selects = 0;
    let writes = 0;
    let nextInsertId = 1_000;

    for (let index = 0; index < CASES; index += 1) {
      const roll = random();
      let sql: string;
      let isSelect: boolean;
      if (roll < 0.55) {
        sql = selectSql(random);
        isSelect = true;
      } else if (roll < 0.67) {
        sql = insertSql(nextInsertId, random);
        nextInsertId += 1;
        isSelect = false;
      } else if (roll < 0.84) {
        sql = updateSql(random);
        isSelect = false;
      } else {
        sql = deleteSql(random);
        isSelect = false;
      }

      try {
        if (isSelect) {
          const actual = normalize(ours.prepare(sql).raw().all());
          const expected = normalize(oracle.prepare(sql).raw().all());
          try {
            assert.deepEqual(actual, expected);
          } catch {
            assert.fail(
              `fuzz case #${index} diverged on this minimal statement:\n  ${sql}\n` +
                `  ours:   ${JSON.stringify(actual.slice(0, 20))}\n  oracle: ${JSON.stringify(expected.slice(0, 20))}`,
            );
          }
          selects += 1;
        } else {
          const actual = Number(ours.prepare(sql).run().changes);
          const expected = Number(oracle.prepare(sql).run().changes);
          assert.equal(
            actual,
            expected,
            `fuzz case #${index} affected a different number of rows on this minimal statement:\n  ${sql}`,
          );
          writes += 1;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes("diverged") || detail.includes("affected a different")) throw error;
        assert.fail(`fuzz case #${index} raised on this minimal statement:\n  ${sql}\n  ${detail}`);
      }
    }

    assert.equal(ours.pragma("integrity_check", { scalar: true }), "ok", "our integrity_check before close");
    const oracleCount = Number(oracle.prepare("select count(*) as n from fuzz").raw().all()[0]![0]);
    assert.equal(oracle.pragma("integrity_check", { simple: true }), "ok", "better-sqlite3 integrity_check");

    oracle.close();
    oracle = undefined;
    ours.close();
    ours = undefined;

    // 落盘后再由两个引擎各验证一次。
    const reopened = new SQLite({ filename: oursSpace.path, readOnly: true });
    try {
      assert.equal(reopened.pragma("integrity_check", { scalar: true }), "ok", "our integrity_check after publish");
      const counted = reopened.prepare("select count(*) as n from fuzz").get() as { n: bigint };
      assert.equal(Number(counted.n), oracleCount, "final row count");
    } finally {
      reopened.close();
    }
    const verifier = new BetterSqlite(oracleSpace.path);
    try {
      assert.equal(verifier.pragma("integrity_check", { simple: true }), "ok", "better-sqlite3 persisted integrity_check");
      const counted = verifier.prepare("select count(*) as n from fuzz").get() as { n: number };
      assert.equal(Number(counted.n), oracleCount, "persisted row count");
    } finally {
      verifier.close();
    }

    t.diagnostic(`${CASES} statements (${selects} selects, ${writes} writes), 0 divergent results, seed 0x${SEED.toString(16)}`);
  } finally {
    try {
      ours?.close();
    } catch {
      // Already closed.
    }
    try {
      oracle?.close();
    } catch {
      // Already closed.
    }
    oursSpace.dispose();
    oracleSpace.dispose();
  }
});
