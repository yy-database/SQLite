import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createWriter, openDatabase, writeSlots } from "../src/index.ts";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string): unknown;
  prepare(source: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
    safeIntegers(flag: boolean): unknown;
  };
  close(): void;
};

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
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

test("page header and page size survive the writer", () => {
  const space = workspace("header");
  try {
    const writer = createWriter(4096);
    writer.createTable("h", columns());
    writer.insert("h", writeSlots([{ $omit: true }, "one", 1.25, null]));
    writer.save(space.path);

    const oracle = new DatabaseSync(space.path);
    const pageSize = oracle.prepare("PRAGMA page_size").get() as { page_size: number };
    const format = oracle.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const header = oracle.prepare("select count(*) c from sqlite_master").get() as { c: number };
    oracle.close();
    assert.equal(pageSize.page_size, 4096);
    assert.equal(format.journal_mode, "delete");
    assert.equal(header.c, 1);

    const reader = openDatabase(space.path);
    assert.match(reader.encoding(), /utf/i);
    assert.match(reader.sqliteVersion(), /^3\./);
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

    const oracle = new DatabaseSync(space.path);
    const count = oracle.prepare("select count(*) c from s").get() as { c: number };
    const order = oracle.prepare("select rowid as rid from s order by rowid limit 3").all() as { rid: number }[];
    const last = oracle.prepare("select rowid as rid, label from s order by rowid desc limit 1").get() as {
      rid: number;
      label: string;
    };
    const integrity = oracle.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    oracle.close();
    assert.equal(count.c, 1200);
    assert.deepEqual(
      order.map((row) => Number(row.rid)),
      [1, 2, 3],
    );
    assert.equal(Number(last.rid), 1200);
    assert.equal(last.label, "row-1200");
    assert.equal(integrity.integrity_check, "ok");

    const reader = openDatabase(space.path);
    const rows = reader.table("s");
    assert.equal(rows.length, 1200);
    assert.equal(rows[0].rowid, 1n);
    assert.equal(rows[1199].rowid, 1200n);
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
    const row = oracle.prepare("select length(payload) n, substr(payload, 1, 1) first from o").get() as {
      n: number;
      first: number;
    };
    (oracle.pragma("integrity_check") as { integrity_check: string }[])[0].integrity_check;
    oracle.close();
    assert.equal(row.n, 3000);

    const reader = openDatabase(space.path);
    const decoded = reader.table("o");
    assert.equal(decoded[0].columns[0].kind, "null");
    assert.equal(decoded[0].columns[3].kind, "blob");
    assert.equal(decoded[0].columns[3].valueBlob?.length, 3000);
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

    const reader = openDatabase(space.path);
    const decoded = reader.table("v");
    assert.deepEqual(decoded.map((row) => row.columns[2].kind), [
      "null",
      "text",
      "integer",
      "integer",
      "real",
      "text",
      "blob",
      "blob",
    ]);
    assert.equal(decoded[5].columns[2].valueText, "案例-明");
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

    const oracle = new DatabaseSync(space.path);
    const rows = oracle.prepare("select rowid as rid, id from a order by rowid").all() as { rid: number; id: number }[];
    oracle.close();
    assert.deepEqual(rows.map((row) => ({ rid: Number(row.rid), id: Number(row.id) })), [
      { rid: 1, id: 1 },
      { rid: 100, id: 100 },
    ]);

    const reader = openDatabase(space.path);
    const decoded = reader.table("a");
    assert.equal(decoded[0].rowid, 1n);
    assert.equal(decoded[0].columns[0].kind, "null");
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

    const oracle = new DatabaseSync(space.path);
    const master = oracle.prepare("select name, type from sqlite_master order by name").all() as {
      name: string;
      type: string;
    }[];
    const indexes = oracle.prepare("select name, origin from pragma_index_list('m') order by name").all() as {
      name: string;
      origin: string;
    }[];
    oracle.close();
    assert.deepEqual(master.map((row) => ({ name: row.name, type: row.type })), [
      { name: "m", type: "table" },
      { name: "m_name", type: "index" },
      { name: "m_name_unique", type: "index" },
      { name: "sqlite_autoindex_m_1", type: "index" },
    ]);
    assert.deepEqual(indexes.map((row) => ({ name: row.name, origin: row.origin })), [
      { name: "m_name", origin: "c" },
      { name: "m_name_unique", origin: "c" },
      { name: "sqlite_autoindex_m_1", origin: "u" },
    ]);

    const reader = openDatabase(space.path);
    assert.deepEqual(
      reader
        .schema()
        .map((object) => `${object.kind}:${object.name}`)
        .sort(),
      ["index:m_name", "index:m_name_unique", "index:sqlite_autoindex_m_1", "table:m"],
    );
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
    oracle.close();
    assert.equal(count.c, 19);
    assert.deepEqual(updated, { label: "updated", score: 5.5 });
    assert.equal(deleted.c, 0);
    assert.equal(remnants.c, 0);
  } finally {
    space.dispose();
  }
});

test("WITHOUT ROWID tables are rejected explicitly", () => {
  const space = workspace("without-rowid");
  try {
    const oracle = new BetterSqlite(space.path);
    oracle.prepare("create table wo (k text primary key, v integer) without rowid").run();
    oracle.prepare("insert into wo values ('a', 1)").run();
    oracle.close();

    const reader = openDatabase(space.path);
    assert.throws(() => reader.table("wo"), /WITHOUT ROWID|without rowid|index b-tree|unsupported/i);
  } finally {
    space.dispose();
  }
});
