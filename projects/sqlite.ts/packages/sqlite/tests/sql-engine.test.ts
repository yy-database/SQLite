import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEngine, createEngineFromSnapshot } from "../src/index.ts";

const require = createRequire(import.meta.url);

interface ExternalStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): { integrity_check?: string };
  run(...args: unknown[]): { changes: number };
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

  // A `SELECT` clause outside the supported set is still structured.
  const unsupported = engine.tryExecute("select * from t for update");
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error?.code, "unsupported-clause");
  assert.equal(unsupported.error?.statement, "select");
  assert.equal(unsupported.error?.clause, "UPDATE");

  // `RIGHT JOIN` is part of the join family now and no longer hits this path.
  assert.equal(engine.tryExecute("select * from t right join t as u on t.id = u.id").ok, true);

  const where = engine.tryExecute("select * from t where missing = 1");
  assert.equal(where.ok, false);
  assert.equal(where.error?.code, "unknown-column");

  const unknown = engine.tryExecute("insert into missing values (1)");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "unknown-table");
  assert.equal(unknown.error?.statement, "insert");

  const twoStatements = engine.tryExecute("select * from t; select * from t");
  assert.equal(twoStatements.ok, false);
  assert.equal(twoStatements.error?.code, "multiple-statements");

  assert.throws(() => engine.execute("vacuum"), /unsupported statement starting at/i);
});

test("where predicates and order by follow SQLite comparison rules", () => {
  const engine = createEngine();
  engine.execute("create table m (id integer primary key, label text, score real)");
  engine.executeBatch([
    "insert into m (label, score) values ('b', 1.5)",
    "insert into m (label, score) values ('a', null)",
    "insert into m (label, score) values ('c', 2)",
    "insert into m (label, score) values (null, 0.0)",
  ]);

  // `NULL` sorts below every number, then text, then blob.
  const ordered = engine.execute("select label from m order by score desc");
  assert.deepEqual(ordered.rows, [["c"], ["b"], [null], ["a"]]);

  const multi = engine.execute("select id from m order by score asc, id desc limit 2");
  assert.deepEqual(multi.rows, [[2], [4]]);

  const compared = engine.execute("select count(*) from m where score >= 1.5 and label <> 'a'");
  assert.deepEqual(compared.rows, [[2]]);

  // Integers and reals compare numerically across the two storage classes.
  const numeric = engine.execute("select count(*) from m where score = 2");
  assert.deepEqual(numeric.rows, [[1]]);

  const isNull = engine.execute("select id from m where label is null");
  assert.deepEqual(isNull.rows, [[4]]);

  const notNull = engine.execute("select count(*) from m where not score is null");
  assert.deepEqual(notNull.rows, [[3]]);

  const text = engine.execute("select id from m where label = 'b' or label > 'b'");
  assert.deepEqual(text.rows, [[1], [3]]);
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

test("without rowid tables are their own primary key b-tree", () => {
  const engine = createEngine(4096);
  assert.throws(() => engine.execute("create table missing_key (a text) without rowid"), /PRIMARY KEY missing on table missing_key/);
  assert.throws(() => engine.execute("create table two_keys (a text primary key, b integer, primary key (b)) without rowid"), /more than one primary key/);
  engine.exec(
    "create table wr (a text not null, b integer, primary key (a)) without rowid; \
     insert into wr values ('x', 1), ('y', 2);",
  );
  assert.deepEqual(engine.execute("select * from wr").columns, ["a", "b"]);
  assert.deepEqual(engine.execute("select * from wr").rows, [
    ["x", 1],
    ["y", 2],
  ]);
  // `rowid` is not a column of a WITHOUT ROWID table.
  assert.equal(engine.tryExecute("select rowid from wr").ok, false);

  engine.execute("update wr set b = b + 10 where a = 'x'");
  engine.execute("delete from wr where a = 'y'");
  assert.deepEqual(engine.execute("select * from wr").rows, [["x", 11]]);

  // A key declared after other columns still leads the stored record, like
  // SQLite; the remaining columns follow in declaration order.
  engine.execute("create table wp (v text, k integer primary key) without rowid");
  engine.execute("insert into wp values ('a', 1), ('b', 2)");
  assert.deepEqual(engine.execute("select * from wp order by k").rows, [
    ["a", 1],
    ["b", 2],
  ]);

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT a, b FROM wr").all(), [{ a: "x", b: 11 }]);
      assert.deepEqual(external.prepare("SELECT v, k FROM wp ORDER BY k").all(), [
        { v: "a", k: 1 },
        { v: "b", k: 2 },
      ]);
      // SQLite inserting into our page tree proves the key order is valid.
      external.prepare("INSERT INTO wr VALUES ('z', 3)").run();
      external.prepare("INSERT INTO wp VALUES ('c', 3)").run();
      assert.deepEqual(external.prepare("SELECT a, b FROM wr").all(), [
        { a: "x", b: 11 },
        { a: "z", b: 3 },
      ]);
      assert.deepEqual(external.prepare("SELECT k, v FROM wp").all(), [
        { k: 1, v: "a" },
        { k: 2, v: "b" },
        { k: 3, v: "c" },
      ]);
      const master = external.prepare("SELECT type, name, rootpage, sql FROM sqlite_master ORDER BY rowid").all();
      assert.deepEqual(master, [
        { type: "table", name: "wr", rootpage: 2, sql: "CREATE TABLE wr (a text not null, b integer, primary key (a)) without rowid" },
        { type: "table", name: "wp", rootpage: 3, sql: "CREATE TABLE wp (v text, k integer primary key) without rowid" },
      ]);
    } finally {
      external.close();
    }
    const reopened = createEngineFromSnapshot(engine.snapshot(), 4096);
    assert.deepEqual(reopened.execute("select * from wr").rows, [["x", 11]]);
    assert.deepEqual(reopened.execute("select * from wp order by k").rows, [
      ["a", 1],
      ["b", 2],
    ]);
  } finally {
    workspaceHandle.dispose();
  }
});

test("expression and partial indexes maintain their own keys", () => {
  const engine = createEngine(4096);
  engine.exec(
    "create table items (id integer primary key, name text, flag integer, qty integer); \
     insert into items values (1, 'Alpha', 1, 10), (2, 'beta', 0, 20), (3, 'Gamma', 1, 30); \
     create index items_lower on items (lower(name)); \
     create unique index items_upper on items (upper(name)) where flag = 0; \
     create index items_flagged on items (qty) where flag = 1;",
  );
  // The partial unique index only guards rows whose predicate is true.
  assert.throws(() => engine.execute("insert into items values (4, 'BETA', 0, 40)"), /UNIQUE constraint failed/);
  engine.execute("insert into items values (4, 'delta', 0, 40)");
  assert.deepEqual(engine.execute("select id from items where lower(name) = 'alpha'").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from items where qty >= 20 and flag = 0 order by id").rows, [
    [2],
    [4],
  ]);

  // Updates change both the computed key and the partial-index membership.
  engine.execute("update items set name = 'DELTA', qty = 50 where id = 4");
  engine.execute("update items set flag = 0 where id = 3");
  assert.deepEqual(engine.execute("select id from items where lower(name) = 'delta'").rows, [[4]]);
  assert.deepEqual(engine.execute("select id from items where qty > 25 and flag = 1").rows, []);
  assert.deepEqual(engine.execute("select id from items where upper(name) = 'GAMMA' and flag = 0").rows, [[3]]);
  engine.execute("delete from items where id = 2");

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT id FROM items WHERE lower(name) = 'alpha'").all(), [{ id: 1 }]);
      assert.deepEqual(external.prepare("SELECT id FROM items WHERE flag = 1 AND qty > 25").all(), []);
      // SQLite inserting into the tree must keep the partial index consistent.
      external.prepare("INSERT INTO items VALUES (5, 'epsilon', 1, 60)").run();
      assert.deepEqual(external.prepare("SELECT id FROM items WHERE qty > 55 AND flag = 1").all(), [{ id: 5 }]);
      assert.deepEqual(external.prepare("SELECT name FROM items ORDER BY id").all(), [
        { name: "Alpha" },
        { name: "Gamma" },
        { name: "DELTA" },
        { name: "epsilon" },
      ]);
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      external.close();
    }
    const reopened = createEngineFromSnapshot(engine.snapshot(), 4096);
    assert.deepEqual(reopened.execute("select id from items where lower(name) = 'delta'").rows, [[4]]);
    assert.deepEqual(reopened.execute("select id from items where qty > 25 and flag = 1").rows, []);
  } finally {
    workspaceHandle.dispose();
  }
});

test("table-level UNIQUE constraints own automatic indexes in written order", () => {
  const engine = createEngine(4096);
  engine.exec("create table tu (id integer primary key, a text, b integer, c text, unique(a, b), unique(c))");
  // Two `UNIQUE` clauses become `sqlite_autoindex_tu_1` and `_2`; the INTEGER
  // primary key is the rowid alias and owns no index of its own.
  assert.deepEqual(engine.execute("select name, sql from sqlite_master where type = 'index' order by rowid").rows, [
    ["sqlite_autoindex_tu_1", null],
    ["sqlite_autoindex_tu_2", null],
  ]);
  const listed = engine.execute("pragma index_list(tu)").rows;
  assert.deepEqual(listed.map((row) => row.slice(1, 4)), [
    ["sqlite_autoindex_tu_2", 1, "u"],
    ["sqlite_autoindex_tu_1", 1, "u"],
  ]);
  // A table-level key written after a `UNIQUE` owns the higher number even when
  // the column types make it a real index instead of a rowid alias.
  engine.exec("create table tb (a text, b text, unique(b), primary key(a))");
  assert.deepEqual(engine.execute("select name from sqlite_master where type = 'index' and tbl_name = 'tb' order by rowid").rows, [
    ["sqlite_autoindex_tb_1"],
    ["sqlite_autoindex_tb_2"],
  ]);
  assert.deepEqual(
    engine.execute("pragma index_list(tb)").rows.map((row) => [row[1], row[3]]),
    [
      ["sqlite_autoindex_tb_2", "pk"],
      ["sqlite_autoindex_tb_1", "u"],
    ],
  );

  engine.exec("insert into tu values (1, 'x', 1, 'c1'), (2, 'x', 2, 'c2')");
  assert.throws(() => engine.execute("insert into tu values (3, 'x', 1, 'c3')"), /UNIQUE constraint failed/);
  assert.throws(() => engine.execute("insert into tu values (4, 'y', 4, 'c1')"), /UNIQUE constraint failed/);
  // NULL participates in no comparison, so repeated NULL keys are allowed.
  engine.exec("insert into tu values (5, null, null, 'c4'), (6, null, null, 'c5')");
  assert.deepEqual(engine.execute("select count(*) from tu").rows, [[4]]);
  assert.equal(engine.tryExecute("create table bad (a integer, unique(missing))").error?.message, "no such column: missing");

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("PRAGMA index_list(tu)").all(), [
        { seq: 0, name: "sqlite_autoindex_tu_2", unique: 1, origin: "u", partial: 0 },
        { seq: 1, name: "sqlite_autoindex_tu_1", unique: 1, origin: "u", partial: 0 },
      ]);
      assert.deepEqual(external.prepare("SELECT id FROM tu ORDER BY id").all(), [{ id: 1 }, { id: 2 }, { id: 5 }, { id: 6 }]);
      assert.throws(() => external.prepare("INSERT INTO tu VALUES (7, 'x', 1, 'c6')").run(), /UNIQUE constraint failed/);
    } finally {
      external.close();
    }
    const reopened = createEngineFromSnapshot(engine.snapshot(), 4096);
    assert.throws(() => reopened.execute("insert into tu values (7, 'x', 1, 'c6')"), /UNIQUE constraint failed/);
    assert.deepEqual(reopened.execute("select id from tu order by id").rows, [[1], [2], [5], [6]]);
  } finally {
    workspaceHandle.dispose();
  }
});

test("sqlite_master lists schema objects in creation order and stays read-only", () => {
  const engine = createEngine();
  engine.execute("create table a (x integer, y text)");
  engine.execute("create index ia on a (x)");
  engine.execute("create table b (z text primary key, w text unique)");

  const master = engine.execute("select type, name, tbl_name, rootpage, sql from sqlite_master");
  assert.deepEqual(master.columns, ["type", "name", "tbl_name", "rootpage", "sql"]);
  assert.deepEqual(
    master.rows.map((row) => row.slice(0, 4)),
    [
      ["table", "a", "a", 2],
      ["index", "ia", "a", 3],
      ["table", "b", "b", 4],
      ["index", "sqlite_autoindex_b_1", "b", 5],
      ["index", "sqlite_autoindex_b_2", "b", 6],
    ],
  );
  assert.equal(typeof master.rows[0][4], "string");
  // Automatic constraint indexes carry no SQL text, exactly like SQLite.
  assert.deepEqual([master.rows[3][4], master.rows[4][4]], [null, null]);

  assert.deepEqual(engine.execute("select name from sqlite_master where type = 'table'").rows, [["a"], ["b"]]);
  assert.deepEqual(engine.execute("select sql from sqlite_master where name = 'sqlite_autoindex_b_1'").rows, [[null]]);
  assert.deepEqual(engine.execute("select count(*) from sqlite_schema").rows, [[5]]);
  assert.deepEqual(engine.execute("select count(*) from sqlite_temp_master").rows, [[0]]);

  const modified = engine.tryExecute("insert into sqlite_master values ('table', 'x', 'x', 0, 'x')");
  assert.equal(modified.ok, false);
  assert.equal(modified.error?.code, "readonly-system-table");
  assert.equal(modified.error?.statement, "insert");

  const reserved = engine.tryExecute("create table sqlite_foo (a integer)");
  assert.equal(reserved.ok, false);
  assert.equal(reserved.error?.code, "reserved-name");
  assert.equal(reserved.error?.message, "object name reserved for internal use: sqlite_foo");

  const unindexable = engine.tryExecute("create index im on sqlite_master (name)");
  assert.equal(unindexable.ok, false);
  assert.equal(unindexable.error?.code, "readonly-system-table");
  assert.equal(unindexable.error?.message, "table sqlite_master may not be indexed");

  // The file itself must report the same rows, with the leading `CREATE TABLE`
  // / `CREATE INDEX` keywords canonicalized and the rest stored verbatim,
  // exactly like SQLite stores them.
  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master").all(), [
        { type: "table", name: "a", tbl_name: "a", rootpage: 2, sql: "CREATE TABLE a (x integer, y text)" },
        { type: "index", name: "ia", tbl_name: "a", rootpage: 3, sql: "CREATE INDEX ia on a (x)" },
        { type: "table", name: "b", tbl_name: "b", rootpage: 4, sql: "CREATE TABLE b (z text primary key, w text unique)" },
        { type: "index", name: "sqlite_autoindex_b_1", tbl_name: "b", rootpage: 5, sql: null },
        { type: "index", name: "sqlite_autoindex_b_2", tbl_name: "b", rootpage: 6, sql: null },
      ]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

test("autoincrement fills sqlite_sequence and never reuses ids", () => {
  const engine = createEngine();
  engine.execute("create table c (id integer primary key autoincrement, v text)");
  assert.deepEqual(engine.execute("select name, rootpage from sqlite_master").rows, [["c", 2], ["sqlite_sequence", 3]]);
  const empty = engine.execute("select * from sqlite_sequence");
  assert.deepEqual(empty.columns, ["name", "seq"]);
  assert.deepEqual(empty.rows, []);

  engine.executeBatch(["insert into c (v) values ('a')", "insert into c (v) values ('b')"]);
  assert.deepEqual(engine.execute("select id from c").rows, [[1], [2]]);
  assert.deepEqual(engine.execute("select name, seq from sqlite_sequence").rows, [["c", 2]]);

  assert.deepEqual(engine.execute("insert into c (id, v) values (100, 'explicit')").rows, [[100]]);
  assert.deepEqual(engine.execute("select seq from sqlite_sequence").rows, [[100]]);
  assert.deepEqual(engine.execute("insert into c (v) values ('auto')").rows, [[101]]);
  assert.deepEqual(engine.execute("insert into c (id, v) values (5, 'low')").rows, [[5]]);
  assert.deepEqual(engine.execute("select seq from sqlite_sequence").rows, [[101]]);
  assert.deepEqual(engine.execute("insert into c (id, v) values (null, 'null')").rows, [[102]]);

  // Without an AUTOINCREMENT table the sequence table does not exist.
  const missing = createEngine().tryExecute("select * from sqlite_sequence");
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "unknown-table");
  assert.equal(missing.error?.message, "no such table: sqlite_sequence");
});

