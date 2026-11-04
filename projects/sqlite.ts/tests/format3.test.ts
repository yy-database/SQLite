import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWriter, openDatabase, writeSlots } from "../packages/sqlite/src/index.ts";

const require = createRequire(import.meta.url);

interface Statement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
  safeIntegers(flag: boolean): Statement;
}

interface ExternalDatabase {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): Statement;
  close(): void;
}

const BetterSqlite = require("better-sqlite3") as new (path: string) => ExternalDatabase;

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows 仍持有句柄时忽略清理失败，临时目录随系统回收。
      }
    },
  };
}

function columns(): string {
  return JSON.stringify([
    { name: "id", declaredType: "INTEGER", notNull: false, defaultValue: null, primaryKey: true, unique: false },
    { name: "label", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    { name: "score", declaredType: "REAL", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    { name: "payload", declaredType: "BLOB", notNull: false, defaultValue: null, primaryKey: false, unique: false },
  ]);
}

function headerPageSize(bytes: Buffer): number {
  const raw = bytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

function externalPageSize(path: string): number {
  const oracle = new BetterSqlite(path);
  const row = oracle.prepare("pragma page_size").get() as { page_size: number };
  oracle.close();
  return Number(row.page_size);
}

test("page header and page size survive the writer", () => {
  const space = workspace("header");
  try {
    const writer = createWriter(4096);
    writer.createTable("h", columns());
    writer.insert("h", writeSlots([{ $omit: true }, "one", 1.25, null]));
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const pageSize = oracle.prepare("pragma page_size").get() as { page_size: number };
    const journal = oracle.prepare("pragma journal_mode").get() as { journal_mode: string };
    const master = oracle.prepare("select count(*) c from sqlite_master").get() as { c: number };
    const integrity = oracle.prepare("pragma integrity_check").get() as { integrity_check: string };
    oracle.close();
    assert.equal(Number(pageSize.page_size), 4096);
    assert.equal(journal.journal_mode, "delete");
    assert.equal(Number(master.c), 1);
    assert.equal(integrity.integrity_check, "ok");

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.pragma("page_size = 2048");
    seed.exec("create table e (id integer primary key, label text)");
    seed.prepare("insert into e (label) values (?)").run("external-one");
    seed.close();

    const expected = externalPageSize(externalPath);
    const reader = openDatabase(externalPath);
    assert.equal(headerPageSize(reader.pages()), expected);
    assert.equal(reader.pages().length % expected, 0);
    const rows = reader.table("e");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].columns[1].valueText, "external-one");
  } finally {
    space.dispose();
  }
});

test("leaf splits and dividers keep rowid order across external readers", () => {
  const space = workspace("split");
  try {
    const writer = createWriter(1024);
    writer.createTable("s", columns());
    for (let index = 1; index <= 1200; index += 1) {
      writer.insert("s", writeSlots([{ $omit: true }, `row-${index}`, index / 2, null]));
    }
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const count = oracle.prepare("select count(*) c from s").get() as { c: number };
    const order = oracle.prepare("select rowid as rid from s order by rowid").all() as { rid: number }[];
    const last = oracle.prepare("select rowid as rid, label from s order by rowid desc limit 1").get() as {
      rid: number;
      label: string;
    };
    const integrity = oracle.prepare("pragma integrity_check").get() as { integrity_check: string };
    oracle.close();
    assert.equal(Number(count.c), 1200);
    assert.equal(Number(last.rid), 1200);
    assert.equal(last.label, "row-1200");
    assert.equal(integrity.integrity_check, "ok");

    const reader = openDatabase(space.path);
    const rows = reader.table("s");
    assert.deepEqual(
      rows.map((row) => Number(row.rowid)),
      order.map((row) => Number(row.rid)),
    );

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.pragma("page_size = 1024");
    seed.exec("create table s (id integer primary key, label text, score real, payload blob)");
    seed.exec("begin");
    const insert = seed.prepare("insert into s (label, score) values (?, ?)");
    for (let index = 1; index <= 1200; index += 1) {
      insert.run(`row-${index}`, index / 2);
    }
    seed.exec("commit");
    seed.close();

    const external = new BetterSqlite(externalPath);
    const externalRowids = external
      .prepare("select rowid as rid from s order by rowid")
      .all() as { rid: number }[];
    external.close();
    const mirror = openDatabase(externalPath).table("s");
    assert.equal(mirror.length, 1200);
    assert.deepEqual(
      mirror.map((row) => Number(row.rowid)),
      externalRowids.map((row) => Number(row.rid)),
    );
  } finally {
    space.dispose();
  }
});

test("overflow payloads round trip through better-sqlite3", () => {
  const space = workspace("overflow");
  try {
    const writer = createWriter(512);
    writer.createTable("o", columns());
    const bytes = Buffer.alloc(3000, 7);
    writer.insert("o", writeSlots([{ $omit: true }, "big", 1, bytes]));
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const row = oracle.prepare("select length(payload) n, hex(payload) body from o").get() as { n: number; body: string };
    const integrity = oracle.prepare("pragma integrity_check").get() as { integrity_check: string };
    oracle.close();
    assert.equal(Number(row.n), 3000);
    assert.equal(integrity.integrity_check, "ok");

    const decoded = openDatabase(space.path).table("o");
    assert.equal(decoded[0].columns[3].valueBlob?.length, Number(row.n));
    assert.equal(decoded[0].columns[3].valueBlob?.toString("hex"), row.body);

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.pragma("page_size = 512");
    seed.exec("create table o (id integer primary key, label text, score real, payload blob)");
    const external = Buffer.alloc(3000, 9);
    seed.prepare("insert into o (label, score, payload) values (?, ?, ?)").run("external-big", 1, external);
    seed.close();

    const mirrored = openDatabase(externalPath).table("o");
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0].columns[3].kind, "blob");
    assert.equal(mirrored[0].columns[3].valueBlob?.toString("hex"), external.toString("hex"));
  } finally {
    space.dispose();
  }
});

