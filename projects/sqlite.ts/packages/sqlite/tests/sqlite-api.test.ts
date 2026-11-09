// `new SQLite(options?)` 正式入口的合同测试：忠实类型映射、严格绑定、
// 单语句、游标、事务所有权、提交时发布、只读与选项诚实性。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLite, SQLiteError } from "../src/index.ts";

function tempDir(): { root: string; path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-class-"));
  return {
    root,
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

function expectCode(code: string, run: () => unknown): SQLiteError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SQLiteError, `expected SQLiteError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}: ${error.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected SQLiteError with code ${code}` });
}

test("faithful type mapping: INTEGER bigint, REAL number, TEXT string, BLOB Uint8Array, NULL null", () => {
  const db = new SQLite();
  db.exec("create table m (id integer primary key, value)");
  db.run("insert into m (id, value) values (?, ?)", [1n, 1]);
  db.run("insert into m (id, value) values (?, ?)", [2n, 1n]);
  db.run("insert into m (id, value) values (?, ?)", [3n, "text"]);
  db.run("insert into m (id, value) values (?, ?)", [4n, new Uint8Array([1, 2, 3])]);
  db.run("insert into m (id, value) values (?, ?)", [5n, null]);

  const rows = db.all("select id, value from m order by id");
  assert.equal(typeof rows[0]!.id, "bigint");
  assert.equal(rows[0]!.id, 1n);
  assert.equal(typeof rows[0]!.value, "number"); // 1 → REAL
  assert.equal(rows[0]!.value, 1);
  assert.equal(typeof rows[1]!.value, "bigint"); // 1n → INTEGER
  assert.equal(rows[2]!.value, "text");
  assert.ok(rows[3]!.value instanceof Uint8Array);
  assert.deepEqual([...(rows[3]!.value as Uint8Array)], [1, 2, 3]);
  assert.equal(rows[4]!.value, null);

  // COUNT(*) 与 lastInsertRowid 同样是 bigint。
  const counted = db.prepare("select count(*) from m").pluck<bigint>().get();
  assert.equal(typeof counted, "bigint");
  assert.equal(counted, 5n);
  const inserted = db.run("insert into m (id, value) values (?, ?)", [6n, "six"]);
  assert.equal(typeof inserted.lastInsertRowid, "bigint");
  assert.equal(inserted.lastInsertRowid, 6n);
  assert.equal(typeof inserted.changes, "bigint");

  // REAL 即使数值是整数也返回 number。
  db.run("insert into m (id, value) values (?, ?)", [7n, 3.0]);
  const real = db.prepare("select value from m where id = 7").pluck().get();
  assert.equal(typeof real, "number");
});

test("binding contract: undefined/Date/boolean/extra/missing rejected", () => {
  const db = new SQLite();
  db.exec("create table b (id integer primary key, flag integer)");
  expectCode("param-undefined", () => db.run("insert into b (id, flag) values (?, ?)", [1n, undefined]));
  expectCode("param-type", () => db.run("insert into b (id, flag) values (?, ?)", [1n, new Date()]));
  expectCode("param-extra", () => db.run("insert into b (id) values (?)", [1n, 2n]));
  expectCode("param-missing", () => db.run("insert into b (id, flag) values (?, ?)", [1n]));
  expectCode("param-range", () => db.run("insert into b (id) values (?)", [9223372036854775808n]));

  // boolean 不是可绑定值：SQL 没有布尔类型，0/1 转换归使用者显式决定。
  expectCode("param-type", () => db.run("insert into b (id, flag) values (?, ?)", [1n, true]));
  expectCode("param-type", () => db.run("insert into b (id, flag) values (?, ?)", [2n, false]));
  db.run("insert into b (id, flag) values (?, ?)", [1n, 1n]);
  db.run("insert into b (id, flag) values (?, ?)", [2n, 0n]);
  assert.equal(db.prepare("select flag from b where id = 1").pluck<bigint>().get(), 1n);
  assert.equal(db.prepare("select flag from b where id = 2").pluck<bigint>().get(), 0n);
});

test("named parameters: prefix elision, missing and unused keys", () => {
  const db = new SQLite();
  db.exec("create table n (id integer primary key, name text)");
  db.run("insert into n (id, name) values (:id, :name)", { id: 1n, name: "Alice" });
  // 引擎占位符只认 `?`/`?NNN`/`:name`；`$`/`@` 前缀键是 TS 层的省略合同。
  db.run("insert into n (id, name) values (:id, :name)", { $id: 2n, $name: "Bob" });
  expectCode("param-missing", () => db.run("insert into n (id, name) values (:id, :name)", { id: 3n }));
  expectCode("param-extra", () => db.run("insert into n (id, name) values (:id, :name)", { id: 3n, name: "x", other: 1 }));

  const statement = db.prepare("select name from n where id = :id");
  assert.equal(statement.pluck<string>().get({ ":id": 1n }), "Alice");
  assert.equal(statement.pluck<string>().get({ id: 2n }), "Bob");
});