test("comma-separated tables produce a Cartesian product", () => {
  const engine = createEngine();
  engine.execute("create table lefts (id integer primary key, label text)");
  engine.execute("create table rights (id integer primary key, tag text)");
  engine.executeBatch([
    "insert into lefts (label) values ('a')",
    "insert into lefts (label) values ('b')",
    "insert into rights (tag) values ('x')",
    "insert into rights (tag) values ('y')",
    "insert into rights (tag) values ('z')",
  ]);

  const product = engine.execute("select * from lefts, rights");
  // Rows are the product of both sides; columns are concatenated in `FROM` order.
  assert.equal(product.rows.length, 6);
  assert.deepEqual(product.columns, ["id", "label", "id", "tag"]);
  assert.deepEqual(product.rows, [
    [1, "a", 1, "x"],
    [1, "a", 2, "y"],
    [1, "a", 3, "z"],
    [2, "b", 1, "x"],
    [2, "b", 2, "y"],
    [2, "b", 3, "z"],
  ]);

  assert.deepEqual(engine.execute("select count(*) from lefts, rights").rows, [[6]]);
  assert.deepEqual(engine.execute("select count(*) from lefts, rights where rights.tag = 'y'").rows, [[2]]);
  assert.deepEqual(engine.execute("select * from lefts, rights limit 4").rows.length, 4);
});

test("an empty source empties the Cartesian product", () => {
  const engine = createEngine();
  engine.execute("create table one (id integer primary key, label text)");
  engine.execute("create table none (id integer primary key, label text)");
  engine.executeBatch(["insert into one (label) values ('a')", "insert into one (label) values ('b')"]);

  assert.deepEqual(engine.execute("select * from one, none").rows, []);
  assert.deepEqual(engine.execute("select * from none, one").rows, []);
  assert.deepEqual(engine.execute("select count(*) from one, none").rows, [[0]]);
  assert.deepEqual(engine.execute("select count(*) from none, one").rows, [[0]]);
});

test("table aliases resolve qualified columns", () => {
  const engine = createEngine();
  engine.execute("create table users (id integer primary key, name text)");
  engine.execute("create table tags (id integer primary key, tag text)");
  engine.executeBatch([
    "insert into users (name) values ('ada')",
    "insert into users (name) values ('bob')",
    "insert into tags (tag) values ('red')",
    "insert into tags (tag) values ('blue')",
  ]);

  const aliased = engine.execute("select u.name, g.tag from users as u, tags g where g.tag = 'red'");
  assert.deepEqual(aliased.columns, ["name", "tag"]);

  // `*` over aliased sources keeps each declared column name, duplicates included.
  const starred = engine.execute("select * from users as u, tags g where g.tag = 'red'");
  assert.deepEqual(starred.columns, ["id", "name", "id", "tag"]);
  assert.deepEqual(aliased.rows, [
    ["ada", "red"],
    ["bob", "red"],
  ]);

  // A bare column that only one source defines resolves the same way.
  const bare = engine.execute("select name, tag from users, tags where tag = 'red'");
  assert.deepEqual(bare.columns, ["name", "tag"]);
  assert.deepEqual(bare.rows, aliased.rows);

  // Qualified and bare references agree on a single table too.
  const qualified = engine.execute("select users.name from users order by name");
  assert.deepEqual(qualified.rows, engine.execute("select name from users order by name").rows);
});

test("multi-table select rejects ambiguous, unknown and duplicate names", () => {
  const engine = createEngine();
  engine.execute("create table lefts (id integer primary key, label text)");
  engine.execute("create table rights (id integer primary key, tag text)");

  const ambiguous = engine.tryExecute("select id from lefts, rights");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error?.code, "ambiguous-column");
  assert.match(ambiguous.error?.message ?? "", /ambiguous column `id`/);

  const unknownSource = engine.tryExecute("select * from lefts, ghosts");
  assert.equal(unknownSource.ok, false);
  assert.equal(unknownSource.error?.code, "unknown-table");
  assert.match(unknownSource.error?.message ?? "", /unknown table `ghosts`/);

  const unknownQualifier = engine.tryExecute("select nope.id from lefts, rights");
  assert.equal(unknownQualifier.ok, false);
  assert.equal(unknownQualifier.error?.code, "unknown-table");
  assert.match(unknownQualifier.error?.message ?? "", /unknown table `nope` in the `FROM` clause/);

  const shadowed = engine.tryExecute("select lefts.id from lefts as l");
  assert.equal(shadowed.ok, false);
  assert.equal(shadowed.error?.code, "unknown-table");

  const duplicate = engine.tryExecute("select * from lefts as l, rights l");
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error?.code, "duplicate-alias");
  assert.match(duplicate.error?.message ?? "", /`l` is used more than once in `FROM`/);
});

test("one hundred sequentially created tables stay writable and readable", () => {
  // Regression: `sqlite_master` lives in page 1, which also owns the 100-byte
  // database header. The writer used to pack its cells as if the whole page
  // were b-tree space, so the 50th schema row overlapped the cell pointer
  // array and every later statement failed with a "content boundary" error.
  const engine = createEngine(4096);
  for (let index = 1; index <= 100; index += 1) {
    engine.execute(`create table t${index}(a integer, b integer, x varchar)`);
    const inserted = engine.execute(`insert into t${index} values (${index}, ${index * 2}, 'v${index}')`);
    assert.equal(inserted.affected, 1);

    const selected = engine.execute(`select a, b, x from t${index}`);
    assert.deepEqual(selected.rows, [[index, index * 2, `v${index}`]]);
  }

  // The schema b-tree grew past page 1; earlier tables must still resolve.
  for (const index of [1, 41, 49, 50, 51, 100]) {
    const selected = engine.execute(`select a, b, x from t${index}`);
    assert.deepEqual(selected.rows, [[index, index * 2, `v${index}`]]);
  }
});

