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

  const groupBy = engine.tryExecute("select * from t group by id");
  assert.equal(groupBy.ok, false);
  assert.equal(groupBy.error?.code, "unsupported-clause");
  assert.equal(groupBy.error?.statement, "select");
  assert.equal(groupBy.error?.clause, "GROUP");
  assert.equal(groupBy.error?.position, 16);

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

  assert.throws(() => engine.execute("drop table t"), /unsupported statement starting at/i);
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

test("create index accepts single, composite, unique and if not exists forms", () => {
  const engine = createEngine();
  engine.exec(
    "create table t8 (a8 integer, b8 integer, c8 text); \
     create index t8i0 on t8(a8); \
     create index t8all on t8(c8 desc, b8 asc, a8 desc); \
     create unique index t8u on t8(a8)",
  );

  assert.throws(() => engine.execute("create index t8i0 on t8(a8)"), /index `t8i0` already exists/);
  const repeated = engine.execute("create index if not exists t8i0 on t8(a8)");
  assert.equal(repeated.statement, "create-index");
  assert.equal(repeated.affected, 0);

  const tableConflict = engine.tryExecute("create index t8 on t8(a8)");
  assert.equal(tableConflict.error?.code, "table-exists");
  assert.match(tableConflict.error?.message ?? "", /there is already a table named `t8`/);
  assert.equal(engine.tryExecute("create index on_missing on ghosts(a8)").error?.code, "unknown-table");
  assert.equal(engine.tryExecute("create index on_column on t8(ghost)").error?.code, "unknown-column");
  // Partial indexes are rejected closed instead of half-built.
  assert.equal(engine.tryExecute("create index partial on t8(a8) where a8 > 0").error?.code, "unsupported-clause");

  // The unique index is enforced by later inserts.
  engine.execute("insert into t8 values (1, 2, 'x')");
  assert.throws(() => engine.execute("insert into t8 values (1, 3, 'y')"), /UNIQUE constraint failed/i);

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
      const names = external.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as unknown as Array<{ name: string }>;
      assert.deepEqual(names.map((row) => row.name), ["t8all", "t8i0", "t8u"]);
    } finally {
      external.close();
    }
  } finally {
    workspaceHandle.dispose();
  }
});
