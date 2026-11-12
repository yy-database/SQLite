// 错误分类门禁：每一个稳定 `SQLiteError.code` 都至少有一条最小用例，且原生
// JSON 信封里的 `code` 必须与 TS 层还原出的 `code` 完全一致，不能被吞成
// 泛化的 `engine`。
//
// 约束覆盖走引擎会给出具体分类的路径：UNIQUE / NOT NULL / CHECK 通过
// `UPDATE` 触达，FOREIGN KEY 通过 `INSERT` 触达。`INSERT` 触达 UNIQUE /
// NOT NULL / CHECK 时 facade 同样保留各自的约束码，不再折叠成 `storage`。
//
// `corrupt` 由 facade 直接给出，消息前缀 `corrupt database file:` 保持不变。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixturePath } from "@yydb/sqlite-fixtures";

import { SQLite, SQLiteError } from "../../src/index.ts";
import { toSQLiteError } from "../../src/errors.ts";
import { addon } from "../../src/native/binding.ts";

function workspace(label: string): { root: string; path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-error-${label}-`));
  return {
    root,
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows 持有句柄时忽略清理失败，临时目录随系统回收。
      }
    },
  };
}

/**
 * 断言 `SQLiteError.code`，并在错误携带原生 `cause` 信封时核对两边一致。
 * TS 自己抛出的合同错误（如 `db-closed`）没有信封，只校验 TS 侧。
 */
function expectCode(code: string, run: () => unknown): SQLiteError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SQLiteError, `expected SQLiteError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}: ${error.message}`);
    assert.notEqual(error.code, "engine", `code ${code} must not be swallowed into the generic engine code`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      let envelope: { code?: unknown } | undefined;
      try {
        envelope = JSON.parse(cause.message) as { code?: unknown };
      } catch {
        // 非信封错误（TS 合同错误或绑定层转换失败）没有原生 code。
      }
      if (envelope && typeof envelope.code === "string") {
        assert.equal(envelope.code, code, "the native envelope code must equal SQLiteError.code");
      }
    }
    return error;
  }
  assert.fail(`expected SQLiteError with code ${code}`);
}

test("db-closed: a closed connection and its prepared statement reject with a stable code", () => {
  const db = new SQLite();
  db.exec("create table t (id integer primary key)");
  const statement = db.prepare("select id from t");
  db.close();
  const closed = expectCode("db-closed", () => db.run("select 1"));
  assert.match(closed.message, /database is closed/);
  expectCode("db-closed", () => statement.run());

  // 原生侧同一合同：关闭后的连接由 Rust 返回同码信封，TS 映射后仍是 `db-closed`。
  const native = addon.SqliteConnection.open({});
  native.close();
  let raw: unknown;
  try {
    native.prepare("select 1");
  } catch (error) {
    raw = error;
  }
  assert.ok(raw instanceof Error, "the native closed connection must reject");
  assert.equal(toSQLiteError(raw).code, "db-closed");
});

test("read-only: a read-only connection rejects writes and leaves the file untouched", () => {
  const space = workspace("read-only");
  try {
    const writable = new SQLite({ filename: space.path });
    writable.exec("create table t (id integer primary key)");
    writable.close();

    const reader = new SQLite({ filename: space.path, readOnly: true });
    const before = readFileSync(space.path);
    try {
      const error = expectCode("read-only", () => reader.run("insert into t (id) values (1)"));
      assert.match(error.message, /cannot modify a read-only database/);
      expectCode("read-only", () => reader.exec("delete from t"));
      assert.deepEqual(readFileSync(space.path), before, "a rejected write must not touch the file");
    } finally {
      reader.close();
    }
  } finally {
    space.dispose();
  }
});

test("busy: a second writer is rejected with a stable code instead of waiting forever", () => {
  const space = workspace("busy");
  try {
    const first = new SQLite({ filename: space.path });
    try {
      first.exec("create table t (id integer primary key)");
      const error = expectCode("busy", () => new SQLite({ filename: space.path, busyTimeoutMs: 0 }));
      assert.match(error.message, /SQLITE_BUSY/);
    } finally {
      first.close();
    }
  } finally {
    space.dispose();
  }
});

test("not-found: opening a missing file without create is a stable rejection", () => {
  const space = workspace("not-found");
  try {
    const missing = join(space.root, "missing.sqlite");
    const error = expectCode("not-found", () => new SQLite({ filename: missing, create: false }));
    assert.match(error.message, /does not exist/);
    expectCode("not-found", () => new SQLite({ filename: missing, readOnly: true }));
  } finally {
    space.dispose();
  }
});

test("corrupt: a damaged fixture surfaces through a structured code with a corruption message", (t) => {
  // 夹具由外部引擎写出后定点清零文件头；本实现以 `corrupt` + 明确消息拒绝。
  const error = expectCode("corrupt", () => new SQLite({ filename: fixturePath("corrupt-header.sqlite"), readOnly: true }));
  assert.match(error.message, /corrupt database file: sqlite magic mismatch/);
  assert.notEqual(error.code, "engine");
  t.diagnostic(`corrupt classification is carried by code "${error.code}" and message "${error.message}"`);
});

test("syntax: an incomplete statement keeps the syntax code and the parser message", () => {
  const db = new SQLite();
  try {
    const error = expectCode("syntax", () => db.exec("select * from"));
    assert.match(error.message, /expected an identifier but the statement ended/);
    expectCode("syntax", () => db.prepare("select * from t where"));
  } finally {
    db.close();
  }
});

test("constraint: a UNIQUE violation keeps the unique-constraint code", () => {
  const db = new SQLite();
  try {
    db.exec("create table t (id integer primary key, u integer unique)");
    db.exec("insert into t (id, u) values (1, 10), (2, 20), (3, 30)");
    const error = expectCode("unique-constraint", () => db.run("update t set u = 20 where id = 1"));
    assert.match(error.message, /UNIQUE constraint failed: t.u/);
  } finally {
    db.close();
  }
});

test("constraint: a NOT NULL violation keeps the not-null-constraint code", () => {
  const db = new SQLite();
  try {
    db.exec("create table t (id integer primary key, v integer not null)");
    db.exec("insert into t (id, v) values (1, 5), (2, 6)");
    const error = expectCode("not-null-constraint", () => db.run("update t set v = null where id = 1"));
    assert.match(error.message, /NOT NULL constraint failed: t.v/);
  } finally {
    db.close();
  }
});

test("constraint: a CHECK violation keeps the check-constraint code and clause", () => {
  const db = new SQLite();
  try {
    db.exec("create table t (id integer primary key, v integer check (v > 0))");
    db.exec("insert into t (id, v) values (1, 5), (2, 6)");
    const error = expectCode("check-constraint", () => db.run("update t set v = -1 where id = 1"));
    assert.match(error.message, /CHECK constraint failed: v > 0/);
  } finally {
    db.close();
  }
});

test("constraint: a FOREIGN KEY violation keeps the SQLITE_CONSTRAINT_FOREIGNKEY code", () => {
  const db = new SQLite({ foreignKeys: true });
  try {
    db.exec("create table parent (id integer primary key)");
    db.exec("create table child (id integer primary key, parent_id integer references parent)");
    const error = expectCode("SQLITE_CONSTRAINT_FOREIGNKEY", () =>
      db.run("insert into child (id, parent_id) values (1, 99)"),
    );
    assert.match(error.message, /FOREIGN KEY constraint failed/);
  } finally {
    db.close();
  }
});

test("cursor-expired: a cursor opened inside a rolled-back transaction stops with a stable code", () => {
  const db = new SQLite();
  try {
    db.exec("create table big (id integer primary key)");
    db.exec(`insert into big (id) values ${Array.from({ length: 300 }, (_value, index) => `(${index + 1})`).join(",")}`);
    let iterator: Generator<{ id: bigint }, void, unknown> | undefined;
    assert.throws(
      () =>
        db.transaction((tx) => {
          iterator = tx.prepare<{ id: bigint }>("select id from big order by id").iterate();
          assert.equal(iterator.next().value?.id, 1n);
          throw new Error("roll back");
        }),
      /roll back/,
    );

    // 已取回的首个 256 行窗口仍可消费，之后再取必须报 `cursor-expired`。
    for (let consumed = 1; consumed < 256; consumed += 1) {
      assert.equal(iterator!.next().done, false);
    }
    const error = expectCode("cursor-expired", () => iterator!.next());
    assert.match(error.message, /opened inside a transaction that has already ended/);
  } finally {
    db.close();
  }
});

test("cursor-not-found: an unknown native cursor handle keeps the cursor-not-found code", () => {
  const native = addon.SqliteConnection.open({});
  try {
    native.exec("create table t (id integer primary key); insert into t values (1), (2)");
    const statement = native.prepare("select id from t");
    const opened = statement.openCursor();
    assert.deepEqual(opened.columns, ["id"]);
    let raw: unknown;
    try {
      statement.cursorNext(987_654, 4);
    } catch (error) {
      raw = error;
    }
    assert.ok(raw instanceof Error, "an unknown cursor handle must reject");
    const mapped = toSQLiteError(raw);
    assert.equal(mapped.code, "cursor-not-found");
    assert.match(mapped.message, /cursor 987654 is not open/);
    assert.notEqual(mapped.code, "engine");
    statement.cursorClose(opened.handle);
  } finally {
    native.close();
  }
});
