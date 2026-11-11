// 结果集游标行为：有界窗口取行、提前释放、交错读取与事务失效。
//
// oracle 是确定性的行内容（第 i 行 id=i、label=`row-i`），不拿本实现自己的
// `all()` 当期望值；`all()` 只用于交叉核对同一份数据的行数。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLite, SQLiteError, createWriter, writeSlots } from "../../src/index.ts";

const ROWS = 50_000;

interface BigRow {
  id: bigint;
  label: string;
}

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-cursor-${label}-`));
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

function seedFile(path: string): void {
  const writer = createWriter(4096);
  writer.createTable(
    "big",
    JSON.stringify([
      { name: "id", declaredType: "INTEGER", primaryKey: true },
      { name: "label", declaredType: "TEXT" },
    ]),
  );
  writer.begin();
  for (let id = 1; id <= ROWS; id += 1) writer.insert("big", writeSlots([id, `row-${id}`]));
  writer.commit();
  writer.save(path);
}

function seedMemory(db: SQLite, rows: number): void {
  db.exec("create table big (id integer primary key, label text not null)");
  const values = Array.from({ length: rows }, (_value, index) => `(${index + 1}, 'row-${index + 1}')`).join(",");
  db.exec(`insert into big (id, label) values ${values}`);
}

function expectCode(code: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SQLiteError, `expected SQLiteError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected SQLiteError with code ${code}`);
}

test("iterate reads 50,000 rows through bounded windows", { timeout: 120_000 }, () => {
  const space = workspace("window");
  try {
    seedFile(space.path);
    const db = new SQLite({ filename: space.path, readOnly: true });
    try {
      let count = 0;
      let first: BigRow | undefined;
      let last: BigRow | undefined;
      for (const row of db.iterate<BigRow>("select id, label from big order by id")) {
        count += 1;
        // 每一行都对照确定性 oracle，窗口边界不会漏行或乱序。
        assert.equal(row.id, BigInt(count), `id at ${count}`);
        assert.equal(row.label, `row-${count}`, `label at ${count}`);
        first ??= row;
        last = row;
      }
      assert.equal(count, ROWS);
      assert.deepEqual(first, { id: 1n, label: "row-1" });
      assert.deepEqual(last, { id: BigInt(ROWS), label: `row-${ROWS}` });

      const materialized = db.all<BigRow>("select id, label from big order by id");
      assert.equal(materialized.length, count, "all() and iterate() agree on the row count");
      assert.deepEqual(materialized.at(-1), last);
    } finally {
      db.close();
    }
  } finally {
    space.dispose();
  }
});

test("iterate releases the cursor when the loop breaks early", () => {
  const db = new SQLite();
  try {
    seedMemory(db, 10);
    const statement = db.prepare<BigRow>("select id, label from big order by id");

    let seen = 0;
    for (const row of statement.iterate()) {
      assert.equal(row.id, 1n);
      seen += 1;
      break;
    }
    assert.equal(seen, 1);
    // 游标随 break 释放，同一句柄可以再次执行。
    statement.run();

    // 再来一次并完整消费，证明释放不是靠丢弃句柄实现的。
    const values: bigint[] = [];
    for (const row of statement.iterate()) values.push(row.id);
    assert.equal(values.length, 10);
    assert.deepEqual(values.slice(0, 2), [1n, 2n]);
  } finally {
    db.close();
  }
});

test("two cursors on one connection interleave without disturbing each other", () => {
  const db = new SQLite();
  try {
    seedMemory(db, 600);
    const ascending = db.prepare<BigRow>("select id, label from big order by id");
    const descending = db.prepare<BigRow>("select id, label from big order by id desc");
    const up = ascending.iterate();
    const down = descending.iterate();

    // 交错读取跨过 256 行窗口边界，两个游标各自递增。
    for (let step = 0; step < 300; step += 1) {
      const nextUp = up.next();
      const nextDown = down.next();
      assert.equal(nextUp.done, false);
      assert.equal(nextDown.done, false);
      assert.equal((nextUp.value as BigRow).id, BigInt(step + 1));
      assert.equal((nextDown.value as BigRow).id, BigInt(600 - step));
    }
    up.return(undefined);
    down.return(undefined);
  } finally {
    db.close();
  }
});

test("a rollback invalidates a cursor opened inside the transaction", () => {
  const db = new SQLite();
  try {
    seedMemory(db, 400);
    let iterator: Generator<BigRow, void, unknown> | undefined;
    assert.throws(
      () =>
        db.transaction((tx) => {
          iterator = tx.prepare<BigRow>("select id, label from big order by id").iterate();
          assert.equal((iterator!.next().value as BigRow).id, 1n);
          throw new Error("roll back");
        }),
      /roll back/,
    );

    // 已取回的首个窗口（256 行）仍可消费，之后再取必须报 `cursor-expired`。
    let consumed = 1;
    while (consumed < 256) {
      const row = iterator!.next();
      assert.equal(row.done, false);
      assert.equal((row.value as BigRow).id, BigInt(consumed + 1));
      consumed += 1;
    }
    expectCode("cursor-expired", () => iterator!.next());
  } finally {
    db.close();
  }
});

test("closing the connection invalidates the native cursor", () => {
  const db = new SQLite();
  seedMemory(db, 300);
  const statement = db.prepare<BigRow>("select id, label from big order by id");
  const iterator = statement.iterate();
  assert.equal((iterator.next().value as BigRow).id, 1n);
  db.close();
  // 已取回的首个窗口仍在 JS 里，消费完再取行时原生游标已随连接释放。
  let consumed = 1;
  while (consumed < 256) {
    const row = iterator.next();
    assert.equal(row.done, false);
    consumed += 1;
  }
  expectCode("db-closed", () => iterator.next());
});
