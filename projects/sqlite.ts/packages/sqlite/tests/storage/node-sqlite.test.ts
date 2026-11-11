import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createWriter, openDatabase, openSnapshot, openWriter, writeSlots } from "../../src/index.ts";

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-node-${label}-`));
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
    { name: "label", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    { name: "score", declaredType: "REAL", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    { name: "payload", declaredType: "BLOB", notNull: false, defaultValue: null, primaryKey: false, unique: false },
  ]);
}

test("node:sqlite seeds rows that the reader and snapshot decode", () => {
  const space = workspace("seed");
  try {
    const seed = new DatabaseSync(space.path);
    seed.exec("create table n (id integer primary key, label text, score real, payload blob)");
    const insert = seed.prepare("insert into n (id, label, score, payload) values (?, ?, ?, ?)");
    insert.run(1, "one", 1.5, new Uint8Array([0x01, 0x02, 0x03]));
    insert.run(2, "two", 2.5, null);
    seed.close();

    const reader = openDatabase(space.path);
    const rows = reader.table("n");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].rowid, 1n);
    // An INTEGER PRIMARY KEY is a rowid alias, so it has no stored column value.
    assert.equal(rows[0].columns[0], null);
    assert.equal(rows[0].columns[1], "one");
    assert.equal(rows[0].columns[2], 1.5);
    assert.deepEqual(rows[0].columns[3], Buffer.from([0x01, 0x02, 0x03]));
    assert.equal(rows[1].columns[3], null);

    const snapshot = openSnapshot(reader.pages());
    assert.deepEqual(snapshot.tableDecoded("n"), rows);
    assert.equal(snapshot.encoding(), reader.encoding());
  } finally {
    space.dispose();
  }
});

test("writer output is readable by node:sqlite", () => {
  const space = workspace("write");
  try {
    const writer = createWriter(4096);
    writer.createTable("w", columns());
    writer.insert("w", writeSlots(["row-1", 2.5, new Uint8Array([0xaa, 0xbb])]));
    writer.insert("w", writeSlots(["row-2", null, null]));
    writer.save(space.path);

    const oracle = new DatabaseSync(space.path);
    const rows = oracle.prepare("select rowid, label, score, payload from w order by rowid").all() as Array<{
      rowid: number | bigint;
      label: string | null;
      score: number | null;
      payload: Uint8Array | null;
    }>;
    oracle.close();
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].rowid), 1);
    assert.equal(rows[0].label, "row-1");
    assert.equal(rows[0].score, 2.5);
    assert.deepEqual(Buffer.from(rows[0].payload!), Buffer.from([0xaa, 0xbb]));
    assert.equal(rows[1].label, "row-2");
    assert.equal(rows[1].score, null);
    assert.equal(rows[1].payload, null);
  } finally {
    space.dispose();
  }
});

test("node:sqlite writes after the reader opened the same file", () => {
  const space = workspace("append");
  try {
    const seed = new DatabaseSync(space.path);
    seed.exec("create table a (id integer primary key, label text)");
    seed.exec("insert into a (label) values ('first')");
    seed.close();

    const reader = openDatabase(space.path);
    assert.equal(reader.table("a").length, 1);

    const oracle = new DatabaseSync(space.path);
    oracle.exec("insert into a (label) values ('second')");
    oracle.close();

    const reopened = openDatabase(space.path);
    const rows = reopened.table("a");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].columns[1], "first");
    assert.equal(rows[1].columns[1], "second");
  } finally {
    space.dispose();
  }
});

test("openWriter appends rows that node:sqlite reads back", () => {
  const space = workspace("open-writer");
  try {
    const seed = new DatabaseSync(space.path);
    seed.exec("create table o (id integer primary key, label text)");
    seed.exec("insert into o (label) values ('from-node')");
    seed.close();

    const writer = openWriter(space.path);
    writer.insert("o", writeSlots([{ $omit: true }, "from-writer"]));
    writer.save(space.path);

    const oracle = new DatabaseSync(space.path);
    const labels = oracle.prepare("select label from o order by rowid").all() as Array<{ label: string }>;
    oracle.close();
    assert.deepEqual(
      labels.map((row) => row.label),
      ["from-node", "from-writer"],
    );
  } finally {
    space.dispose();
  }
});

test("snapshot copies bytes and enforces the byte limit", () => {
  const space = workspace("copy");
  try {
    const writer = createWriter(4096);
    writer.createTable("c", columns());
    writer.insert("c", writeSlots(["copy", 1.25, null]));
    const source = Buffer.from(writer.pages());

    const snapshot = openSnapshot(source);
    assert.equal(snapshot.tableDecoded("c").length, 1);
    source.fill(0);
    assert.equal(snapshot.tableDecoded("c")[0].columns[0], "copy");

    assert.throws(() => openSnapshot(Buffer.alloc(64), 32), /byte limit exceeded/);
  } finally {
    space.dispose();
  }
});
