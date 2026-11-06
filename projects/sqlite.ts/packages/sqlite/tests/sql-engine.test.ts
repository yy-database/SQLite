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

  // The file itself must report the same rows, with the statements stored
  // verbatim exactly like SQLite stores them.
  const workspaceHandle = workspace();
  try {
    writeFileSync(workspaceHandle.path, engine.snapshot());
    const external = new BetterSqlite(workspaceHandle.path);
    try {
      assert.equal(external.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(external.prepare("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master").all(), [
        { type: "table", name: "a", tbl_name: "a", rootpage: 2, sql: "create table a (x integer, y text)" },
        { type: "index", name: "ia", tbl_name: "a", rootpage: 3, sql: "create index ia on a (x)" },
        { type: "table", name: "b", tbl_name: "b", rootpage: 4, sql: "create table b (z text primary key, w text unique)" },
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
  // Partial indexes are rejected closed instead of half-built.
  assert.equal(engine.tryExecute("create index partial on t8(a8) where a8 > 0").error?.code, "unsupported-clause");

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
      assert.deepEqual(names.map((row) => row.name), ["t8all", "t8i0", "t8u"]);
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

  // The engine is single-connection and has no transaction statement, so a
  // snapshot can never carry a pending writer transaction.
  assert.equal(engine.tryExecute("begin").error?.code, "unsupported-statement");

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

  // DROP COLUMN stays a named gap lock rather than a silent half-removal.
  const dropColumn = engine.tryExecute("alter table t drop column b");
  assert.equal(dropColumn.error?.code, "unsupported-clause");
  assert.equal(dropColumn.error?.clause, "DROP COLUMN");
  assert.equal(dropColumn.error?.statement, "alter-table");
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
    ["alter table plain add column pid integer references parent (id)", "unsupported-column-constraint", "REFERENCES"],
  ];
  for (const [sql, code, clause] of cases) {
    const result = engine.tryExecute(sql);
    assert.equal(result.ok, false, sql);
    assert.equal(result.error?.code, code, sql);
    assert.equal(result.error?.clause, clause, sql);
  }
});

// Found by the seeded differential corpus. `round_cell` scales the operand
// first and rounds ties away from zero, while SQLite rounds through the shortest
// decimal representation of the operand. Both external engines agree with each
// other and disagree with this engine, so this test pins the known split rather
// than claiming this engine is correct. Upstream: engine.rs:5540-5565.
test("known differential drift pins round ties and negative precision", () => {
  const engine = createEngine();
  const cases: Array<[string, unknown[][], unknown[][]]> = [
    ["select round(1.2345, 3)", [[1.235]], [[1.234]]],
    ["select round(123.456, -1)", [[120]], [[123]]],
    ["select round(2.675, 2)", [[2.68]], [[2.67]]],
  ];
  withOracle([], (db) => {
    for (const [sql, ours, oracle] of cases) {
      assert.deepEqual(engine.execute(sql).rows, ours, sql);
      assert.deepEqual(oracleRows(db, sql), oracle, sql);
    }
  });
});