test("bracketed column types keep SQLite affinity and the declared text", () => {
  const engine = createEngine();
  engine.execute(
    "create table typed (id integer primary key, name varchar(30), price decimal(10,2), code char(4), ratio double precision)",
  );
  engine.execute("insert into typed (name, price, code, ratio) values (7, '2.5', 3, 4)");

  // VARCHAR/CHAR carry TEXT affinity, DECIMAL carries NUMERIC, DOUBLE PRECISION
  // carries REAL, so the stored values change storage class exactly as upstream.
  const selected = engine.execute("select * from typed");
  assert.deepEqual(selected.columns, ["id", "name", "price", "code", "ratio"]);
  assert.deepEqual(selected.rows, [[1, "7", 2.5, "3", 4]]);

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const types = external
        .prepare("SELECT typeof(name) AS nameType, typeof(price) AS priceType, typeof(ratio) AS ratioType FROM typed")
        .get() as unknown as Record<string, string>;
      assert.deepEqual(types, { nameType: "text", priceType: "real", ratioType: "real" });
      // The declared type, parentheses included, survives in sqlite_master.
      const schema = external.prepare("SELECT sql FROM sqlite_master WHERE name = 'typed'").get() as unknown as { sql: string };
      assert.match(schema.sql, /varchar\(30\)/i);
      assert.match(schema.sql, /decimal\(10,2\)/i);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

test("create index accepts ascending, composite, unique and if not exists forms", () => {
  const engine = createEngine();
  engine.exec(
    "create table t8 (a8 integer, b8 integer, c8 text); \
     create index t8i0 on t8(a8); \
     create index t8all on t8(c8, b8 asc, a8); \
     create unique index t8u on t8(a8)",
  );

  // `ASC` names the default key order, so it is accepted. `DESC` would need a
  // descending b-tree and the writer builds ascending keys only, so the
  // keyword is rejected instead of being silently ignored: a declared index
  // order that the image cannot honor is worse than a rejection.
  const descendingSql = "create index t8desc on t8(a8 desc)";
  const descending = engine.tryExecute(descendingSql);
  assert.equal(descending.ok, false);
  assert.equal(descending.error?.code, "unsupported-clause");
  assert.equal(descending.error?.statement, "create-index");
  assert.equal(descending.error?.clause, "DESC");
  assert.equal(descending.error?.position, descendingSql.lastIndexOf("desc"));
  assert.match(descending.error?.message ?? "", /`DESC` index key `a8` is not supported/);

  assert.throws(() => engine.execute("create index t8i0 on t8(a8)"), /index `t8i0` already exists/);
  const repeated = engine.execute("create index if not exists t8i0 on t8(a8)");
  assert.equal(repeated.statement, "create-index");
  assert.equal(repeated.affected, 0);

  const tableConflict = engine.tryExecute("create index t8 on t8(a8)");
  assert.equal(tableConflict.error?.code, "table-exists");
  assert.match(tableConflict.error?.message ?? "", /there is already a table named `t8`/);
  assert.equal(engine.tryExecute("create index on_missing on ghosts(a8)").error?.code, "unknown-table");
  assert.equal(engine.tryExecute("create index on_column on t8(ghost)").error?.code, "unknown-column");
  // Partial indexes are built from the rows their predicate covers.
  const partial = engine.execute("create index partial on t8(a8) where a8 > 0");
  assert.equal(partial.statement, "create-index");

  // The unique index is enforced by later inserts.
  engine.execute("insert into t8 values (1, 2, 'x')");
  assert.throws(() => engine.execute("insert into t8 values (1, 3, 'y')"), /UNIQUE constraint failed/i);
  // A rejected insert leaves no row behind and no dangling index key.
  assert.deepEqual(engine.execute("select count(*) from t8").rows, [[1]]);

  // The index is what rejects the duplicate: the identical table shape without
  // any `UNIQUE` index accepts repeated keys, so the rejection above cannot be
  // coming from a constraint recorded at `CREATE TABLE` time.
  engine.exec("create table t8open (a8 integer, b8 integer); insert into t8open values (1, 2); insert into t8open values (1, 3)");
  assert.deepEqual(engine.execute("select count(*) from t8open").rows, [[2]]);

  // The storage-level constraint path stays independent: a column declared
  // `UNIQUE` in `CREATE TABLE` rejects a duplicate even with no explicit index.
  engine.exec("create table t8col (a8 integer unique, b8 integer); insert into t8col values (1, 2)");
  assert.throws(() => engine.execute("insert into t8col values (1, 3)"), /UNIQUE constraint failed/i);

  // SQLite also rejects building a unique index over existing duplicates.
  engine.exec("create table dup (a integer, b text); insert into dup values (1, 'x'); insert into dup values (1, 'y')");
  const duplicateKey = engine.tryExecute("create unique index dup_a on dup(a)");
  assert.equal(duplicateKey.error?.code, "unique-constraint");
  assert.match(duplicateKey.error?.message ?? "", /UNIQUE constraint failed: dup.a/);

  // Index pages are rebuilt after inserts, so the exported image stays valid.
  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const names = external
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 't8' ORDER BY name")
        .all() as unknown as Array<{ name: string }>;
      assert.deepEqual(names.map((row) => row.name), ["partial", "t8all", "t8i0", "t8u"]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

test("index trees track interleaved writes to several indexed tables", () => {
  const engine = createEngine(4096);
  engine.exec(
    "create table left8 (id integer primary key, key integer, label text); \
     create table right8 (id integer primary key, key integer, label text); \
     create index left8_key on left8(key); \
     create unique index right8_key on right8(key)",
  );

  // Every statement commits before it returns unless a caller opened a
  // transaction, so a snapshot always carries only closed scopes.
  assert.equal(engine.execute("begin").statement, "begin");
  assert.equal(engine.tryExecute("commit").ok, true);

  const workspaceHandle = workspace();
  try {
    // Interleave writes across two indexed tables. Every insert rebuilds all
    // index b-trees from the live key sets before returning, so each snapshot
    // is already consistent with the rows written so far.
    for (let round = 0; round < 100; round += 1) {
      engine.execute(`insert into left8 (key, label) values (${round}, 'l${round}')`);
      engine.execute(`insert into right8 (key, label) values (${round}, 'r${round}')`);
      if (round === 48) {
        writeFileSync(workspaceHandle.path, engine.snapshot());
        const mid = new BetterSqlite(workspaceHandle.path);
        try {
          assert.equal(mid.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
          // `INDEXED BY` forces an index scan, so a stale or dropped index
          // tree shows up as a wrong count instead of passing silently.
          const leftCount = mid.prepare("SELECT count(*) AS n FROM left8 INDEXED BY left8_key").get() as unknown as { n: number };
          const rightCount = mid.prepare("SELECT count(*) AS n FROM right8 INDEXED BY right8_key").get() as unknown as { n: number };
          assert.equal(leftCount.n, 49);
          assert.equal(rightCount.n, 49);
        } finally {
          mid.close();
        }
      }
    }

    // A failed write on the far end of the run must not disturb either image:
    // the unique index still rejects and the row set stays at 100.
    assert.throws(() => engine.execute("insert into right8 (key, label) values (99, 'dup')"), /UNIQUE constraint failed/i);

    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const leftCount = external.prepare("SELECT count(*) AS n FROM left8 INDEXED BY left8_key").get() as unknown as { n: number };
      const rightCount = external.prepare("SELECT count(*) AS n FROM right8 INDEXED BY right8_key").get() as unknown as { n: number };
      assert.equal(leftCount.n, 100);
      assert.equal(rightCount.n, 100);

      // A keyed range scan through the index returns exactly the written rows.
      const keys = external
        .prepare("SELECT key FROM left8 INDEXED BY left8_key WHERE key BETWEEN 10 AND 12 ORDER BY key")
        .all() as unknown as Array<{ key: number }>;
      assert.deepEqual(keys.map((row) => row.key), [10, 11, 12]);

      const names = external
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as unknown as Array<{ name: string }>;
      assert.deepEqual(names.map((row) => row.name), ["left8_key", "right8_key"]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

// Real SQLite agrees: `LIMIT -2` returns every row, `LIMIT -0` returns none.
test("a negative limit means no upper bound", () => {
  const engine = createEngine(4096);
  engine.execute("create table t (a integer)");
  engine.execute("insert into t values (1), (2)");
  assert.deepEqual(engine.execute("select a from t order by a limit -2").rows, [[1], [2]]);
  assert.deepEqual(engine.execute("select a from t order by a limit -1").rows, [[1], [2]]);
  assert.deepEqual(engine.execute("select a from t order by a limit -0").rows, []);
});

// The implicit integer primary key is readable through all three aliases, is
// hidden from `SELECT *`, and is shadowed by a declared column of that name.
test("rowid, _rowid_ and oid expose the implicit primary key", () => {
  const engine = createEngine(4096);
  engine.execute("create table r (a integer)");
  engine.execute("insert into r values (10), (20)");
  assert.deepEqual(engine.execute("select rowid, _rowid_, oid from r").rows, [
    [1, 1, 1],
    [2, 2, 2],
  ]);
  assert.deepEqual(engine.execute("select * from r").columns, ["a"]);
  assert.deepEqual(engine.execute("select r.rowid from r order by rowid desc").rows, [[2], [1]]);
  engine.execute("create table shadow (rowid integer, a integer)");
  engine.execute("insert into shadow values (7, 1)");
  assert.deepEqual(engine.execute("select rowid from shadow").rows, [[7]]);
});

// SQLite keeps text and composite primary keys as rowid tables; the key is
// materialized as an automatic unique index instead of a clustered layout.
test("text and composite primary keys are automatic unique indexes", () => {
  const engine = createEngine(4096);
  engine.execute("create table tp(k text primary key, v integer)");
  engine.execute("insert into tp values ('a', 1), ('b', 2)");
  assert.deepEqual(engine.execute("select k, v from tp").rows, [["a", 1], ["b", 2]]);
  assert.deepEqual(engine.execute("select rowid from tp").rows, [[1], [2]]);
  assert.equal(engine.tryExecute("insert into tp values ('a', 3)").error?.code, "storage");

  engine.execute("create table pkab(a integer, b integer, primary key (a, b))");
  engine.execute("insert into pkab values (1, 1), (2, 2)");
  assert.deepEqual(engine.execute("select a, b from pkab").rows, [[1, 1], [2, 2]]);
  assert.equal(engine.tryExecute("insert into pkab values (1, 1)").error?.code, "storage");

  // A lone declared INTEGER key stays the rowid alias.
  engine.execute("create table ta(a integer, primary key (a))");
  engine.execute("insert into ta values (5)");
  assert.deepEqual(engine.execute("select rowid, a from ta").rows, [[5, 5]]);
});

// Casts follow SQLite's conversion rules for all five target types.
test("cast follows sqlite conversions", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select cast('1.5' as integer)").rows, [[1]]);
  assert.deepEqual(engine.execute("select cast('abc' as integer)").rows, [[0]]);
  assert.deepEqual(engine.execute("select cast('1e3' as integer)").rows, [[1]]);
  assert.deepEqual(engine.execute("select cast(' 12abc' as integer)").rows, [[12]]);
  assert.deepEqual(engine.execute("select cast(1.9 as integer)").rows, [[1]]);
  assert.deepEqual(engine.execute("select cast(-1.9 as integer)").rows, [[-1]]);
  assert.deepEqual(engine.execute("select cast('3.7' as real)").rows, [[3.7]]);
  assert.deepEqual(engine.execute("select cast(null as integer)").rows, [[null]]);
  assert.deepEqual(engine.execute("select cast(1 as text)").rows, [["1"]]);
  assert.deepEqual(engine.execute("select cast(123 as blob)").rows, [[{ $blob: "313233" }]]);
  assert.deepEqual(engine.execute("select cast('1e3' as numeric)").rows, [[1000]]);
  assert.equal(engine.tryExecute("select cast(1 as fancytype)").error?.code, "unsupported-type");
});

// SQLite gives every set operator the same precedence, so `(A UNION B)
// INTERSECT C` is `3`; `A UNION (B INTERSECT C)` would return `1, 2, 3`.
test("compound select folds left to right", () => {
  const engine = createEngine(4096);
  engine.execute("create table c (a integer)");
  engine.execute("insert into c values (1), (2), (3)");
  const rows = engine.execute(
    "select a from c where a <= 2 union select a from c where a >= 2 intersect select a from c where a = 3",
  ).rows;
  assert.deepEqual(rows, [[3]]);
});

// SQLite projects literals directly when a `SELECT` has no `FROM` clause.
test("select without from projects literals and applies limit", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select 1").rows, [[1]]);
  assert.deepEqual(engine.execute("select 1, 2 + 3").rows, [[1, 5]]);
  assert.deepEqual(engine.execute("select 1 as a").columns, ["a"]);
  assert.deepEqual(engine.execute("select 1 limit 0").rows, []);
  assert.deepEqual(engine.execute("select 1 limit -1").rows, [[1]]);
});

// Without `FROM` a bare column is `no such column`, never a silent `NULL`.
test("select without from rejects column references", () => {
  const engine = createEngine(4096);
  assert.equal(engine.tryExecute("select missing").error?.code, "unknown-column");
  assert.equal(engine.tryExecute("select *").error?.code, "no-tables");
});

// Set operators share one precedence over constant cores, and `ALL` only
// follows `UNION` in SQLite.
test("compound select without from matches sqlite", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select 1 union select 2").rows, [[1], [2]]);
  assert.deepEqual(engine.execute("select 1 union all select 1").rows, [[1], [1]]);
  assert.deepEqual(engine.execute("select 1 intersect select 1").rows, [[1]]);
  assert.deepEqual(engine.execute("select 1 except select 2").rows, [[1]]);
  assert.deepEqual(engine.execute("select 1 union select 2 intersect select 2").rows, [[2]]);
  assert.equal(engine.tryExecute("select 1 intersect all select 1").error?.code, "syntax");
  assert.equal(engine.tryExecute("select 1 except all select 1").error?.code, "syntax");
});

// `FROM (SELECT 1)` binds a one-row derived table without an alias.
test("derived table without alias projects its row", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select * from (select 1)").rows, [[1]]);
  assert.deepEqual(engine.execute("select 1 from (select 1)").rows, [[1]]);
});

// `LIKE` folds ASCII case only, `_` takes exactly one character, and a
// trailing `%` also matches the empty string.
test("like follows sqlite wildcard and case rules", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select 'abc' like 'A%'").rows, [[1]]);
  assert.deepEqual(engine.execute("select 'Ü' like 'ü'").rows, [[0]]);
  assert.deepEqual(engine.execute("select 'ab' like 'a_'").rows, [[1]]);
  assert.deepEqual(engine.execute("select 'abc' like 'a_'").rows, [[0]]);
  assert.deepEqual(engine.execute("select '' like '%'").rows, [[1]]);
  assert.deepEqual(engine.execute("select null like 'a%'").rows, [[null]]);
  assert.deepEqual(engine.execute("select 'x' not like 'a%'").rows, [[1]]);
  assert.deepEqual(engine.execute("select 1 like '1'").rows, [[1]]);
  assert.deepEqual(engine.execute("select 'a%b' like 'a\\%b' escape '\\'").rows, [[1]]);
  assert.deepEqual(engine.execute("select 'axb' like 'a\\%b' escape '\\'").rows, [[0]]);
});

// `IS TRUE` is the truthiness test, not `= 1`, and it never yields `NULL`.
test("is true and is false follow sqlite truthiness", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select 1 is true, 2 is true, -1 is true").rows, [[1, 1, 1]]);
  assert.deepEqual(engine.execute("select 0 is true, 0.0 is true").rows, [[0, 0]]);
  assert.deepEqual(engine.execute("select '1' is true, '' is true, 'a' is true").rows, [[1, 0, 0]]);
  assert.deepEqual(engine.execute("select x'01' is true, x'31' is true").rows, [[0, 1]]);
  assert.deepEqual(engine.execute("select 1 is false, 2 is false, 0 is false").rows, [[0, 0, 1]]);
  assert.deepEqual(engine.execute("select null is true, null is not true").rows, [[0, 1]]);
  assert.deepEqual(engine.execute("select null is false, null is not false").rows, [[0, 1]]);
});

// `||` binds tighter than `*` in SQLite, is left-associative, and yields TEXT.
test("concat operator follows sqlite precedence", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select 1 || 2 * 3").rows, [[36]]);
  assert.deepEqual(engine.execute("select 1 || 2 + 3").rows, [[15]]);
  assert.deepEqual(engine.execute("select 2 + 3 || 4").rows, [[36]]);
  assert.deepEqual(engine.execute("select 'a' || 'b' = 'ab'").rows, [[1]]);
  assert.deepEqual(engine.execute("select 1 << 2 || 3").rows, [[8388608]]);
  assert.deepEqual(engine.execute("select 1 || 2 || 3").rows, [["123"]]);
  assert.deepEqual(engine.execute("select -1 || 2").rows, [["-12"]]);
  assert.deepEqual(engine.execute("select 1 || 2, typeof(1 || 2)").rows, [["12", "text"]]);
  assert.deepEqual(engine.execute("select 1.5 || 'x', 2.0 || '', 1e-5 || ''").rows, [["1.5x", "2.0", "1.0e-05"]]);
  assert.deepEqual(engine.execute("select null || 'x', 'x' || null").rows, [[null, null]]);
  assert.deepEqual(engine.execute("select x'6162' || 'c'").rows, [["abc"]]);
});

// Arithmetic, casts, `IS TRUE` and aggregates share the longest numeric prefix.
test("numeric prefix conversion matches sqlite", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select '2abc' + 1, 'abc' + 1, ' 12abc' * 2").rows, [[3, 1, 24]]);
  assert.deepEqual(engine.execute("select x'31' + 1, cast(x'31' as integer), cast(x'312e35' as numeric)").rows, [[2, 1, 1.5]]);
  assert.deepEqual(engine.execute("select cast('2abc' as numeric), cast(0.30000000000000004 as text)").rows, [[2, "0.3"]]);
  assert.deepEqual(engine.execute("select '2abc' is true, '0abc' is true, '2abc' = 2").rows, [[1, 0, 0]]);
  engine.execute("create table v(x)");
  engine.execute("insert into v values ('2abc'), ('10'), (null), (x'31')");
  assert.deepEqual(engine.execute("select sum(x), avg(x), typeof(sum(x)) from v").rows, [[13, 13 / 3, "real"]]);
  // `total()` keeps the real type and returns 0.0 for an empty input.
  assert.deepEqual(engine.execute("select total(x), typeof(total(x)) from v").rows, [[13, "real"]]);
  assert.deepEqual(engine.execute("select total(x), sum(x) from v where 0").rows, [[0, null]]);
});

// Bitwise operators, `group_concat`, `hex`, `quote`, `random` and `randomblob`.
test("bitwise and inspection functions follow sqlite", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("select 5 & 3, 1 | 2, ~1, ~1 || 2").rows, [[1, 3, -2, "-22"]]);
  assert.deepEqual(engine.execute("select '2abc' & 3, 1.9 & 3, ~null, null & 3").rows, [[2, 1, null, null]]);
  // `^` is not a SQLite token.
  assert.equal(engine.tryExecute("select 5 ^ 3").error?.code, "syntax");
  engine.execute("create table t(x)");
  engine.execute("insert into t values ('a'), (null), ('b'), (3), (x'63')");
  assert.deepEqual(engine.execute("select group_concat(x), group_concat(x, '-') from t").rows, [["a,b,3,c", "a-b-3-c"]]);
  assert.deepEqual(engine.execute("select group_concat(x, null), typeof(group_concat(x)) from t").rows, [["ab3c", "text"]]);
  assert.deepEqual(engine.execute("select group_concat(x) from t where 0").rows, [[null]]);
  assert.deepEqual(engine.execute("select hex(255), hex(x'0102'), hex(null)").rows, [["323535", "0102", ""]]);
  assert.deepEqual(engine.execute("select quote('It''s'), quote(null), quote(x'0102'), quote(1.5)").rows, [["'It''s'", "NULL", "X'0102'", "1.5"]]);
  assert.deepEqual(engine.execute("select typeof(random()), length(randomblob(4))").rows, [["integer", 4]]);
});

// `INSERT ... DEFAULT VALUES` inserts one row built purely from the defaults.
test("insert default values fills every column default", () => {
  const engine = createEngine(4096);
  engine.execute("create table dv(a integer default 7, b text default 'x', c integer)");
  engine.execute("insert into dv default values");
  assert.deepEqual(engine.execute("select a, b, c from dv").rows, [[7, "x", null]]);
  engine.execute("create table dvpk(a integer primary key, b default 3)");
  engine.execute("insert into dvpk default values");
  assert.deepEqual(engine.execute("select rowid, a, b from dvpk").rows, [[1, 1, 3]]);
  engine.execute("create table nn(a text not null)");
  assert.equal(engine.tryExecute("insert into nn default values").error?.code, "storage");
});

// `USING` exposes the shared column once, and an outer join coalesces it so
// an unmatched right row still shows its own key while `l.id` stays NULL.
test("join using folds the shared column and coalesces outer rows", () => {
  const engine = createEngine(4096);
  engine.execute("create table l(id integer, lv text)");
  engine.execute("insert into l values (1, 'a'), (2, 'b'), (2, 'c')");
  engine.execute("create table r(id integer, rv text)");
  engine.execute("insert into r values (2, 'B'), (3, 'C'), (3, 'D')");
  const right = engine.execute("select * from l right join r using(id)");
  assert.deepEqual(right.columns, ["id", "lv", "rv"]);
  assert.deepEqual(right.rows, [[2, "b", "B"], [2, "c", "B"], [3, null, "C"], [3, null, "D"]]);
  assert.deepEqual(engine.execute("select l.id, r.id from l right join r using(id)").rows, [
    [2, 2], [2, 2], [null, 3], [null, 3],
  ]);
  assert.deepEqual(engine.execute("select * from l full outer join r using(id)").rows, [
    [1, "a", null], [2, "b", "B"], [2, "c", "B"], [3, null, "C"], [3, null, "D"],
  ]);
  assert.deepEqual(engine.execute("select id from l full join r using(id) where r.id is null").rows, [[1]]);
});

// `NATURAL` matches every shared column name (case-insensitively), keeps the
// left order, and appends the right columns that do not participate.
test("natural join folds common columns including case variants", () => {
  const engine = createEngine(4096);
  engine.execute("create table p(a integer, b integer, c text)");
  engine.execute("insert into p values (1, 2, 'p')");
  engine.execute("create table q(c text, id integer, b integer, d text)");
  engine.execute("insert into q values ('p', 9, 2, 'q')");
  const joined = engine.execute("select * from p natural join q");
  assert.deepEqual(joined.columns, ["a", "b", "c", "id", "d"]);
  assert.deepEqual(joined.rows, [[1, 2, "p", 9, "q"]]);
  engine.execute("create table t(i integer, j text)");
  engine.execute("insert into t values (1, 'y')");
  engine.execute("create table u(ID integer, J text, k text)");
  engine.execute("insert into u values (1, 'y', 'z')");
  assert.deepEqual(engine.execute("select * from t natural join u").columns, ["i", "j", "ID", "k"]);
  // No shared column degenerates to a product.
  engine.execute("create table n1(x integer)");
  engine.execute("insert into n1 values (1), (2)");
  engine.execute("create table n2(y integer)");
  engine.execute("insert into n2 values (10), (20)");
  assert.equal(engine.execute("select * from n1 natural join n2").rows.length, 4);
});