test("single statement enforcement and trailing semicolon", () => {
  const db = new SQLite();
  expectCode("multiple-statements", () => db.prepare("select 1; select 2"));
  db.prepare("select 1;").get();
  db.exec("create table s (id integer primary key); insert into s (id) values (1);");
  assert.equal(db.prepare("select count(*) from s").pluck<bigint>().get(), 1n);
});

test("get distinguishes no-row from a NULL value; duplicate labels error; raw/pluck views", () => {
  const db = new SQLite();
  db.exec("create table g (id integer primary key, value)");
  db.run("insert into g (id, value) values (1, null)");
  assert.equal(db.prepare("select * from g where id = 2").get(), undefined);
  assert.deepEqual(db.prepare("select value from g where id = 1").get(), { value: null });

  expectCode("duplicate-column", () => db.prepare("select id, id from g").get());
  assert.deepEqual(db.prepare("select id, id from g").raw().get(), [1n, 1n]);
  assert.equal(db.prepare("select id from g").pluck<bigint>().get(), 1n);

  // 视图是不可变的：raw() 不改变原 Statement 的返回模式。
  const base = db.prepare("select id from g");
  base.raw();
  assert.deepEqual(base.get(), { id: 1n });
});

test("iterate releases the cursor on break; active cursor blocks re-execution", () => {
  const db = new SQLite();
  db.exec("create table i (id integer primary key)");
  db.exec("insert into i (id) values (1); insert into i (id) values (2); insert into i (id) values (3);");
  const statement = db.prepare("select id from i order by id");

  let seen = 0;
  for (const _row of statement.iterate()) {
    seen += 1;
    break;
  }
  assert.equal(seen, 1);
  statement.run(); // 游标已随 break 释放

  const manual = statement.iterate();
  manual.next();
  expectCode("cursor-active", () => statement.run());
  manual.return(undefined);
  statement.run();
});

test("transaction executes immediately, rolls back on throw, and rejects async callbacks", () => {
  const db = new SQLite();
  db.exec("create table t (id integer primary key, v text)");

  const returned = db.transaction((tx) => {
    tx.run("insert into t (id, v) values (?, ?)", [1n, "a"]);
    return "done";
  });
  assert.equal(returned, "done");
  assert.equal(db.prepare("select count(*) from t").pluck<bigint>().get(), 1n);

  assert.throws(
    () =>
      db.transaction((tx) => {
        tx.run("insert into t (id, v) values (?, ?)", [2n, "b"]);
        throw new Error("boom");
      }),
    /boom/,
  );
  expectCode("async-callback", () => db.transaction(() => Promise.resolve(1)));
  assert.equal(db.prepare("select count(*) from t").pluck<bigint>().get(), 1n);
});

test("managed transactions own the control statements", () => {
  const db = new SQLite();
  db.exec("create table o (id integer primary key)");
  expectCode("transaction-ownership", () =>
    db.transaction((tx) => {
      tx.run("COMMIT");
    }),
  );
  expectCode("transaction-ownership", () =>
    db.transaction((tx) => {
      tx.exec("BEGIN");
    }),
  );
  // 事务外手写 BEGIN/COMMIT 仍然允许（引擎状态真实）。
  assert.equal(db.inTransaction, false);
});

test("nested transactions use savepoints; inner failure can be caught by the outer scope", () => {
  const db = new SQLite();
  db.exec("create table e (id integer primary key, v text)");
  db.transaction((tx) => {
    tx.run("insert into e (id, v) values (1, 'kept')");
    try {
      tx.transaction((inner) => {
        inner.run("insert into e (id, v) values (2, 'lost')");
        throw new Error("inner boom");
      });
    } catch {
      // 外层捕获后继续。
    }
    tx.run("insert into e (id, v) values (3, 'kept')");
  });
  const values = db.prepare("select v from e order by id").pluck<string>().all();
  assert.deepEqual(values, ["kept", "kept"]);
});

test("transaction scope cannot escape its callback", () => {
  const db = new SQLite();
  db.exec("create table x (id integer primary key)");
  let escaped: unknown = null;
  db.transaction((tx) => {
    escaped = tx;
  });
  expectCode("scope-escaped", () => (escaped as { run(sql: string): unknown }).run("insert into x (id) values (9)"));
});

test("file databases publish at commit, not at close, and roll back leaves the file untouched", () => {
  const space = tempDir();
  try {
    const created = new SQLite({ filename: space.path });
    assert.ok(existsSync(space.path), "construction publishes the blank image");
    created.exec("create table f (id integer primary key, v text)");
    const afterDdl = readFileSync(space.path);

    created.run("insert into f (id, v) values (1, 'committed')");
    const afterCommit = readFileSync(space.path);
    assert.notDeepEqual(afterCommit, afterDdl, "autocommit statement republished the file");

    assert.throws(
      () =>
        created.transaction((tx) => {
          tx.run("insert into f (id, v) values (2, 'rolled back')");
          throw new Error("nope");
        }),
      /nope/,
    );
    assert.deepEqual(readFileSync(space.path), afterCommit, "rollback left the file untouched");
    created.close();

    const reopened = new SQLite({ filename: space.path });
    assert.equal(reopened.prepare("select count(*) from f").pluck<bigint>().get(), 1n);
    reopened.close();

    expectCode("not-found", () => new SQLite({ filename: join(space.root, "missing.sqlite"), create: false }));
    expectCode("not-found", () => new SQLite({ filename: join(space.root, "missing.sqlite"), readOnly: true }));
  } finally {
    space.dispose();
  }
});

