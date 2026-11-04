import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEngine } from "../src/index.ts";

const require = createRequire(import.meta.url);

interface ExternalStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): { integrity_check?: string };
}

interface ExternalDatabase {
  prepare(source: string): ExternalStatement;
  close(): void;
}

const BetterSqlite = require("better-sqlite3") as new (path: string) => ExternalDatabase;

function workspace(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-engine-"));
  return {
    path: join(root, "engine.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows 仍持有句柄时忽略清理失败，临时目录随系统回收。
      }
    },
  };
}

test("execute reports statement, affected, columns and rows", () => {
  const engine = createEngine(4096);
  const created = engine.execute("create table people (id integer primary key, name text not null, score real)");
  assert.equal(created.statement, "create-table");
  assert.equal(created.affected, 1);
  assert.deepEqual(created.columns, []);
  assert.deepEqual(created.rows, []);

  const inserted = engine.execute("insert into people (name, score) values ('ada', 9.5)");
  assert.equal(inserted.statement, "insert");
  assert.equal(inserted.affected, 1);
  assert.deepEqual(inserted.columns, ["rowid"]);
  assert.deepEqual(inserted.rows, [[1]]);

  const selected = engine.execute("select * from people");
  assert.equal(selected.statement, "select");
  assert.equal(selected.affected, 0);
  assert.deepEqual(selected.columns, ["id", "name", "score"]);
  assert.deepEqual(selected.rows, [[1, "ada", 9.5]]);
});

test("select count(*) and named columns with limit", () => {
  const engine = createEngine();
  engine.execute("create table t (id integer primary key, label text)");
  engine.executeBatch(["insert into t (label) values ('a')", "insert into t (label) values ('b')", "insert into t (label) values ('c')"]);

  const counted = engine.execute("select count(*) from t");
  assert.deepEqual(counted.columns, ["count(*)"]);
  assert.deepEqual(counted.rows, [[3]]);

  const limited = engine.execute("select label from t limit 2");
  assert.deepEqual(limited.columns, ["label"]);
  assert.deepEqual(limited.rows, [["a"], ["b"]]);
});

test("one insert statement may carry multiple value tuples", () => {
  const engine = createEngine();
  engine.execute("create table t (id integer primary key, label text)");
  const inserted = engine.execute("insert into t (label) values ('a'), ('b')");
  assert.equal(inserted.affected, 2);
  assert.deepEqual(inserted.rows, [[1], [2]]);
  assert.deepEqual(engine.execute("select * from t").rows, [
    [1, "a"],
    [2, "b"],
  ]);
});

test("executeBatch preserves order and stops at the first rejection", () => {
  const engine = createEngine();
  const results = engine.executeBatch([
    "create table b (id integer primary key, label text)",
    "insert into b values (1, 'x')",
    "select * from b",
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[2].statement, "select");
  assert.deepEqual(results[2].rows, [[1, "x"]]);

  assert.throws(
    () => engine.executeBatch(["insert into missing values (1)", "select * from b"]),
    /unknown table `missing`/,
  );
});

test("exec runs a semicolon-separated script", () => {
  const engine = createEngine();
  const results = engine.exec(
    "create table e (id integer primary key, label text); insert into e (label) values ('one'); insert into e (label) values ('two'); select count(*) from e",
  );
  assert.equal(results.length, 4);
  assert.deepEqual(results[3].rows, [[2]]);
});

test("unsupported clauses return a structured rejection", () => {
  const engine = createEngine();
  engine.execute("create table t (id integer primary key, label text)");

  const orderBy = engine.tryExecute("select * from t order by id");
  assert.equal(orderBy.ok, false);
  assert.equal(orderBy.error?.code, "unsupported-clause");
  assert.equal(orderBy.error?.statement, "select");
  assert.equal(orderBy.error?.clause, "ORDER");
  assert.equal(orderBy.error?.position, 16);

  const where = engine.tryExecute("select * from t where id = 1");
  assert.equal(where.ok, false);
  assert.equal(where.error?.code, "unsupported-clause");
  assert.equal(where.error?.clause, "WHERE");

  const unknown = engine.tryExecute("insert into missing values (1)");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "unknown-table");
  assert.equal(unknown.error?.statement, "insert");

  const twoStatements = engine.tryExecute("select * from t; select * from t");
  assert.equal(twoStatements.ok, false);
  assert.equal(twoStatements.error?.code, "multiple-statements");

  assert.throws(() => engine.execute("drop table t"), /unsupported statement starting at/i);
});

test("blob cells use the tagged blob envelope", () => {
  const engine = createEngine();
  engine.execute("create table raw (id integer primary key, payload blob)");
  engine.execute("insert into raw (payload) values (X'00ff')");
  const selected = engine.execute("select * from raw");
  assert.deepEqual(selected.rows, [[1, { $blob: "00ff" }]]);
});

test("the snapshot written after SQL execution opens in an external engine", () => {
  const engine = createEngine(4096);
  engine.exec(
    "create table bench (id integer primary key, label text not null, score real); \
     insert into bench (label, score) values ('alpha', 0.5); \
     insert into bench (label, score) values ('beta', 1.5);",
  );
  assert.equal(engine.pageSize(), 4096);
  assert.ok(engine.sqliteVersion().startsWith("3."));
  assert.equal(engine.ping(), 1);

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      const integrity = external.prepare("PRAGMA integrity_check").get();
      assert.equal(integrity.integrity_check, "ok");
      const rows = external.prepare("SELECT id, label, score FROM bench").all();
      assert.deepEqual(rows, [
        { id: 1, label: "alpha", score: 0.5 },
        { id: 2, label: "beta", score: 1.5 },
      ]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});