// `FULL` is left-major with unmatched right rows appended, and it preserves
// duplicate multiplicities instead of de-duplicating whole rows.
test("full and right joins keep duplicates and pad the missing side", () => {
  const engine = createEngine(4096);
  engine.execute("create table f1(id integer)");
  engine.execute("insert into f1 values (1), (1)");
  engine.execute("create table f2(id integer)");
  engine.execute("insert into f2 values (1), (1), (2)");
  assert.deepEqual(engine.execute("select id from f1 full join f2 using(id)").rows, [[1], [1], [1], [1], [2]]);
  engine.execute("create table l(id integer, v text)");
  engine.execute("insert into l values (1, 'a'), (2, 'b')");
  engine.execute("create table r(id integer, w text)");
  engine.execute("insert into r values (2, 'B'), (1, 'A')");
  assert.deepEqual(engine.execute("select * from l right join r on l.id = r.id").rows, [
    [1, "a", 1, "A"], [2, "b", 2, "B"],
  ]);
  // A join without `ON` or `USING` is a product, even for `RIGHT JOIN`.
  assert.deepEqual(engine.execute("select * from l right join r").rows, [
    [1, "a", 2, "B"], [1, "a", 1, "A"], [2, "b", 2, "B"], [2, "b", 1, "A"],
  ]);
});

// `USING` needs both sides to have the column, and `NATURAL` cannot take an
// `ON` or `USING` clause.
test("join using and natural report structural errors", () => {
  const engine = createEngine(4096);
  engine.execute("create table one(x integer)");
  engine.execute("insert into one values (1)");
  engine.execute("create table two(x integer)");
  engine.execute("insert into two values (1)");
  assert.equal(engine.tryExecute("select * from one join two using(nope)").error?.code, "unknown-column");
  assert.equal(engine.tryExecute("select * from one join two using()").error?.code, "syntax");
  assert.equal(engine.tryExecute("select * from one natural join two on one.x = two.x").error?.code, "syntax");
  assert.equal(engine.tryExecute("select * from one natural join two using(x)").error?.code, "syntax");
});

// A chained `USING` keeps the merged column addressable across the next join,
// and a multi-column `USING` may list its columns in either order.
test("chained and multi-column using joins keep the merged column", () => {
  const engine = createEngine(4096);
  engine.execute("create table m1(a integer, b integer)");
  engine.execute("insert into m1 values (1, 2)");
  engine.execute("create table m2(a integer, c integer)");
  engine.execute("insert into m2 values (1, 3)");
  engine.execute("create table m3(b integer, a integer, d integer)");
  engine.execute("insert into m3 values (2, 1, 4)");
  const chained = engine.execute("select * from m1 join m2 using(a) join m3 using(a)");
  assert.deepEqual(chained.columns, ["a", "b", "c", "b", "d"]);
  assert.deepEqual(chained.rows, [[1, 2, 3, 2, 4]]);
  assert.deepEqual(engine.execute("select * from m1 join m2 using(a) right join m3 using(a)").rows, [[1, 2, 3, 2, 4]]);

  engine.execute("create table p(a integer, b integer, c text)");
  engine.execute("insert into p values (1, 2, 'p')");
  engine.execute("create table q(c text, id integer, b integer, d text)");
  engine.execute("insert into q values ('p', 9, 2, 'q')");
  for (const order of ["using(b,c)", "using(c,b)"]) {
    const joined = engine.execute(`select * from p join q ${order}`);
    assert.deepEqual(joined.columns, ["a", "b", "c", "id", "d"]);
    assert.deepEqual(joined.rows, [[1, 2, "p", 9, "q"] as (number | string)[]]);
  }
});

// SQLite evaluates every right-hand side against the row as it was before the
// statement and only then applies the assignments, so a swap is a real swap.
test("update evaluates assignments against the pre-statement row", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(a integer, b integer, c integer)");
  engine.execute("insert into t values (1, 2, 3)");
  const swapped = engine.execute("update t set a = b, b = a");
  assert.equal(swapped.statement, "update");
  assert.equal(swapped.affected, 1);
  assert.deepEqual(engine.execute("select a, b, c from t").rows, [[2, 1, 3]]);
  // A rotation proves the snapshot is taken once, not per assignment.
  engine.execute("update t set a = b, b = c, c = a");
  assert.deepEqual(engine.execute("select a, b, c from t").rows, [[1, 3, 2]]);
  // A repeated left-hand column keeps the last value, still reading old cells.
  engine.execute("update t set a = 7, a = b");
  assert.deepEqual(engine.execute("select a, b from t").rows, [[3, 3]]);
});

test("update and delete report the exact affected count", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(a integer, b text)");
  engine.execute("insert into t values (1, 'x'), (2, 'y'), (3, 'z')");
  assert.equal(engine.execute("update t set b = 'q' where a = 99").affected, 0);
  assert.equal(engine.execute("update t set b = 'q' where a = 2").affected, 1);
  assert.equal(engine.execute("update t set b = 'q' where 1").affected, 3);
  assert.equal(engine.execute("update t set b = b").affected, 3);
  assert.equal(engine.execute("delete from t where a = 99").affected, 0);
  assert.equal(engine.execute("delete from t").affected, 3);
  assert.deepEqual(engine.execute("select * from t").rows, []);
});

// A constraint that fails on the third row must leave the first two untouched.
test("update rolls back every row when a constraint fails", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(id integer primary key, v integer not null check(v > 0), u integer unique)");
  engine.execute("insert into t values (1, 5, 10), (2, 6, 20), (3, 7, 30)");
  const before = engine.execute("select id, v, u from t").rows;
  const check = engine.tryExecute("update t set v = v - 10");
  assert.equal(check.error?.code, "constraint-failed");
  assert.equal(check.error?.clause, "CHECK");
  assert.deepEqual(engine.execute("select id, v, u from t").rows, before);
  const unique = engine.tryExecute("update t set u = 7");
  assert.equal(unique.error?.code, "unique-constraint");
  assert.deepEqual(engine.execute("select id, v, u from t").rows, before);
  const notNull = engine.tryExecute("update t set v = null");
  assert.equal(notNull.error?.code, "constraint-failed");
  assert.deepEqual(engine.execute("select id, v, u from t").rows, before);
});

// SQLite walks an update in ascending rowid order, so a downward shift succeeds
// while an upward shift collides with a row it has not moved yet.
test("update of a rowid alias runs in ascending order", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(id integer primary key, v text unique)");
  engine.execute("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
  engine.execute("update t set id = id - 1");
  assert.deepEqual(engine.execute("select id, v from t").rows, [[0, "a"], [1, "b"], [2, "c"]]);
  const before = engine.execute("select id, v from t").rows;
  const error = engine.tryExecute("update t set id = id + 1");
  assert.equal(error.error?.code, "unique-constraint");
  assert.deepEqual(engine.execute("select id, v from t").rows, before);
});

test("delete recycles the largest vacated rowid", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(v text)");
  engine.execute("insert into t values ('a'), ('b'), ('c')");
  assert.equal(engine.execute("delete from t where rowid = 3").affected, 1);
  assert.deepEqual(engine.execute("insert into t values ('d')").rows, [[3]]);
  engine.execute("delete from t");
  assert.deepEqual(engine.execute("select v from t").rows, []);
  assert.deepEqual(engine.execute("insert into t values ('e')").rows, [[1]]);
  assert.deepEqual(engine.execute("select rowid, v from t").rows, [[1, "e"]]);
});

test("returning reports new values for update and old values for delete", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(id integer primary key, v integer)");
  engine.execute("insert into t values (1, 10), (2, 20), (3, 30)");
  const updated = engine.execute("update t set v = v + 1 where id >= 2 returning id, v");
  assert.deepEqual(updated.columns, ["id", "v"]);
  assert.deepEqual(updated.rows, [[2, 21], [3, 31]]);
  assert.equal(updated.affected, 2);
  const starred = engine.execute("update t set v = v where id = 1 returning *");
  assert.deepEqual(starred.columns, ["id", "v"]);
  assert.deepEqual(starred.rows, [[1, 10]]);
  const removed = engine.execute("delete from t returning id as gone");
  assert.deepEqual(removed.columns, ["gone"]);
  assert.deepEqual(removed.rows, [[1], [2], [3]]);
  assert.equal(removed.affected, 3);
  const empty = engine.execute("update t set v = 1 where id = 99 returning id");
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(engine.execute("insert into t values (4, 40) returning id, v").rows, [[4, 40]]);
});