test("serial types preserve storage class before and after external readers", () => {
  const space = workspace("serial");
  try {
    const writer = createWriter(4096);
    writer.createTable("v", JSON.stringify([
      { name: "id", declaredType: "INTEGER", notNull: false, defaultValue: null, primaryKey: true, unique: false },
      { name: "kind", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKey: false, unique: false },
      { name: "value", declaredType: "BLOB", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    ]));
    const payloads = [
      ["null", null],
      ["empty-text", ""],
      ["min-int", { $i64: "-9223372036854775808" }],
      ["max-int", { $i64: "9223372036854775807" }],
      ["real", 2.5],
      ["unicode", "案例-明"],
      ["empty-blob", Buffer.alloc(0)],
      ["blob", Buffer.from([1, 2, 3])],
    ] as const;
    for (const [kind, value] of payloads) {
      writer.insert("v", writeSlots([{ $omit: true }, kind, value]));
    }
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const rows = oracle.prepare("select kind, typeof(value) t from v order by rowid").all() as {
      kind: string;
      t: string;
    }[];
    const extremesStatement = oracle.prepare("select value from v where rowid in (3, 4) order by rowid");
    extremesStatement.safeIntegers(true);
    const extremes = extremesStatement.all() as { value: bigint }[];
    const unicode = oracle.prepare("select value from v where rowid = 6").get() as { value: string };
    const integrity = oracle.prepare("pragma integrity_check").get() as { integrity_check: string };
    oracle.close();
    assert.deepEqual(rows.map((row) => row.t), [
      "null",
      "text",
      "integer",
      "integer",
      "real",
      "text",
      "blob",
      "blob",
    ]);
    assert.equal(extremes[0].value, -9223372036854775808n);
    assert.equal(extremes[1].value, 9223372036854775807n);
    assert.equal(integrity.integrity_check, "ok");

    const decoded = openDatabase(space.path).table("v");
    assert.deepEqual(decoded.map((row) => row.columns[2].kind), rows.map((row) => row.t));
    assert.equal(decoded[5].columns[2].valueText, unicode.value);

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.exec("create table v (id integer primary key, kind text, value blob)");
    const insert = seed.prepare("insert into v (kind, value) values (?, ?)");
    for (const [kind, value] of payloads) {
      insert.run(kind, value === null || typeof value === "string" ? value : Buffer.isBuffer(value) ? value : undefined);
    }
    const extremesInsert = seed.prepare("update v set value = ? where kind = ?");
    extremesInsert.safeIntegers(true);
    extremesInsert.run(-9223372036854775808n, "min-int");
    extremesInsert.run(9223372036854775807n, "max-int");
    seed.prepare("update v set value = 2.5 where kind = 'real'").run();
    seed.close();

    const externalKinds = (() => {
      const oracle = new BetterSqlite(externalPath);
      const result = oracle.prepare("select typeof(value) t from v order by rowid").all() as { t: string }[];
      oracle.close();
      return result.map((row) => row.t);
    })();
    const mirrored = openDatabase(externalPath).table("v");
    assert.deepEqual(mirrored.map((row) => row.columns[2].kind), externalKinds);
    assert.equal(mirrored[5].columns[2].valueText, unicode.value);
  } finally {
    space.dispose();
  }
});

test("declared REAL columns apply real affinity", () => {
  const space = workspace("affinity");
  try {
    const writer = createWriter(4096);
    writer.createTable("r", JSON.stringify([
      { name: "id", declaredType: "INTEGER", notNull: false, defaultValue: null, primaryKey: true, unique: false },
      { name: "score", declaredType: "REAL", notNull: false, defaultValue: null, primaryKey: false, unique: false },
      { name: "maybe", declaredType: "NUMERIC", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    ]));
    writer.insert("r", writeSlots([{ $omit: true }, 7, 3]));
    writer.insert("r", writeSlots([{ $omit: true }, "7.5", "3.5"]));
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const rows = oracle.prepare("select typeof(score) s, typeof(maybe) m, score, maybe from r order by rowid").all() as {
      s: string;
      m: string;
      score: number;
      maybe: number;
    }[];
    oracle.close();
    assert.deepEqual(rows, [
      { s: "real", m: "integer", score: 7, maybe: 3 },
      { s: "real", m: "real", score: 7.5, maybe: 3.5 },
    ]);

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.exec("create table r (id integer primary key, score real, maybe numeric)");
    seed.exec("insert into r (score, maybe) values (7, 3)");
    seed.exec("insert into r (score, maybe) values ('7.5', '3.5')");
    seed.close();

    const external = new BetterSqlite(externalPath);
    const externalValues = external.prepare("select score, maybe from r order by rowid").all() as {
      score: number;
      maybe: number;
    }[];
    const externalKinds = external
      .prepare("select typeof(maybe) m from r order by rowid")
      .all() as { m: string }[];
    external.close();
    const mirrored = openDatabase(externalPath).table("r");
    // SQLite stores integral REAL values as integers on disk, so the record-level
    // reader sees `integer` where a SQL read reports `real`. Values must agree.
    assert.deepEqual(
      mirrored.map((row) => [
        Number(row.columns[1].valueReal ?? row.columns[1].valueInteger),
        Number(row.columns[2].valueReal ?? row.columns[2].valueInteger),
      ]),
      externalValues.map((row) => [row.score, row.maybe]),
    );
    assert.deepEqual(
      mirrored.map((row) => row.columns[2].kind),
      externalKinds.map((row) => row.m),
    );
  } finally {
    space.dispose();
  }
});

test("INTEGER PRIMARY KEY stays a rowid alias", () => {
  const space = workspace("rowid");
  try {
    const writer = createWriter(4096);
    writer.createTable("a", columns());
    const first = writer.insert("a", writeSlots([{ $omit: true }, "auto", 1, null]));
    const second = writer.insert("a", writeSlots([100, "explicit", 2, null]));
    writer.save(space.path);
    assert.equal(first, 1);
    assert.equal(second, 100);

    const oracle = new BetterSqlite(space.path);
    const rows = oracle.prepare("select rowid as rid, id from a order by rowid").all() as { rid: number; id: number }[];
    oracle.close();
    assert.deepEqual(rows.map((row) => ({ rid: Number(row.rid), id: Number(row.id) })), [
      { rid: 1, id: 1 },
      { rid: 100, id: 100 },
    ]);

    const decoded = openDatabase(space.path).table("a");
    assert.deepEqual(
      decoded.map((row) => Number(row.rowid)),
      rows.map((row) => Number(row.rid)),
    );

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.exec("create table a (id integer primary key, label text, score real, payload blob)");
    seed.exec("insert into a (id, label) values (1, 'auto')");
    seed.exec("insert into a (id, label) values (250, 'explicit')");
    seed.close();

    const external = new BetterSqlite(externalPath);
    const externalRowids = external.prepare("select rowid as rid from a order by rowid").all() as { rid: number }[];
    external.close();
    const mirrored = openDatabase(externalPath).table("a");
    assert.deepEqual(
      mirrored.map((row) => Number(row.rowid)),
      externalRowids.map((row) => Number(row.rid)),
    );
    assert.equal(mirrored[1].columns[1].valueText, "explicit");
  } finally {
    space.dispose();
  }
});

test("sqlite_master and index listing match external pragma", () => {
  const space = workspace("schema");
  try {
    const writer = createWriter(4096);
    writer.createTable("m", JSON.stringify([
      { name: "id", declaredType: "INTEGER", notNull: false, defaultValue: null, primaryKey: true, unique: false },
      { name: "slug", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKey: false, unique: true },
      { name: "name", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    ]));
    writer.createIndex("m_name", "m", ["name"], false);
    writer.createIndex("m_name_unique", "m", ["name"], true);
    writer.insert("m", writeSlots([{ $omit: true }, "a", "alpha"]));
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const master = oracle.prepare("select name, type from sqlite_master order by name").all() as {
      name: string;
      type: string;
    }[];
    const indexes = oracle.prepare("select name, origin from pragma_index_list('m') order by name").all() as {
      name: string;
      origin: string;
    }[];
    oracle.close();
    assert.deepEqual(master.map((row) => `${row.type}:${row.name}`), [
      "table:m",
      "index:m_name",
      "index:m_name_unique",
      "index:sqlite_autoindex_m_1",
    ]);
    assert.deepEqual(indexes.map((row) => `${row.name}:${row.origin}`), [
      "m_name:c",
      "m_name_unique:c",
      "sqlite_autoindex_m_1:u",
    ]);

    const decoded = openDatabase(space.path)
      .schema()
      .map((object) => `${object.kind}:${object.name}`)
      .sort();
    assert.deepEqual(decoded, master.map((row) => `${row.type}:${row.name}`).sort());

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.exec("create table m (id integer primary key, slug text unique, name text)");
    seed.exec("create index m_name on m (name)");
    seed.exec("create unique index m_name_unique on m (name)");
    seed.exec("insert into m (slug, name) values ('a', 'alpha')");
    const external = new BetterSqlite(externalPath);
    const externalMaster = external.prepare("select name, type from sqlite_master order by name").all() as {
      name: string;
      type: string;
    }[];
    external.close();
    seed.close();

    const mirrored = openDatabase(externalPath)
      .schema()
      .map((object) => `${object.kind}:${object.name}`)
      .sort();
    assert.deepEqual(mirrored, externalMaster.map((row) => `${row.type}:${row.name}`).sort());
  } finally {
    space.dispose();
  }
});

test("update delete and rollback stay externally consistent", () => {
  const space = workspace("mutate");
  try {
    const writer = createWriter(4096);
    writer.createTable("u", columns());
    for (let index = 1; index <= 20; index += 1) {
      writer.insert("u", writeSlots([{ $omit: true }, `r${index}`, index, null]));
    }
    writer.begin();
    writer.insert("u", writeSlots([{ $omit: true }, "rolled-back", 0, null]));
    writer.rollback();
    writer.update("u", 5, JSON.stringify([{ keep: true }, { set: "updated" }, { set: 5.5 }, { keep: true }]));
    writer.delete("u", 7);
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const count = oracle.prepare("select count(*) c from u").get() as { c: number };
    const updated = oracle.prepare("select label, score from u where rowid = 5").get() as {
      label: string;
      score: number;
    };
    const deleted = oracle.prepare("select count(*) c from u where rowid = 7").get() as { c: number };
    const remnants = oracle.prepare("select count(*) c from u where label = 'rolled-back'").get() as { c: number };
    const integrity = oracle.prepare("pragma integrity_check").get() as { integrity_check: string };
    oracle.close();
    assert.equal(Number(count.c), 19);
    assert.deepEqual(updated, { label: "updated", score: 5.5 });
    assert.equal(Number(deleted.c), 0);
    assert.equal(Number(remnants.c), 0);
    assert.equal(integrity.integrity_check, "ok");

    const decoded = openDatabase(space.path).table("u");
    assert.equal(decoded.length, Number(count.c));
    assert.equal(decoded[4].columns[1].valueText, updated.label);
    assert.equal(decoded[4].columns[2].valueReal, updated.score);

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.exec("create table u (id integer primary key, label text, score real, payload blob)");
    seed.exec("begin");
    const insert = seed.prepare("insert into u (label, score) values (?, ?)");
    for (let index = 1; index <= 20; index += 1) {
      insert.run(`r${index}`, index);
    }
    seed.exec("rollback");
    seed.exec("begin");
    for (let index = 1; index <= 20; index += 1) {
      insert.run(`r${index}`, index);
    }
    seed.exec("commit");
    seed.exec("begin");
    seed.prepare("insert into u (label, score) values ('rolled-back', 0)").run();
    seed.exec("rollback");
    seed.exec("update u set label = 'updated', score = 5.5 where rowid = 5");
    seed.exec("delete from u where rowid = 7");
    seed.close();

    const external = new BetterSqlite(externalPath);
    const externalRows = external.prepare("select rowid as rid, label from u order by rowid").all() as {
      rid: number;
      label: string;
    }[];
    external.close();
    const mirrored = openDatabase(externalPath).table("u");
    assert.deepEqual(
      mirrored.map((row) => [Number(row.rowid), row.columns[1].valueText]),
      externalRows.map((row) => [Number(row.rid), row.label]),
    );
    assert.equal(readFileSync(externalPath).length > 0, true);
  } finally {
    space.dispose();
  }
});

test("WITHOUT ROWID rows are read from the primary-key index b-tree", () => {
  const space = workspace("without-rowid");
  try {
    const oracle = new BetterSqlite(space.path);
    oracle.exec("create table wo (k text primary key, v integer) without rowid");
    oracle.exec("insert into wo values ('b', 2), ('a', 1), ('c', 3)");
    const external = oracle.prepare("select k, v from wo order by k").all() as { k: string; v: number }[];
    oracle.close();

    const rows = openDatabase(space.path).tableWithoutRowid("wo");
    assert.deepEqual(
      rows.map((columns) => [columns[0].valueText, Number(columns[1].valueInteger)]),
      external.map((row) => [row.k, row.v]),
    );
    assert.deepEqual(rows[0].map((value) => value.kind), ["text", "integer"]);
    assert.throws(() => openDatabase(space.path).table("wo"), /index b-tree|unsupported/i);
  } finally {
    space.dispose();
  }
});

test("secondary index scans match external INDEXED BY order in both directions", () => {
  const space = workspace("index");
  try {
    const writer = createWriter(1024);
    writer.createTable("ix", columns());
    writer.createIndex("i_label", "ix", ["label"], false);
    for (let index = 1; index <= 1200; index += 1) {
      const label = `label-${String((index * 37) % 1200).padStart(4, "0")}`;
      writer.insert("ix", writeSlots([{ $omit: true }, label, index / 2, null]));
    }
    writer.save(space.path);

    const main = openDatabase(space.path);
    const pages = main.pages();
    assert.ok(pages.length / headerPageSize(pages) > 4, "the secondary index must span pages");

    const oracle = new BetterSqlite(space.path);
    const externalOrder = oracle
      .prepare("select rowid as rid, label from ix indexed by i_label order by label, rowid")
      .all() as { rid: number; label: string }[];
    const integrity = oracle.prepare("pragma integrity_check").get() as { integrity_check: string };
    oracle.exec("drop index i_label");
    oracle.exec("create index i_label on ix (label)");
    const rebuiltOrder = oracle
      .prepare("select rowid as rid, label from ix indexed by i_label order by label, rowid")
      .all() as { rid: number; label: string }[];
    oracle.close();
    assert.equal(externalOrder.length, 1200);
    assert.equal(integrity.integrity_check, "ok");
    assert.deepEqual(rebuiltOrder, externalOrder);

    const scanned = main.index("i_label");
    assert.equal(scanned.length, externalOrder.length);
    assert.deepEqual(
      scanned.map((row) => [Number(row.rowid), row.columns[0].valueText]),
      externalOrder.map((row) => [Number(row.rid), row.label]),
    );

    const externalPath = join(space.path, "..", "external.sqlite3");
    const seed = new BetterSqlite(externalPath);
    seed.pragma("page_size = 1024");
    seed.exec("create table ix (id integer primary key, label text, score real, payload blob)");
    seed.exec("create index i_label on ix (label)");
    seed.exec("begin");
    const insert = seed.prepare("insert into ix (label, score) values (?, ?)");
    for (let index = 1; index <= 1200; index += 1) {
      insert.run(`label-${String((index * 53) % 1200).padStart(4, "0")}`, index / 2);
    }
    seed.exec("commit");
    seed.close();

    const external = new BetterSqlite(externalPath);
    const expected = external
      .prepare("select rowid as rid, label from ix indexed by i_label order by label, rowid")
      .all() as { rid: number; label: string }[];
    external.close();
    const mirrored = openDatabase(externalPath).index("i_label");
    assert.equal(mirrored.length, expected.length);
    assert.deepEqual(
      mirrored.map((row) => [Number(row.rowid), row.columns[0].valueText]),
      expected.map((row) => [Number(row.rid), row.label]),
    );
  } finally {
    space.dispose();
  }
});

test("external UTF-16 databases decode text through the declared encoding", () => {
  const space = workspace("utf16");
  try {
    const path = join(space.path, "..", "utf16.sqlite3");
    const seed = new BetterSqlite(path);
    seed.pragma("encoding = 'UTF-16le'");
    seed.exec("create table u (id integer primary key, label text)");
    seed.prepare("insert into u (label) values (?)").run("案例-明");
    const declared = seed.prepare("pragma encoding").get() as { encoding: string };
    seed.close();

    const reader = openDatabase(path);
    assert.equal(declared.encoding.toUpperCase(), "UTF-16LE");
    assert.equal(reader.encoding(), "utf16le");
    assert.equal(reader.pages().readUInt32BE(56), 2);
    assert.deepEqual(
      reader.table("u").map((row) => row.columns[1].valueText),
      ["案例-明"],
    );
  } finally {
    space.dispose();
  }
});

test("external views resolve to their base table while virtual tables fail closed", () => {
  const space = workspace("objects");
  try {
    const path = join(space.path, "..", "objects.sqlite3");
    const seed = new BetterSqlite(path);
    seed.exec("create table base (id integer primary key, label text) strict");
    seed.prepare("insert into base (label) values (?)").run("strict-row");
    seed.exec("create view v as select id, label from base");
    seed.exec("create virtual table vt using fts5(body)");
    seed.prepare("insert into vt (body) values (?)").run("virtual-row");
    const external = seed.prepare("select type, name from sqlite_master order by name").all() as {
      type: string;
      name: string;
    }[];
    seed.close();

    const reader = openDatabase(path);
    assert.deepEqual(
      reader
        .schema()
        .map((object) => `${object.kind}:${object.name}`)
        .sort(),
      external.map((row) => `${row.type}:${row.name}`).sort(),
    );
    assert.deepEqual(
      reader.table("base").map((row) => row.columns[1].valueText),
      ["strict-row"],
    );
    assert.deepEqual(
      reader.table("v").map((row) => row.columns.map((column) => column.valueText ?? Number(column.valueInteger))),
      [[1, "strict-row"]],
      "a simple projection view resolves against its base table",
    );
    assert.throws(() => reader.table("vt"), /virtual|unsupported/i);
  } finally {
    space.dispose();
  }
});

test("rotated WAL checkpoints keep the snapshot consistent", () => {
  const space = workspace("wal-rotate");
  try {
    const seed = new BetterSqlite(space.path);
    seed.pragma("journal_mode = wal");
    seed.exec("create table r (id integer primary key, label text)");
    const insert = seed.prepare("insert into r (label) values (?)");
    for (let index = 1; index <= 20; index += 1) insert.run(`first-${index}`);
    seed.pragma("wal_checkpoint(TRUNCATE)");
    for (let index = 1; index <= 20; index += 1) insert.run(`second-${index}`);
    seed.pragma("wal_checkpoint(PASSIVE)");

    assert.ok(existsSync(`${space.path}-wal`), "a committed WAL sidecar must exist");
    assert.ok(readFileSync(`${space.path}-wal`).length > 32);
    assert.ok(existsSync(`${space.path}-shm`), "an open connection keeps the shared-memory index");

    const externalCount = seed.prepare("select count(*) c from r").get() as { c: number };
    const reader = openDatabase(space.path);
    assert.equal(reader.table("r").length, Number(externalCount.c));
    assert.deepEqual(
      reader.table("r").map((row) => row.columns[1].valueText).slice(-1),
      ["second-20"],
    );

    seed.pragma("wal_checkpoint(TRUNCATE)");
    assert.ok(!readFileSync(`${space.path}-wal`).length, "a truncating checkpoint empties the sidecar");
    assert.equal(reader.table("r").length, Number(externalCount.c));
    seed.close();
  } finally {
    space.dispose();
  }
});