test("read-only opens reject mutations and never write the file", () => {
  const space = tempDir();
  try {
    const writable = new SQLite({ filename: space.path });
    writable.exec("create table r (id integer primary key)");
    writable.close();

    const archive = new SQLite({ filename: space.path, readOnly: true });
    const bytesBefore = readFileSync(space.path);
    expectCode("read-only", () => archive.run("insert into r (id) values (1)"));
    expectCode("read-only", () => archive.exec("delete from r"));
    assert.deepEqual(readFileSync(space.path), bytesBefore);
    assert.equal(archive.all("select id from r").length, 0);
    archive.close();
  } finally {
    space.dispose();
  }
});

test("data creates a private copy; serialize/backup round-trip", () => {
  const db = new SQLite();
  db.exec("create table d (id integer primary key, v text)");
  db.run("insert into d (id, v) values (1, 'one')");

  const bytes = db.serialize();
  const restored = new SQLite({ data: bytes });
  assert.equal(restored.prepare("select v from d where id = 1").pluck<string>().get(), "one");
  restored.run("insert into d (id, v) values (2, 'two')");
  assert.equal(db.prepare("select count(*) from d").pluck<bigint>().get(), 1n, "the copy does not leak back");

  const space = tempDir();
  try {
    db.backup(space.path);
    const fromBackup = new SQLite({ filename: space.path });
    assert.equal(fromBackup.prepare("select count(*) from d").pluck<bigint>().get(), 1n);
    fromBackup.close();
    expectCode("backup-in-transaction", () =>
      db.transaction(() => {
        db.backup(join(space.root, "second.sqlite"));
      }),
    );
  } finally {
    space.dispose();
  }
});

test("options honesty: unsupported knobs throw, foreignKeys is real", () => {
  expectCode("unsupported", () => new SQLite({ busyTimeoutMs: 100 }));
  expectCode("unsupported", () => new SQLite({ journalMode: "wal" }));
  expectCode("unsupported", () => new SQLite({ limits: { sqlBytes: 10 } }));
  expectCode("unsupported", () => new SQLite({ integers: "bigint" } as unknown as Record<string, unknown>));
  expectCode("option-conflict", () => new SQLite({ filename: "./a.sqlite", data: new Uint8Array() }));

  const db = new SQLite();
  db.exec("create table parent (id integer primary key)");
  db.exec("create table child (id integer primary key, parent_id integer references parent)");
  expectCode("SQLITE_CONSTRAINT_FOREIGNKEY", () => db.run("insert into child (id, parent_id) values (1, 99)"));
  assert.equal(db.pragma("foreign_keys", { scalar: true }), 1n);

  const relaxed = new SQLite({ foreignKeys: false });
  relaxed.exec("create table parent (id integer primary key)");
  relaxed.exec("create table child (id integer primary key, parent_id integer references parent)");
  relaxed.run("insert into child (id, parent_id) values (1, 99)");
  assert.equal(relaxed.pragma("foreign_keys", { scalar: true }), 0n);
});

test("closed connections and closed statements fail with stable codes", () => {
  const db = new SQLite();
  db.exec("create table c (id integer primary key)");
  const statement = db.prepare("select id from c");
  db.close();
  expectCode("db-closed", () => db.run("select 1"));
  expectCode("db-closed", () => statement.run());
  assert.equal(db.isOpen, false);
});

test("columns() reports the honest prepare-time limitation", () => {
  const db = new SQLite();
  db.exec("create table col (id integer primary key, name text)");
  const statement = db.prepare("select id, name from col");
  expectCode("columns-pending", () => statement.columns());
  statement.all();
  assert.deepEqual(statement.columns(), ["id", "name"]);
});

test("Symbol.dispose closes the connection", () => {
  const db = new SQLite();
  db.exec("create table z (id integer primary key)");
  db[Symbol.dispose]();
  expectCode("db-closed", () => db.run("select 1"));
});

test("UDF entries throw the documented unsupported contract", () => {
  const db = new SQLite();
  expectCode("unsupported", () => (db as unknown as { function(...args: unknown[]): unknown }).function("f", () => null));
  expectCode("unsupported", () => (db as unknown as { aggregate(...args: unknown[]): unknown }).aggregate("a", {}));
  expectCode("unsupported", () => (db as unknown as { window(...args: unknown[]): unknown }).window("w", {}));
});