// The rewritten table and its automatic unique index must still read back
// correctly through an independent SQLite build.
test("update and delete leave a reopenable file", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(k text primary key, n integer not null check(n > 0))");
  engine.execute("create index ix on t(n)");
  engine.execute("insert into t values ('a', 1), ('b', 2), ('c', 3), ('d', 4)");
  engine.execute("update t set k = 'bb', n = 20 where k = 'b'");
  engine.execute("delete from t where k = 'c'");
  engine.execute("insert into t values ('c', 30)");
  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT k, n FROM t ORDER BY n").all(), [
        { k: "a", n: 1 },
        { k: "d", n: 4 },
        { k: "bb", n: 20 },
        { k: "c", n: 30 },
      ]);
      assert.deepEqual(external.prepare("SELECT k FROM t WHERE k = 'bb'").all(), [{ k: "bb" }]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

test("update and delete reject the shapes sqlite also rejects", () => {
  const engine = createEngine(4096);
  engine.execute("create table t(a integer, b integer)");
  engine.execute("insert into t values (1, 2)");
  assert.equal(engine.tryExecute("update t set t.a = 1").error?.code, "syntax");
  const fallback = engine.tryExecute("update t set a = default");
  assert.equal(fallback.error?.code, "unsupported-clause");
  assert.equal(fallback.error?.clause, "DEFAULT");
  assert.equal(engine.tryExecute("update or replace t set a = 1").error?.code, "unsupported-clause");
  assert.equal(engine.tryExecute("update t set (a, b) = (3, 4)").error?.code, "unsupported-clause");
  assert.equal(engine.tryExecute("delete from t order by a").error?.code, "unsupported-clause");
});


test("drop table clears catalog rows, index pages and its sequence row", () => {
  const engine = createEngine(4096);
  engine.exec(
    "CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT UNIQUE); \
     CREATE INDEX ix ON c(k); \
     CREATE TABLE d(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT)",
  );
  engine.exec("INSERT INTO c(k) VALUES ('x'); INSERT INTO d(k) VALUES ('y')");
  assert.deepEqual(engine.execute("select name, seq from sqlite_sequence").rows, [
    ["c", 1],
    ["d", 1],
  ]);

  const dropped = engine.execute("DROP TABLE c");
  assert.equal(dropped.statement, "drop-table");
  assert.equal(dropped.affected, 1);
  // The table row, the explicit index row and the automatic UNIQUE row all
  // leave sqlite_master in the same statement; sqlite_sequence itself remains
  // but no longer carries a row for `c`.
  assert.deepEqual(
    engine.execute("select type, name, tbl_name from sqlite_master").rows,
    [
      ["table", "sqlite_sequence", "sqlite_sequence"],
      ["table", "d", "d"],
    ],
  );
  assert.deepEqual(engine.execute("select * from sqlite_sequence").rows, [["d", 1]]);
  assert.equal(engine.tryExecute("select * from c").error?.code, "unknown-table");
  assert.equal(engine.execute("drop table if exists c").affected, 0);
  // The freed root page is reused by the next table, exactly like SQLite.
  engine.execute("CREATE TABLE e(a INTEGER)");
  assert.deepEqual(engine.execute("select rootpage from sqlite_master where name = 'e'").rows, [[2]]);

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(), [
        { name: "d" },
        { name: "e" },
        { name: "sqlite_sequence" },
      ]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

test("drop table if exists and system tables keep sqlite's refusal shapes", () => {
  const engine = createEngine();
  const master = engine.tryExecute("drop table sqlite_master");
  assert.equal(master.error?.code, "readonly-system-table");
  assert.equal(master.error?.message, "table sqlite_master may not be dropped");
  // `sqlite_sequence` only refuses once an AUTOINCREMENT table brought it into
  // being; before that SQLite reports an ordinary missing table.
  assert.equal(engine.tryExecute("drop table sqlite_sequence").error?.code, "unknown-table");
  engine.execute("CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT)");
  assert.equal(engine.tryExecute("drop table sqlite_sequence").error?.code, "readonly-system-table");
  assert.equal(engine.tryExecute("drop table nope").error?.code, "unknown-table");
  const missing = engine.execute("drop table if exists nope");
  assert.equal(missing.affected, 0);
  assert.deepEqual(engine.execute("select sql from sqlite_master where name = 'c'").rows, [["CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT)"]]);
  // sqlite_master is an ordinary rowid table, so rowid resolves and `*` still
  // projects the five stored columns.
  assert.deepEqual(engine.execute("select rowid, name from sqlite_master order by rowid").rows, [
    [1, "c"],
    [2, "sqlite_sequence"],
  ]);
  assert.deepEqual(engine.execute("select * from sqlite_master").columns, ["type", "name", "tbl_name", "rootpage", "sql"]);
});

test("drop index removes explicit indexes but never automatic ones", () => {
  const engine = createEngine(4096);
  engine.exec("create table t(a text unique, b integer); create index ix on t(b)");
  const automatic = engine.tryExecute("drop index sqlite_autoindex_t_1");
  assert.equal(automatic.error?.code, "autoindex-immutable");
  assert.equal(automatic.error?.message, "index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped");
  // Even `IF EXISTS` does not soften the refusal, matching SQLite 3.49.1.
  assert.equal(engine.tryExecute("drop index if exists sqlite_autoindex_t_1").error?.code, "autoindex-immutable");
  assert.equal(engine.tryExecute("drop index nope").error?.code, "unknown-index");
  assert.equal(engine.execute("drop index if exists nope").affected, 0);

  const dropped = engine.execute("drop index ix");
  assert.equal(dropped.statement, "drop-index");
  assert.equal(dropped.affected, 1);
  assert.deepEqual(engine.execute("select name, sql from sqlite_master where type = 'index'").rows, [
    ["sqlite_autoindex_t_1", null],
  ]);
  // The automatic index is the constraint, so UNIQUE still rejects a duplicate.
  engine.execute("insert into t values ('a', 1)");
  assert.throws(() => engine.execute("insert into t values ('a', 2)"), /UNIQUE constraint failed/i);
  assert.deepEqual(engine.execute("select count(*) from t").rows, [[1]]);
});

test("rename table rewrites the stored DDL text byte for byte", () => {
  const engine = createEngine(4096);
  engine.exec("CREATE TABLE t ( a INTEGER , b TEXT UNIQUE ); CREATE INDEX Ix ON t ( b )");
  const renamed = engine.execute("alter table t rename to u");
  assert.equal(renamed.statement, "alter-table");
  assert.equal(renamed.affected, 1);
  // SQLite rewrites only the table-name token, always quoting the new name and
  // leaving every other byte of the stored DDL untouched.
  assert.deepEqual(engine.execute("select name, tbl_name, sql from sqlite_master order by rowid").rows, [
    ["u", "u", 'CREATE TABLE "u" ( a INTEGER , b TEXT UNIQUE )'],
    ["sqlite_autoindex_u_1", "u", null],
    ["Ix", "u", 'CREATE INDEX Ix ON "u" ( b )'],
  ]);
  engine.execute("insert into u values (1, 'x')");
  assert.throws(() => engine.execute("insert into u values (2, 'x')"), /UNIQUE constraint failed/i);
  assert.equal(engine.tryExecute("alter table u rename to u").error?.code, "table-exists");
  assert.equal(engine.tryExecute("alter table u rename to sqlite_x").error?.code, "reserved-name");
  assert.equal(engine.tryExecute("alter table nope rename to v").error?.code, "unknown-table");
  assert.equal(engine.tryExecute("alter table sqlite_master rename to v").error?.code, "readonly-system-table");

  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const schema = external.prepare("SELECT name, sql FROM sqlite_master ORDER BY rowid").all() as unknown as {
        name: string;
        sql: string | null;
      }[];
      assert.deepEqual(schema, [
        { name: "u", sql: 'CREATE TABLE "u" ( a INTEGER , b TEXT UNIQUE )' },
        { name: "sqlite_autoindex_u_1", sql: null },
        { name: "Ix", sql: 'CREATE INDEX Ix ON "u" ( b )' },
      ]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});

test("rename table moves the sequence row and keeps autoincrement counting", () => {
  const engine = createEngine();
  engine.exec("create table a(x integer primary key autoincrement); insert into a default values");
  engine.execute("alter table a rename to b");
  assert.deepEqual(engine.execute("select name, seq from sqlite_sequence").rows, [["b", 1]]);
  engine.execute("insert into b default values");
  assert.deepEqual(engine.execute("select max(x) from b").rows, [[2]]);
  const externalPath = workspace();
  try {
    writeFileSync(externalPath.path, engine.snapshot());
    const external = new BetterSqlite(externalPath.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT name, seq FROM sqlite_sequence").all(), [{ name: "b", seq: 2 }]);
    } finally {
      external.close();
    }
  } finally {
    externalPath.dispose();
  }
});

test("rename column rewrites checks and index text but never string literals", () => {
  const engine = createEngine();
  engine.exec("CREATE TABLE t(t INTEGER, x TEXT DEFAULT 'a', y TEXT, CHECK (t > 0 AND x <> 't')); CREATE INDEX ix ON t(x, t)");
  engine.execute("alter table t rename column t to tt");
  assert.deepEqual(engine.execute("select name, sql from sqlite_master order by rowid").rows, [
    ["t", "CREATE TABLE t(tt INTEGER, x TEXT DEFAULT 'a', y TEXT, CHECK (tt > 0 AND x <> 't'))"],
    ["ix", "CREATE INDEX ix ON t(x, tt)"],
  ]);
  engine.execute("insert into t(tt) values (1)");
  assert.deepEqual(engine.execute("select * from t").rows, [[1, "a", null]]);
  assert.equal(engine.tryExecute("alter table t rename column ghost to g").error?.code, "unknown-column");
  assert.equal(engine.tryExecute("alter table t rename column tt to x").error?.code, "duplicate-column");
  // Renaming to the same name is a no-op, as in SQLite.
  const same = engine.execute("alter table t rename column tt to tt");
  assert.equal(same.statement, "alter-table");
});

test("add column default values reach existing rows and extend select order", () => {
  const engine = createEngine(4096);
  engine.exec("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1), (2)");
  engine.execute("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'z'");
  assert.deepEqual(engine.execute("select * from t").rows, [
    [1, "z"],
    [2, "z"],
  ]);
  assert.deepEqual(engine.execute("select * from t").columns, ["a", "b"]);
  // The stored DDL gains the column definition as written, before the closing
  // parenthesis, and nothing else is re-rendered.
  assert.deepEqual(engine.execute("select sql from sqlite_master where name = 't'").rows, [["CREATE TABLE t(a INTEGER, b TEXT DEFAULT 'z')"]]);

  // A NOT NULL column without a default is only refused when a row would read
  // back NULL, matching SQLite 3.49.1.
  const rejected = engine.tryExecute("alter table t add column c integer not null");
  assert.equal(rejected.error?.code, "invalid-alter");
  assert.equal(rejected.error?.message, "Cannot add a NOT NULL column with default value NULL");
  assert.equal(engine.tryExecute("alter table t add column b integer").error?.code, "duplicate-column");
  assert.equal(engine.tryExecute("alter table t add column c integer primary key").error?.code, "invalid-alter");
  assert.equal(engine.tryExecute("alter table t add column c integer unique").error?.code, "invalid-alter");
  // On an empty table the identical definition is accepted.
  engine.exec("CREATE TABLE empty(a INTEGER); ALTER TABLE empty ADD COLUMN b TEXT NOT NULL");
  assert.deepEqual(engine.execute("select sql from sqlite_master where name = 'empty'").rows, [["CREATE TABLE empty(a INTEGER, b TEXT NOT NULL)"]]);
});

test("drop column rewrites rows and stored schema like better-sqlite3", () => {
  const engine = createEngine();
  const steps = [
    "create table t (id integer primary key, a text, b integer, note text)",
    "insert into t (a, b, note) values ('x', 1, 'n')",
    "insert into t (a, b, note) values ('y', 2, null)",
    "alter table t drop column b",
    "insert into t (a, note) values ('z', 'm')",
    "update t set note = 'q' where id = 1",
    "create table kept (a text, b text, check (b <> ''))",
    "alter table kept drop column a",
    "create table inline (a text check (a <> ''), b text)",
    "alter table inline drop column a",
  ];
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of [
      "select id, a, note from t order by id",
      "select sql from sqlite_master where name = 't'",
      "select sql from sqlite_master where name in ('kept', 'inline') order by name",
    ]) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });

  // Every definition that still reads the column is refused on both sides.
  const refused: Array<{ setup: string; drop: string; code: string }> = [
    { setup: "create table k1 (id integer primary key, a text)", drop: "alter table k1 drop column id", code: "invalid-alter" },
    { setup: "create table k2 (id integer primary key, a text)", drop: "alter table k2 drop column nope", code: "unknown-column" },
    { setup: "create table u (a text unique, b text)", drop: "alter table u drop column a", code: "invalid-alter" },
    { setup: "create table v (a text)", drop: "alter table v drop column a", code: "invalid-alter" },
    { setup: "create table w (a text, b text); create index wx on w (a)", drop: "alter table w drop column a", code: "invalid-alter" },
    { setup: "create table x (a text, b text, check (a <> ''))", drop: "alter table x drop column a", code: "invalid-alter" },
    { setup: "create table vt (a text, b text); create view vv as select a from vt", drop: "alter table vt drop column a", code: "invalid-alter" },
    {
      setup: "create table tg (a text, b text); create table lt (x text); create trigger tr after insert on tg begin update lt set x = new.a; end",
      drop: "alter table tg drop column a",
      code: "invalid-alter",
    },
  ];
  for (const { setup, drop, code } of refused) {
    withOracle([setup], (db) => {
      engine.exec(setup);
      assert.throws(() => db.exec(drop), drop);
      assert.equal(engine.tryExecute(drop).error?.code, code, drop);
    });
  }
});

test("attach, qualified names and detach follow better-sqlite3", () => {
  const steps = [
    "attach database ':memory:' as aux",
    "create temp table shadow (v text)",
    "create table shadow (v text)",
    "insert into temp.shadow values ('temp')",
    "insert into main.shadow values ('main')",
    "create table aux.shadow (v text)",
    "insert into aux.shadow values ('aux')",
    "create table aux.remote (v text)",
    "insert into remote values ('fallback')",
  ];
  const engine = createEngine();
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of [
      "pragma database_list",
      "select v from shadow",
      "select v from main.shadow",
      "select v from temp.shadow",
      "select v from aux.shadow",
      "select v from remote",
      "select type, name from aux.sqlite_master order by name",
      "select m.v as mv, a.v as av from main.shadow as m join aux.shadow as a on m.rowid = a.rowid",
      "select name from main.sqlite_master order by name",
      "select name from temp.sqlite_temp_master order by name",
    ]) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
  engine.execute("detach database aux");
  const detached = engine.tryExecute("select v from aux.shadow");
  assert.equal(detached.ok, false);
  assert.equal(detached.error?.message, "no such table: aux.shadow");
  const cases: Array<[string, string]> = [
    ["detach database main", "cannot detach database main"],
    ["detach database temp", "cannot detach database temp"],
    ["detach database nope", "no such database: nope"],
  ];
  for (const [sql, message] of cases) {
    const oracle = new BetterSqlite(":memory:");
    assert.throws(() => oracle.exec(sql));
    oracle.close();
    const result = engine.tryExecute(sql);
    assert.equal(result.ok, false);
    assert.equal(result.error?.message, message, sql);
  }
});

test("temp tables shadow main and vanish with the connection like better-sqlite3", () => {
  const engine = createEngine();
  const steps = [
    "create temp table t (a integer primary key, b text)",
    "create table t (a integer)",
    "insert into t values (9, 'temp')",
    "update t set b = 'changed'",
    "delete from t where a = 9",
    "insert into t values (9, 'again')",
    "drop table t",
    "insert into t values (1)",
    "create temp table t (x integer)",
    "insert into t values (5)",
  ];
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of [
      "select type, name, tbl_name, rootpage, sql from sqlite_temp_master",
      "select name, sql from sqlite_master",
      "select x from t",
    ]) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
    // `DROP TABLE` removed the temp object first, so the main table survived
    // and later writes reached it until the temp table was created again.
    assert.deepEqual(engine.execute("select name from sqlite_temp_master").rows, oracleRows(db, "select name from sqlite_temp_master"));
  });
  // A temp schema belongs to one connection, so a fresh engine starts empty.
  const other = createEngine();
  assert.deepEqual(other.execute("select name from sqlite_temp_master").rows, []);
});

test("add column with REFERENCES enforces the parent like better-sqlite3", () => {
  const engine = createEngine();
  const steps = [
    "create table parent (id integer primary key)",
    "create table plain (a integer)",
    "insert into plain values (5)",
    "pragma foreign_keys = on",
    "alter table plain add column pid integer references parent (id)",
    "insert into parent values (7)",
    "insert into plain values (8, 7)",
  ];
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of ["select a, pid from plain order by a", "select sql from sqlite_master where name = 'plain'"]) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
    assert.throws(() => db.exec("insert into plain values (9, 99)"));
    assert.throws(() => db.exec("alter table plain add column bad integer default 1 references parent (id)"));
  });
  const orphan = engine.tryExecute("insert into plain values (9, 99)");
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error?.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
  const nonNull = engine.tryExecute("alter table plain add column bad integer default 1 references parent (id)");
  assert.equal(nonNull.ok, false);
  assert.equal(nonNull.error?.message, "Cannot add a REFERENCES column with non-NULL default value");
});

interface OracleDatabase {
  exec(sql: string): void;
  prepare(sql: string): { columns(): Array<{ name: string }>; all(): Array<Record<string, unknown>> };
  close(): void;
}

function oracleRows(db: OracleDatabase, sql: string): unknown[][] {
  const statement = db.prepare(sql);
  const columns = statement.columns().map((column) => column.name);
  return statement.all().map((row) => columns.map((column) => row[column]));
}

function withOracle(steps: string[], run: (db: OracleDatabase) => void): void {
  const db = new BetterSqlite(":memory:") as unknown as OracleDatabase;
  try {
    for (const step of steps) db.exec(step);
    run(db);
  } finally {
    db.close();
  }
}

function oracleMessage(db: OracleDatabase, sql: string): string {
  try {
    db.exec(sql);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

// Timing, `WHEN`, `NEW` / `OLD`, the newest-first firing order of same-event
// triggers and the per-row rollback of a failing body all come from the live
// oracle.
test("trigger timings, WHEN clauses, order and rollback follow better-sqlite3", () => {
  const steps = [
    "create table t (id integer primary key, a, b)",
    "create table log (v)",
    "create trigger o1 after insert on t begin insert into log values (1); end",
    "create trigger o2 after insert on t begin insert into log values (2); end",
    "create trigger bi before insert on t begin insert into log values (new.a); end",
    "create trigger ai after insert on t begin insert into log values (new.rowid); end",
    "create trigger au after update on t when old.a > 5 begin insert into log values (new.a); end",
    "create trigger bd before delete on t begin insert into log values (old.id); end",
    "insert into t values (1, 6, 'x'), (2, 3, 'y')",
    "update t set a = 9 where id = 1",
    "delete from t where id = 2",
    "insert into t values (3, 1, 'z')",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  withOracle(steps, (db) => {
    assert.deepEqual(engine.execute("select v from log order by rowid").rows, oracleRows(db, "select v from log order by rowid"));
    assert.deepEqual(engine.execute("select id, a, b from t order by id").rows, oracleRows(db, "select id, a, b from t order by id"));
  });
});

test("trigger creation, drop and runtime diagnostics match better-sqlite3", () => {
  const setup = ["create table t (id integer primary key, a)", "create view vv as select id, a from t"];
  const cases = [
    "create trigger tv after insert on vv begin select 1; end",
    "create trigger tv2 before insert on vv begin select 1; end",
    "create trigger tt instead of insert on t begin select 1; end",
    "create trigger m before insert on missing begin select 1; end",
    "drop trigger t",
    "drop trigger nope",
    "create trigger nt on t begin select 1; end",
  ];
  for (const sql of cases) {
    const engine = createEngine(4096);
    for (const step of setup) engine.execute(step);
    const outcome = engine.tryExecute(sql);
    assert.equal(outcome.ok, false, sql);
    const expected = withOracleMessage(setup, sql);
    assert.equal(outcome.error?.message, expected, sql);
  }

  const duplicate = createEngine(4096);
  for (const step of setup) duplicate.execute(step);
  const firstTrigger = "create trigger d after insert on t begin select 1; end";
  duplicate.execute(firstTrigger);
  const repeated = duplicate.tryExecute(firstTrigger);
  assert.equal(repeated.error?.message, withOracleMessage([...setup, firstTrigger], firstTrigger));

  const failingSteps = [
    "create table f (id integer primary key, a)",
    "create table flog (v)",
    "create trigger bad after insert on f begin insert into flog values (new.zzz); end",
  ];
  const failing = createEngine(4096);
  for (const step of failingSteps) failing.execute(step);
  const wrongColumn = failing.tryExecute("insert into f values (1, 1), (2, 2)");
  assert.equal(wrongColumn.ok, false);
  assert.equal(wrongColumn.error?.message, withOracleMessage(failingSteps, "insert into f values (1, 1), (2, 2)"));
  assert.equal(failing.execute("select count(*) from f").rows[0][0], 0);
});

function withOracleMessage(steps: string[], sql: string): string {
  let message = "";
  withOracle(steps, (db) => {
    message = oracleMessage(db, sql);
  });
  return message;
}

test("INSTEAD OF triggers on views follow better-sqlite3", () => {
  const steps = [
    "create table base (id integer primary key, a, b)",
    "create view v as select id, a from base",
    "create trigger vi instead of insert on v begin insert into base (id, a) values (new.id, new.a); end",
    "create trigger vu instead of update on v begin update base set a = new.a where id = old.id; end",
    "create trigger vd instead of delete on v begin delete from base where id = old.id; end",
    "insert into v values (7, 8), (9, 10)",
    "update v set a = 20 where id = 7",
    "delete from v where id = 9",
  ];
  const engine = createEngine(4096);
  engine.execute("create table base (id integer primary key, a, b)");
  engine.execute("create view v as select id, a from base");
  const plain = engine.tryExecute("insert into v values (1, 2)");
  assert.equal(plain.ok, false);
  assert.equal(plain.error?.message, "cannot modify v because it is a view");
  for (const step of steps.slice(2)) engine.execute(step);
  withOracle(steps, (db) => {
    assert.deepEqual(engine.execute("select id, a from base order by id").rows, oracleRows(db, "select id, a from base order by id"));
    assert.deepEqual(engine.execute("select id, a from v order by id").rows, oracleRows(db, "select id, a from v order by id"));
  });
});

test("recursive_triggers pragma switches re-entry like better-sqlite3", () => {
  const steps = [
    "create table u (id integer primary key, a)",
    "create table b (id integer primary key, a)",
    "create trigger ta after insert on u begin insert into b values (new.id, new.a); end",
    "create trigger tb after insert on b begin insert into u values (new.id + 100, 1); end",
    "create table s (id integer primary key, a)",
    "create trigger loop after insert on s begin insert into s values (new.id + 1000, new.a); end",
    "insert into u values (1, 1)",
    "insert into s values (1, 1)",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  withOracle(steps, (db) => {
    assert.deepEqual(engine.execute("select id from u order by id").rows, oracleRows(db, "select id from u order by id"));
    assert.deepEqual(engine.execute("select id from s order by id").rows, oracleRows(db, "select id from s order by id"));
  });
  assert.deepEqual(engine.execute("pragma recursive_triggers").rows, [[0]]);
  engine.execute("pragma recursive_triggers = on");
  assert.deepEqual(engine.execute("pragma recursive_triggers").rows, [[1]]);
  const runaway = engine.tryExecute("insert into s values (2, 2)");
  assert.equal(runaway.ok, false);
  assert.equal(runaway.error?.message, "too many levels of trigger recursion");
  assert.deepEqual(engine.execute("select id from s order by id").rows, [[1], [1001]]);
});

test("temp triggers appear in sqlite_temp_master and fire like better-sqlite3", () => {
  const steps = [
    "create table m (id integer primary key, a)",
    "create temp table tt (id integer primary key, a)",
    "create trigger temp.xt after insert on tt begin insert into m values (new.id, new.a); end",
    "insert into tt values (1, 2)",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  withOracle(steps, (db) => {
    assert.deepEqual(
      engine.execute("select type, name, tbl_name from sqlite_temp_master").rows,
      oracleRows(db, "select type, name, tbl_name from sqlite_temp_master"),
    );
    assert.deepEqual(engine.execute("select id, a from m").rows, oracleRows(db, "select id, a from m"));
    assert.deepEqual(
      engine.execute("select name from sqlite_master where type = 'trigger'").rows,
      oracleRows(db, "select name from sqlite_master where type = 'trigger'"),
    );
  });
});

// Every expected row below is read from better-sqlite3 at run time; no value
// is copied from this engine.
test("limit expressions, offsets and out-of-range values match better-sqlite3", () => {
  const steps = ["create table t (a integer)", "insert into t values (1), (2), (3)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "select a from t order by a limit 1 + 1",
    "select a from t order by a limit abs(-3)",
    "select a from t order by a limit (select 2)",
    "select a from t order by a limit 2 offset 1",
    "select a from t order by a limit 1 + 1 offset 0 + 1",
    "select a from t order by a limit -2",
    "select a from t order by a limit -2 offset 1",
    "select a from t order by a limit 999",
    "select a from t order by a limit '2'",
    "select a from t order by a limit 3 offset -1",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
    // A fractional limit is "datatype mismatch" on both sides.
    assert.throws(() => db.prepare("select a from t order by a limit 2.9").all(), /datatype mismatch/i);
  });
  const fractional = engine.tryExecute("select a from t order by a limit 2.9");
  assert.equal(fractional.ok, false);
  assert.equal(fractional.error?.code, "datatype-mismatch");
  assert.equal(fractional.error?.clause, "LIMIT");
});

// Rows come from better-sqlite3; partitions, empty input and an explicit frame
// are all compared against the live oracle.
test("window functions match better-sqlite3 across partitions and frames", () => {
  const steps = ["create table w (g text, a integer)", "insert into w values ('x', 1), ('x', 2), ('y', 2), ('z', 3)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "select row_number() over (order by a) from w",
    "select rank() over (order by a) from w",
    "select dense_rank() over (order by a) from w",
    "select a, sum(a) over (order by a) from w",
    "select g, a, sum(a) over (partition by g order by a) from w",
    "select g, a, sum(a) over (partition by g order by a rows between unbounded preceding and current row) from w",
    "select g, sum(a) over win from w window win as (partition by g)",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });

  // An empty table yields no rows for a partitioned window on both sides.
  const emptySteps = ["create table e (g text, a integer)"];
  const empty = createEngine(4096);
  for (const step of emptySteps) empty.execute(step);
  const emptySql = "select g, row_number() over (partition by g) from e";
  withOracle(emptySteps, (db) => {
    assert.deepEqual(empty.execute(emptySql).rows, oracleRows(db, emptySql));
  });
});

// The statement shape still differs, but the stored row must equal what real
// SQLite stores after `INSERT ... DEFAULT VALUES`.
test("insert default values stores the row better-sqlite3 stores", () => {
  const steps = ["create table dv (a integer default 7, b text default 'x', c integer)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  engine.execute("insert into dv default values");
  const stored = engine.execute("select a, b, c from dv").rows;
  withOracle([...steps, "insert into dv default values"], (db) => {
    assert.deepEqual(stored, oracleRows(db, "select a, b, c from dv"));
  });
});

// A non-recursive `WITH` body is a full `SELECT`, so renamed columns, aggregates,
// chaining and table shadowing are all compared against better-sqlite3.
test("non-recursive CTEs match better-sqlite3 for multi-column bodies and chaining", () => {
  const steps = ["create table t (a integer, b integer)", "insert into t values (1, 10), (2, 20), (3, 30)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "with c(x, y) as (select a, b + 10 from t) select x, y from c order by x",
    "with c(x, y) as (select a, a * b from t) select count(*), sum(y) from c",
    "with c(x, y) as (select a, b from t), d as (select x, y + 1 as z from c) select x, z from d order by x",
    "with t(a, b) as (select 9, 90) select a, b from t",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// The `WITH` scope has to survive into correlated subqueries, `IN (SELECT ...)`
// and derived tables, with the same rows better-sqlite3 returns.
test("CTEs stay visible in subqueries and derived tables like better-sqlite3", () => {
  const steps = ["create table t (a integer, b integer)", "insert into t values (1, 10), (2, 20), (3, 30)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "with c(x) as (select a from t) select (select count(*) from c) as n from t where a = 1",
    "with c(x) as (select a from t where a > 1) select a from t where a in (select x from c) order by a",
    "select * from (with c(x) as (select a from t where a = 2) select x from c) d",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// `UNION` de-duplicates the rows a `WITH` body produces while `UNION ALL` keeps
// them, matching better-sqlite3. Real self-reference stays a reported gap.
test("`WITH RECURSIVE` without a self reference keeps UNION and UNION ALL oracle results", () => {
  const steps: string[] = [];
  const engine = createEngine(4096);
  const cases = [
    "with recursive c(x) as (select 1 union all select 1) select x from c",
    "with recursive c(x) as (select 1 union select 1) select x from c",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// `BETWEEN`, the boolean keywords, a hex integer literal and the scalar edge
// values the engine already evaluates all existed without a gate; the oracle
// decides every value.
test("BETWEEN, boolean literals, hex integers and scalar edges match sqlite", () => {
  const engine = createEngine(4096);
  const cases = [
    "select 2 between 1 and 3, 2 not between 1 and 3, null between 1 and 2",
    "select true, false, true = 1, false = 0",
    "select 0x1f, 1e3",
    "select 1 + 2 * 3, 10 - 2 - 3",
    "select substr('abcdef', 0, 2), substr('abcdef', 2, 99)",
    "select round(2.5), round(-2.5)",
  ];
  withOracle([], (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// Comparison without column affinity ranks storage classes: numbers sort before
// text, and a blob sorts after text. The engine has to keep that rank in
// `ORDER BY` instead of coercing everything to one class.
test("comparison across storage classes follows sqlite type order", () => {
  const steps = ["create table mt (v)", "insert into mt values (1), ('2'), (x'33'), (null)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = ["select typeof(v) from mt order by v", "select '10' < 9, '10' = 10, 1 = 1.0", "select 'abc' < 'abd', null = null"];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// The window evaluator implements every ranking and value function, both
// frame units and aggregate windows; none of those forms had a gate before.
test("window ranking, value and framed aggregates match better-sqlite3", () => {
  const steps = ["create table w (g text, a integer)", "insert into w values ('x', 1), ('x', 2), ('y', 2), ('z', 3)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "select percent_rank() over (order by a), cume_dist() over (order by a), ntile(2) over (order by a) from w",
    "select a, lag(a, 1, 99) over (order by a), lead(a, 1, -1) over (order by a) from w",
    "select first_value(a) over (order by a), last_value(a) over (order by a), nth_value(a, 2) over (order by a) from w",
    "select sum(a) over (order by a rows between 1 preceding and 1 following) from w",
    "select sum(a) over (order by a range between 1 preceding and 1 following) from w",
    "select count(*) over (), sum(a) over () from w",
    "select group_concat(a, '-') over (order by a) from w",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// Four implemented shapes without a gate: grouping by an expression, ordering
// by an output alias, aggregates over an empty table, and a `DELETE` that
// names its table through an alias.
test("group by expression, order by alias, empty aggregates and aliased delete match sqlite", () => {
  const grouped = createEngine(4096);
  grouped.execute("create table gb (a integer)");
  grouped.execute("insert into gb values (1), (2), (3), (4)");
  withOracle(["create table gb (a integer)", "insert into gb values (1), (2), (3), (4)"], (db) => {
    for (const sql of ["select a + 1 as k, count(*) from gb group by a + 1 order by k", "select a as x from gb order by x desc"]) {
      assert.deepEqual(grouped.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });

  const empty = createEngine(4096);
  empty.execute("create table empty (v integer)");
  withOracle(["create table empty (v integer)"], (db) => {
    const sql = "select avg(v), min(v), max(v), count(v) from empty";
    assert.deepEqual(empty.execute(sql).rows, oracleRows(db, sql), sql);
  });

  const aliased = createEngine(4096);
  aliased.execute("create table da (a integer)");
  aliased.execute("insert into da values (1), (2)");
  assert.deepEqual(aliased.execute("delete from da as x where x.a = 2 returning a").rows, [[2]]);

  const inserted = createEngine(4096);
  inserted.execute("create table mr (id integer primary key, v text)");
  assert.deepEqual(inserted.execute("insert into mr (v) values ('a'), ('b') returning id, v").rows, [
    [1, "a"],
    [2, "b"],
  ]);
});

// The engine evaluates a self reference in a CTE body as recursion even without
// the RECURSIVE keyword. UNION ALL keeps duplicates, UNION de-duplicates the
// whole fixed point, and an outer LIMIT truncates an otherwise unbounded walk.
test("recursive CTEs match better-sqlite3 without and with the keyword", () => {
  const steps = ["create table edges (parent integer, child integer)", "insert into edges values (1,2),(1,3),(2,4),(3,5),(5,6)"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "with c(x) as (select 1 union all select x + 1 from c where x < 3) select x from c",
    "with recursive c(x) as (select 1 union all select x from c limit 3) select x from c",
    "with recursive c(x) as (select 1 union select x + 1 from c where x < 3) select x from c",
    "with recursive c(x) as (select 1 union all select x + 1 from c) select x from c limit 5",
    "with recursive c(n, f) as (select 1, 1 union all select n + 1, f * (n + 1) from c where n < 5) select n, f from c",
    "with recursive d(id, depth) as (select 1, 0 union all select e.child, d.depth + 1 from edges e, d where e.parent = d.id) select id, depth from d order by id",
    "with recursive c as (select a from t) select * from c",
  ];
  engine.execute("create table t (a integer)");
  engine.execute("insert into t values (1), (2), (3)");
  withOracle([...steps, "create table t (a integer)", "insert into t values (1), (2), (3)"], (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

// Foreign keys are on when a session starts, can be toggled per session, and a
// failure rolls the whole statement back. Every expected value comes from the
// live oracle.
test("foreign keys enforce orphan, delete and update checks per session pragma", () => {
  const steps = [
    "create table parent (id integer primary key)",
    "create table child (id integer primary key, pid integer references parent (id))",
    "insert into parent values (1), (2)",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);

  assert.deepEqual(engine.execute("pragma foreign_keys").rows, [[1]]);
  const orphan = engine.tryExecute("insert into child values (10, 99)");
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error?.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
  assert.match(orphan.error?.message ?? "", /FOREIGN KEY constraint failed/);

  // NULL child keys never need a parent row.
  engine.execute("insert into child values (11, null)");

  // Turning enforcement off admits the same orphan insert and delete.
  engine.execute("pragma foreign_keys = off");
  assert.deepEqual(engine.execute("pragma foreign_keys").rows, [[0]]);
  engine.execute("insert into child values (12, 99)");
  engine.execute("insert into child values (13, 1)");
  engine.execute("insert into child values (14, 2)");
  engine.execute("delete from parent where id = 1");
  assert.deepEqual(engine.execute("select count(*) from parent").rows, [[1]]);

  // Back on, the delete of a still-referenced row and an update of its key fail.
  engine.execute("pragma foreign_keys = on");
  assert.equal(engine.tryExecute("delete from parent where id = 2").ok, false);
  assert.equal(engine.tryExecute("update parent set id = 7 where id = 2").ok, false);
  assert.deepEqual(engine.execute("select id from parent order by id").rows, [[2]]);
  assert.equal(engine.execute("select count(*) from child").rows[0][0], 4);
});

test("composite foreign keys and statement rollback match better-sqlite3", () => {
  const steps = [
    "create table parent (a integer, b integer, primary key (a, b))",
    "create table child (id integer primary key, x integer, y integer, foreign key (x, y) references parent)",
    "insert into parent values (1, 2)",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);

  // The column list is omitted, so the parent primary key is implicit.
  const orphan = engine.tryExecute("insert into child values (2, 1, 3)");
  assert.equal(orphan.ok, false);
  assert.equal(orphan.error?.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
  engine.execute("insert into child values (3, 1, 2)");
  assert.deepEqual(engine.execute("select id from child").rows, [[3]]);

  // One bad tuple aborts the whole multi-row statement.
  const batch = engine.tryExecute("insert into child values (4, 1, 2), (5, 9, 9)");
  assert.equal(batch.ok, false);
  assert.equal(batch.error?.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
  assert.deepEqual(engine.execute("select id from child order by id").rows, [[3]]);

  withOracle([...steps, "insert into child values (3, 1, 2)"], (db) => {
    const sql = "select id from child order by id";
    assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
  });
});

// Referential actions, deferred checks and adding a reference through
// `ALTER TABLE` stay rejected with a structured code instead of silently
// weakening the constraint.
test("unsupported foreign key shapes keep structured rejections", () => {
  const engine = createEngine(4096);
  engine.execute("create table parent (id integer primary key)");
  engine.execute("create table plain (id integer primary key)");

  const cases: Array<[string, string, string]> = [
    ["create table c1 (id integer primary key, pid integer references parent (id) on delete cascade)", "unsupported-foreign-key-action", "CASCADE"],
    ["create table c2 (id integer primary key, pid integer references parent (id) on update cascade)", "unsupported-foreign-key-action", "CASCADE"],
    ["create table c3 (id integer primary key, pid integer references parent (id) on update set null)", "unsupported-foreign-key-action", "SET NULL"],
    ["create table c4 (id integer primary key, pid integer references parent (id) on update set default)", "unsupported-foreign-key-action", "SET DEFAULT"],
    ["create table c5 (id integer primary key, pid integer references parent (id) deferrable initially deferred)", "unsupported-deferred-foreign-key", "DEFERRABLE"],
  ];
  for (const [sql, code, clause] of cases) {
    const result = engine.tryExecute(sql);
    assert.equal(result.ok, false, sql);
    assert.equal(result.error?.code, code, sql);
    assert.equal(result.error?.clause, clause, sql);
  }
});

// Was one of the seeded corpus drift rows: `round_cell` used to scale the
// operand and round ties away from zero. Upstream now rounds like SQLite, so
// both oracles and this engine agree and the row left the baseline.
test("rounding matches both oracles at ties and negative precision", () => {
  const engine = createEngine();
  const cases = [
    "select round(1.2345, 3)",
    "select round(123.456, -1)",
    "select round(2.675, 2)",
    "select round(1.005, 2)",
  ];
  withOracle([], (db) => {
    for (const sql of cases) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
});

test("strict tables enforce declared storage classes like better-sqlite3", () => {
  const engine = createEngine();
  const steps = [
    "create table s (a integer, b text, c real, d blob, e any) strict",
    "insert into s values ('12', 5, 2, X'00', 'free')",
  ];
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of [
      "select a, b, c, e from s",
      "select typeof(a), typeof(b), typeof(c), typeof(d), typeof(e) from s",
    ]) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
  });
  assert.equal(engine.lastInsertRowid(), 1);

  const real = engine.tryExecute("insert into s(a) values (1.5)");
  assert.equal(real.ok, false);
  assert.equal(real.error?.code, "constraint-datatype");
  assert.equal(real.error?.message, "cannot store REAL value in INTEGER column s.a");
  const blob = engine.tryExecute("insert into s(d) values ('z')");
  assert.equal(blob.ok, false);
  assert.equal(blob.error?.message, "cannot store TEXT value in BLOB column s.d");
  const datatype = engine.tryExecute("create table bad (a varchar(10)) strict");
  assert.equal(datatype.ok, false);
  assert.equal(datatype.error?.code, "unknown-datatype");
  assert.equal(datatype.error?.message, 'unknown datatype for bad.a: "varchar(10)"');

  engine.execute("create table keyed (a integer primary key, b text) strict");
  engine.execute("insert into keyed (b) values ('a null key becomes the rowid')");
  assert.equal(engine.lastInsertRowid(), 1);
});

test("views re-run their query and keep catalog rows like better-sqlite3", () => {
  const engine = createEngine();
  const steps = [
    "create table users (id integer primary key, name text, age integer)",
    "insert into users values (1, 'ada', 36), (2, 'bob', 28), (3, 'cy', 45)",
    "create view active as select id, name from users where age > 30",
    "create view active_names(caller) as select name from active",
  ];
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of ["select id, name from active order by id", "select caller from active_names order by caller"]) {
      const actual = engine.execute(sql);
      assert.deepEqual(actual.columns, db.prepare(sql).columns().map((column) => column.name), sql);
      assert.deepEqual(actual.rows, oracleRows(db, sql), sql);
    }
    // A later insert reaches the view without the definition being rewritten.
    const later = "insert into users values (4, 'dan', 19), (5, 'eve', 52)";
    engine.execute(later);
    db.exec(later);
    const after = "select id from active order by id";
    assert.deepEqual(engine.execute(after).rows, oracleRows(db, after));
    const master = "select type, name, tbl_name, rootpage, sql from sqlite_master where name in ('active', 'active_names') order by name";
    assert.deepEqual(engine.execute(master).rows, oracleRows(db, master));
    // Both engines refuse to write through a view and to index one.
    assert.throws(() => db.exec("insert into active values (9, 'zed')"));
    assert.throws(() => db.exec("create index active_idx on active(id)"));
  });

  const write = engine.tryExecute("insert into active values (9, 'zed')");
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, "readonly-view");
  const index = engine.tryExecute("create index active_idx on active(id)");
  assert.equal(index.ok, false);
  assert.equal(index.error?.code, "readonly-view");

  // The catalog row re-reads the definition on reopen without touching the image.
  const image = Buffer.from(engine.snapshot());
  const reopened = createEngineFromSnapshot(image);
  assert.deepEqual(reopened.execute("select id from active order by id").rows, [[1], [3], [5]]);
  assert.equal(Buffer.compare(reopened.snapshot(), image), 0);

  engine.execute("drop view active_names");
  assert.equal(engine.tryExecute("drop table active").error?.code, "wrong-object");
  engine.execute("drop view active");
  assert.equal(engine.tryExecute("select * from active").error?.code, "unknown-table");
});

test("triggers fire once without recursion and keep catalog rows like better-sqlite3", () => {
  const engine = createEngine();
  const steps = [
    "create table scratch (id integer, label text)",
    "create table audit (id integer)",
    "create trigger probe after insert on scratch begin insert into audit values (1); end",
    "create trigger probe_self after insert on scratch begin insert into scratch values (9, 'self'); end",
    "insert into scratch values (1, 'x')",
  ];
  withOracle(steps, (db) => {
    for (const step of steps) engine.execute(step);
    for (const sql of [
      "select count(*) from scratch",
      "select count(*) from audit",
      "select type, name, tbl_name, rootpage, sql from sqlite_master where type = 'trigger' order by name",
    ]) {
      assert.deepEqual(engine.execute(sql).rows, oracleRows(db, sql), sql);
    }
    // A trigger cannot be attached to a table that does not exist.
    assert.throws(() => db.exec("create trigger missing after insert on absent begin select 1; end"));
    for (const sql of ["drop trigger probe", "insert into scratch values (2, 'y')"]) {
      db.exec(sql);
      engine.execute(sql);
    }
    const afterDrop = "select count(*) from audit";
    assert.deepEqual(engine.execute(afterDrop).rows, oracleRows(db, afterDrop));
    db.exec("drop table scratch");
    engine.execute("drop table scratch");
    const master = "select count(*) from sqlite_master where type = 'trigger'";
    assert.deepEqual(engine.execute(master).rows, oracleRows(db, master));
  });
  assert.equal(engine.tryExecute("create trigger missing after insert on absent begin select 1; end").error?.code, "unknown-table");
  assert.equal(engine.execute("select count(*) from audit").rows[0][0], 2);
  assert.equal(engine.execute("select count(*) from sqlite_master where type = 'trigger'").rows[0][0], 0);
});

test("explicit transactions roll back rows and schema exactly as better-sqlite3", () => {
  const engine = createEngine();
  const external = new BetterSqlite(":memory:");
  const steps = [
    "create table tx (id integer primary key, note text)",
    "insert into tx (note) values ('kept')",
    "begin",
    "insert into tx (note) values ('dropped')",
    "savepoint s1",
    "insert into tx (note) values ('also dropped')",
    "rollback to savepoint s1",
    "release savepoint s1",
    "commit",
    "begin",
    "create table undone (v integer)",
    "rollback",
  ];
  try {
    for (const statement of steps) {
      engine.execute(statement);
      external.prepare(statement).run();
    }
    const query = "select id, note from tx order by id";
    assert.deepEqual(
      engine.execute(query).rows,
      external.prepare(query).all().map((row) => Object.values(row as Record<string, unknown>)),
    );
    // `last_insert_rowid` is connection state that a rollback never undoes.
    assert.equal(engine.lastInsertRowid(), 3);
    assert.equal((external.prepare("select last_insert_rowid() as id").get() as { id: number }).id, 3);
    // The rolled back `create table` left no row in the catalog.
    assert.equal(engine.tryExecute("select v from undone").ok, false);
    assert.throws(() => external.prepare("select v from undone"));
    const commit = engine.tryExecute("commit");
    assert.equal(commit.ok, false);
    assert.equal(commit.error?.code, "transaction-missing");
    assert.equal(commit.error?.message, "cannot commit - no transaction is active");
    const missing = engine.tryExecute("rollback to missing");
    assert.equal(missing.error?.message, "no such savepoint: missing");
  } finally {
    external.close();
  }
});

test("bound parameters fill placeholders on insert and select", () => {
  const engine = createEngine();
  const external = new BetterSqlite(":memory:");
  const create = "create table p (id integer primary key, name text, score real)";
  engine.execute(create);
  external.prepare(create).run();
  const insert = "insert into p (name, score) values (?, ?)";
  for (const row of [["ada", 9.5], ["bob", null]] as const) {
    const result = engine.executeWithParameters(insert, [...row]).at(-1);
    assert.equal(result?.affected, 1);
    external.prepare(insert).run(...row);
  }
  const query = "select id, name, score from p where name = ? order by id";
  assert.deepEqual(engine.executeWithParameters(query, ["ada"]).at(-1)?.rows, [[1, "ada", 9.5]]);
  assert.deepEqual(
    external.prepare(query).all("ada").map((row) => Object.values(row as Record<string, unknown>)),
    [[1, "ada", 9.5]],
  );
  engine.exec("insert into p (name, score) values ('eve', 7.25)");
  assert.equal(engine.lastInsertRowid(), 3);
  external.close();
});

test("fromSnapshot reopens an image with its catalog and rejects a broken header", () => {
  const engine = createEngine();
  engine.exec("create table parent (id integer primary key, name text); insert into parent values (1, 'ada')");
  const image = Buffer.from(engine.snapshot());
  const reopened = createEngineFromSnapshot(image);
  assert.deepEqual(reopened.execute("select id, name from parent").rows, [[1, "ada"]]);
  // Reading a reopened image must not rewrite it.
  assert.equal(Buffer.compare(reopened.snapshot(), image), 0);
  assert.deepEqual(reopened.execute("select count(*) from sqlite_master").rows, [[1]]);
  assert.throws(() => createEngineFromSnapshot(Buffer.from("not a database")));
});

function oracleColumns(db: OracleDatabase, sql: string): string[] {
  return db.prepare(sql).columns().map((column) => column.name);
}

function viewQueryPart(text: string): string {
  const at = text.toLowerCase().indexOf(" as ");
  return at < 0 ? text : text.slice(at + 4);
}

// Unaliased projections are named after the exact source text (`a + 1`,
// `1.50`, `cast(a as text)`) and a view de-duplicates repeated output names
// with `:1`, `:2`, ... exactly like better-sqlite3.
test("view output names follow better-sqlite3 for spans, aliases and duplicates", () => {
  const steps = [
    "create table t (a integer, b text)",
    "insert into t values (1, 'x')",
    "create view e as select a + 1, a from t",
    "create view d as select a, a from t",
    "create view c as select b as x, a as x from t",
    "create view s as select 1.50, null, cast(a as text) from t",
    "create view q(k) as select a from t",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "select * from e",
    "select * from d",
    "select * from c",
    "select * from s",
    "select * from q",
    "select * from (select a as q, b as q from t) d",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      const result = engine.execute(sql);
      assert.deepEqual(result.columns, oracleColumns(db, sql), sql);
      assert.deepEqual(result.rows, oracleRows(db, sql), sql);
    }
  });
});

// A declared column list is checked when the view is read, not when it is
// created, and repeated declared names are de-duplicated like inferred ones.
test("declared view column lists report oracle arity diagnostics", () => {
  const steps = [
    "create table t (a integer, b text)",
    "insert into t values (1, 'x')",
    "create view short(x) as select a, b from t",
    "create view long(x, y) as select a from t",
    "create view dup(x, x) as select a, a from t",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const rejected = ["select * from short", "select * from long", "select x from short"];
  withOracle(steps, (db) => {
    for (const sql of rejected) {
      const result = engine.tryExecute(sql);
      assert.equal(result.ok, false, sql);
      assert.equal(result.error?.message, oracleMessage(db, sql), sql);
    }
    for (const sql of ["select * from dup", "select x from dup"]) {
      const result = engine.execute(sql);
      assert.deepEqual(result.columns, oracleColumns(db, sql), sql);
      assert.deepEqual(result.rows, oracleRows(db, sql), sql);
    }
  });
});

// Views share the object namespace with tables and indexes, and `DROP VIEW`
// searches the temp schema first and reports the wrong object kind the way
// better-sqlite3 does.
test("view namespace conflicts and DROP VIEW diagnostics follow better-sqlite3", () => {
  const steps = ["create table t (a integer)", "create index ix on t (a)", "create view v as select a from t"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "create view ix as select 1",
    "create view if not exists ix as select 1",
    "create view t as select 1",
    "create view v as select 1",
    "create view if not exists v as select 2",
    "drop table v",
    "drop table if exists v",
    "drop view t",
    "drop view ix",
    "drop view nope",
    "drop view if exists ix",
    "drop view if exists nope",
  ];
  withOracleMessage(steps, "");
  for (const sql of cases) {
    const expected = withOracleMessage(steps, sql);
    const result = engine.tryExecute(sql);
    assert.equal(result.ok, expected === "", sql);
    assert.equal(result.error?.message ?? "", expected, sql);
  }
});

// `ALTER TABLE RENAME` rewrites every view that names the table or column,
// quoting the renamed table and leaving aliases alone, exactly like the oracle.
test("ALTER TABLE renames rewrite stored view definitions like better-sqlite3", () => {
  const steps = [
    "create table t (a integer, b text)",
    "insert into t values (1, 'x')",
    "create view vq as select t.a from t",
    "create view va as select x.a from t as x",
    "alter table t rename to t2",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  withOracle(steps, (db) => {
    for (const name of ["vq", "va"]) {
      const stored = `select sql from sqlite_master where name = '${name}'`;
      const actual = engine.execute(stored).rows[0][0] as string;
      const expected = oracleRows(db, stored)[0][0] as string;
      assert.equal(viewQueryPart(actual), viewQueryPart(expected), name);
    }
    assert.deepEqual(engine.execute("select * from vq").rows, oracleRows(db, "select * from vq"));
    assert.deepEqual(engine.execute("select * from va").rows, oracleRows(db, "select * from va"));
  });

  const columnSteps = [
    "create table u (a integer, b text)",
    "insert into u values (1, 'x')",
    "create view w as select a from u where a > 1 and b <> 'a'",
    "create view wa as select b as a from u",
    "alter table u rename column a to z",
  ];
  const columns = createEngine(4096);
  for (const step of columnSteps) columns.execute(step);
  withOracle(columnSteps, (db) => {
    for (const name of ["w", "wa"]) {
      const stored = `select sql from sqlite_master where name = '${name}'`;
      const actual = columns.execute(stored).rows[0][0] as string;
      const expected = oracleRows(db, stored)[0][0] as string;
      assert.equal(viewQueryPart(actual), viewQueryPart(expected), name);
    }
    assert.deepEqual(columns.execute("select * from w").rows, oracleRows(db, "select * from w"));
  });
});

// A temp view shadows a main view, appears in `sqlite_temp_master` with
// rootpage zero, and the unqualified `DROP VIEW` removes it first.
test("temp views shadow main views and vanish with the engine like better-sqlite3", () => {
  const steps = ["create view v as select 1 as a", "create temp view v as select 2 as a"];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const tempMaster = "select type, name, tbl_name, rootpage from sqlite_temp_master where type = 'view'";
  withOracle(steps, (db) => {
    assert.deepEqual(engine.execute("select * from v").rows, oracleRows(db, "select * from v"));
    assert.deepEqual(engine.execute(tempMaster).rows, oracleRows(db, tempMaster));
  });
  engine.execute("drop view v");
  assert.deepEqual(engine.execute("select * from v").rows, [[1]]);
  assert.deepEqual(engine.execute(tempMaster).rows, []);
});

// `PRAGMA table_info` / `index_list` / `index_info` / `foreign_key_list` echo
// the oracle, including automatic constraint indexes, the written `DEFAULT`
// text and SQLite's newest-first object order.
test("table, index and foreign key pragmas follow better-sqlite3", () => {
  const steps = [
    "create table p1 (x integer primary key)",
    "create table p2 (u integer, v integer, primary key (u, v))",
    "create table a (x integer, y text, z real, u text unique, v text unique)",
    "create index a_y on a (y)",
    "create index a_z on a (z)",
    "create table fk (a integer references p1, b text, c integer, foreign key (b, c) references p2 (u, v))",
    "create table dfl (a integer default 5, b text default 'x', c real default 1.50, d text not null default 'y')",
    "create table mixed (k integer primary key autoincrement, s text unique)",
    "create table cas (a varCHAR(20), b DOUBLE precision, c blob, d none)",
    "create temp table tt (a integer primary key, b text unique)",
  ];
  const engine = createEngine(4096);
  for (const step of steps) engine.execute(step);
  const cases = [
    "pragma table_info(a)",
    "pragma table_xinfo(a)",
    "pragma table_info(p2)",
    "pragma table_info(dfl)",
    "pragma table_info(mixed)",
    "pragma table_info(cas)",
    "pragma table_info(tt)",
    "pragma table_info(nosuch)",
    "pragma index_list(a)",
    "pragma index_list(p2)",
    "pragma index_list(mixed)",
    "pragma index_list(tt)",
    "pragma index_list(nosuch)",
    "pragma index_info(a_y)",
    "pragma index_info(a_z)",
    "pragma index_info(sqlite_autoindex_a_2)",
    "pragma index_info(sqlite_autoindex_p2_1)",
    "pragma index_info(nosuch)",
    "pragma foreign_key_list(fk)",
    "pragma foreign_key_list(nosuch)",
  ];
  withOracle(steps, (db) => {
    for (const sql of cases) {
      const result = engine.execute(sql);
      assert.deepEqual(result.columns, oracleColumns(db, sql), sql);
      assert.deepEqual(result.rows, oracleRows(db, sql), sql);
    }
  });
});

test("upsert DO NOTHING and DO UPDATE follow better-sqlite3", () => {
  const live = workspace();
  const snapshotFile = workspace();
  const engine = createEngine(4096);
  const external = new BetterSqlite(live.path);
  try {
    for (const sql of [
      "create table ups (id integer primary key, sku text unique, qty integer not null default 0, note text)",
      "create table cu (a text, b text, v integer, unique(a, b))",
    ]) {
      engine.execute(sql);
      external.prepare(sql).run();
    }
    // Every statement runs in both engines and must report the same number of
    // changed rows, so the expectations come from the real engine, not from
    // this one.
    const step = (sql: string, expected: number): void => {
      const mine = engine.execute(sql);
      const theirs = external.prepare(sql).run();
      assert.equal(theirs.changes, expected, sql);
      assert.equal(mine.affected, expected, sql);
    };
    step("insert into ups (id, sku, qty, note) values (1,'a',5,'first'), (2,'b',7,'second')", 2);
    step("insert into ups (id, sku, qty) values (3,'a',50) on conflict(sku) do nothing", 0);
    step("insert into ups (id, sku, qty, note) values (4,'c',9,'new') on conflict(sku) do update set qty = qty + excluded.qty, note = excluded.note", 1);
    // `qty` reads the stored row, `excluded.qty` reads the supplied row.
    step("insert into ups (id, sku, qty, note) values (5,'a',2,'upd') on conflict(sku) do update set qty = qty + excluded.qty, note = excluded.note", 1);
    step("insert into ups (id, sku, qty) values (6,'b',3) on conflict(sku) do update set qty = excluded.qty where ups.note = 'second'", 1);
    // A false `DO UPDATE ... WHERE` leaves the stored row alone.
    step("insert into ups (id, sku, qty) values (7,'b',100) on conflict(sku) do update set qty = excluded.qty where 0", 0);
    // The second tuple conflicts with the row the first tuple just inserted.
    step("insert into ups (id, sku, qty) values (8,'d',1), (9,'d',2) on conflict(sku) do update set qty = qty + excluded.qty", 2);
    step("insert into ups (id, sku, qty) values (2,'z',11) on conflict(id) do update set sku = excluded.sku, qty = excluded.qty", 1);
    step("insert into ups (id, sku, qty) values (10,'z',99) on conflict(sku) do update set qty = excluded.qty", 1);

    const readUps = (): unknown[] => engine.execute("select id, sku, qty, note from ups order by id").rows;
    const oracleUps = (): unknown[] => external.prepare("select id, sku, qty, note from ups order by id").all().map((row) => Object.values(row));
    assert.deepEqual(readUps(), [
      [1, "a", 7, "upd"],
      [2, "z", 99, "second"],
      [4, "c", 9, "new"],
      [8, "d", 3, null],
    ]);
    assert.deepEqual(readUps(), oracleUps());

    // `RETURNING` reports nothing for a skipped row and the rewritten row for
    // an update.
    const skipped = engine.execute("insert into ups (id, sku, qty) values (11,'z',5) on conflict(sku) do nothing returning id, qty");
    assert.deepEqual(skipped.rows, []);
    assert.equal(skipped.affected, 0);
    assert.deepEqual(external.prepare("insert into ups (id, sku, qty) values (11,'z',5) on conflict(sku) do nothing returning id, qty").all(), []);
    const updated = engine.execute("insert into ups (id, sku, qty) values (12,'z',5) on conflict(sku) do update set qty = excluded.qty returning id, qty");
    assert.deepEqual(updated.rows, [[2, 5]]);
    assert.equal(updated.affected, 1);
    assert.deepEqual(
      external.prepare("insert into ups (id, sku, qty) values (12,'z',5) on conflict(sku) do update set qty = excluded.qty returning id, qty").all(),
      [{ id: 2, qty: 5 }],
    );

    // A table-level composite `UNIQUE` is a valid conflict target.
    step("insert into cu values ('a','b',1), ('a','c',2)", 2);
    step("insert into cu values ('a','b',3) on conflict(a,b) do update set v = v + excluded.v", 1);
    assert.deepEqual(engine.execute("select a, b, v from cu order by b").rows, [["a", "b", 4], ["a", "c", 2]]);
    assert.deepEqual(external.prepare("select a, b, v from cu order by b").all().map((row) => Object.values(row)), [["a", "b", 4], ["a", "c", 2]]);

    for (const sql of [
      "insert into ups (id, sku) values (13,'q') on conflict(id, sku) do nothing",
      "insert into ups (id, sku) values (14,'q') on conflict(missing) do nothing",
    ]) {
      const mine = engine.tryExecute(sql);
      assert.equal(mine.ok, false, sql);
      let theirs = "";
      try {
        external.prepare(sql).run();
      } catch (error) {
        theirs = (error as Error).message;
      }
      assert.equal(mine.error?.message, theirs, sql);
    }

    // The rewritten rows must survive a real engine's page check and a reopen.
    writeFileSync(snapshotFile.path, engine.snapshot());
    const inspector = new BetterSqlite(snapshotFile.path);
    try {
      assert.equal(inspector.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(inspector.prepare("SELECT id, qty FROM ups ORDER BY id").all(), oracleUps().map((row) => Object.fromEntries([["id", row[0]], ["qty", row[2]]])));
    } finally {
      inspector.close();
    }
    const reopened = createEngineFromSnapshot(engine.snapshot(), 4096);
    const sql = "insert into ups (id, sku, qty) values (15,'d',4) on conflict(sku) do update set qty = qty + excluded.qty";
    const mine = reopened.execute(sql);
    const theirs = external.prepare(sql).run();
    assert.equal(mine.affected, theirs.changes);
    assert.deepEqual(reopened.execute("select id, sku, qty from ups order by id").rows, external.prepare("select id, sku, qty from ups order by id").all().map((row) => Object.values(row)));
  } finally {
    external.close();
    live.dispose();
    snapshotFile.dispose();
  }
});

test("upsert DO UPDATE fires update triggers like better-sqlite3", () => {
  const live = workspace();
  const engine = createEngine(4096);
  const external = new BetterSqlite(live.path);
  try {
    const schema = [
      "create table t (id integer primary key, k text unique, v integer)",
      "create table log (seq integer primary key, op text, old_id integer, new_id integer, old_v integer, new_v integer, new_k text)",
      "create trigger t_bi before insert on t begin insert into log(op, new_k) values ('bi', new.k); end",
      "create trigger t_ai after insert on t begin insert into log(op, new_k) values ('ai', new.k); end",
      "create trigger t_bu before update on t begin insert into log(op, old_id, new_id, old_v, new_v, new_k) values ('bu', old.id, new.id, old.v, new.v, new.k); end",
      "create trigger t_au after update on t begin insert into log(op, old_id, new_id, old_v, new_v, new_k) values ('au', old.id, new.id, old.v, new.v, new.k); end",
    ];
    for (const sql of schema) {
      engine.execute(sql);
      external.prepare(sql).run();
    }
    const step = (sql: string, expected: number): void => {
      const mine = engine.execute(sql);
      const theirs = external.prepare(sql).run();
      assert.equal(theirs.changes, expected, sql);
      assert.equal(mine.affected, expected, sql);
    };
    const readLog = (): unknown[] => engine.execute("select seq, op, old_id, new_id, old_v, new_v, new_k from log order by seq").rows;
    const oracleLog = (): unknown[] =>
      external.prepare("select seq, op, old_id, new_id, old_v, new_v, new_k from log order by seq").all().map((row) => Object.values(row));

    step("insert into t values (1, 'a', 1)", 1);
    step("insert into t (id, k, v) values (2, 'a', 6) on conflict(k) do update set v = excluded.v + 1", 1);
    // The conflict fires `BEFORE INSERT`, `BEFORE UPDATE` and `AFTER UPDATE`,
    // never `AFTER INSERT`, and the update triggers see the rewritten values.
    assert.deepEqual(readLog(), oracleLog());
    assert.deepEqual(readLog(), [
      [1, "bi", null, null, null, null, "a"],
      [2, "ai", null, null, null, null, "a"],
      [3, "bi", null, null, null, null, "a"],
      [4, "bu", 1, 1, 1, 7, "a"],
      [5, "au", 1, 1, 1, 7, "a"],
    ]);

    // `WHEN` and `UPDATE OF` are evaluated against the rewritten row too.
    for (const sql of [
      "create trigger t_wu after update on t when old.v <> new.v begin insert into log(op, old_v, new_v) values ('wu', old.v, new.v); end",
      "create trigger t_ku after update of k on t begin insert into log(op, new_k) values ('ku', new.k); end",
    ]) {
      engine.execute(sql);
      external.prepare(sql).run();
    }
    step("insert into t (id, k, v) values (1, 'a', 7) on conflict(id) do update set v = excluded.v", 1);
    step("insert into t (id, k, v) values (1, 'a', 8) on conflict(id) do update set v = excluded.v", 1);
    step("insert into t (id, k, v) values (1, 'a', 8) on conflict(id) do update set k = excluded.k", 1);
    assert.deepEqual(readLog(), oracleLog());
    const ops = engine.execute("select op from log order by seq").rows.map((row) => row[0]);
    assert.equal(ops.filter((op) => op === "ai").length, 1);
    assert.equal(ops.filter((op) => op === "wu").length, 1);
    assert.equal(ops.filter((op) => op === "ku").length, 1);
  } finally {
    external.close();
    live.dispose();
  }
});

test("upsert DO UPDATE runs foreign key checks like better-sqlite3", () => {
  const live = workspace();
  const engine = createEngine(4096);
  const external = new BetterSqlite(live.path);
  try {
    for (const sql of ["pragma foreign_keys = on"]) {
      engine.execute(sql);
      external.prepare(sql).run();
    }
    const schema = [
      "create table parent (id integer primary key, code text unique)",
      "create table child (id integer primary key, pcode text references parent(code))",
      "insert into parent values (1, 'p1')",
      "insert into child values (1, 'p1')",
      "create table parent2 (id integer primary key, code text unique)",
      "create table child2 (id integer primary key, pcode text references parent2(code) on update restrict)",
      "insert into parent2 values (1, 'r1')",
      "insert into child2 values (1, 'r1')",
    ];
    for (const sql of schema) {
      engine.execute(sql);
      external.prepare(sql).run();
    }
    const step = (sql: string, expected: number): void => {
      const mine = engine.execute(sql);
      const theirs = external.prepare(sql).run();
      assert.equal(theirs.changes, expected, sql);
      assert.equal(mine.affected, expected, sql);
    };
    const failure = (sql: string): { code?: string; message: string } => {
      const mine = engine.tryExecute(sql);
      assert.equal(mine.ok, false, sql);
      try {
        external.prepare(sql).run();
        assert.fail(`better-sqlite3 accepted ${sql}`);
      } catch (error) {
        assert.equal(mine.error?.message, (error as Error).message, sql);
      }
      return { code: mine.error?.code, message: mine.error?.message ?? "" };
    };
    const pair = (sql: string): unknown[] => [
      engine.execute(sql).rows,
      external.prepare(sql).all().map((row) => Object.values(row)),
    ];

    // Rewriting the parent key a child still uses aborts the whole statement.
    step("insert into parent (id, code) values (1, 'p1') on conflict(id) do update set code = excluded.code", 1);
    const parentViolation = failure("insert into parent (id, code) values (1, 'p2') on conflict(id) do update set code = 'p2'");
    assert.equal(parentViolation.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
    assert.deepEqual(pair("select id, code from parent"), [[[1, "p1"]], [[1, "p1"]]]);

    // A child upsert that moves its key to a missing parent is rejected.
    const childViolation = failure("insert into child (id, pcode) values (1, 'pX') on conflict(id) do update set pcode = 'pX'");
    assert.equal(childViolation.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
    assert.deepEqual(pair("select id, pcode from child"), [[[1, "p1"]], [[1, "p1"]]]);

    // `ON UPDATE RESTRICT` stops the parent rewrite the same way.
    const restrict = failure("insert into parent2 (id, code) values (1, 'r2') on conflict(id) do update set code = 'r2'");
    assert.match(restrict.message, /FOREIGN KEY constraint failed/);
    assert.deepEqual(pair("select id, code from parent2"), [[[1, "r1"]], [[1, "r1"]]]);
    assert.deepEqual(pair("select id, pcode from child2"), [[[1, "r1"]], [[1, "r1"]]]);

    // Once the child is gone the same parent rewrite succeeds in both engines.
    step("delete from child where id = 1", 1);
    step("insert into parent (id, code) values (1, 'p2') on conflict(id) do update set code = 'p2'", 1);
    assert.deepEqual(pair("select id, code from parent"), [[[1, "p2"]], [[1, "p2"]]]);
  } finally {
    external.close();
    live.dispose();
  }
});

test("user_version and application_id round-trip through the header", () => {
  const engine = createEngine(4096);
  assert.deepEqual(engine.execute("pragma user_version").rows, [[0]]);
  assert.deepEqual(engine.execute("pragma application_id").rows, [[0]]);
  engine.execute("pragma user_version = 7");
  engine.execute("pragma application_id = 42");
  assert.deepEqual(engine.execute("pragma user_version").rows, [[7]]);
  assert.deepEqual(engine.execute("pragma application_id").rows, [[42]]);
  const reopened = createEngineFromSnapshot(engine.snapshot());
  assert.deepEqual(reopened.execute("pragma user_version").rows, [[7]]);
  assert.deepEqual(reopened.execute("pragma application_id").rows, [[42]]);
});