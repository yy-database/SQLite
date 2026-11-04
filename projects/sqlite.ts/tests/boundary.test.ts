import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindings, createWriter, openSnapshot, writeSlots } from "../src/index.ts";

// External truth for this file: `better-sqlite3` writes the reference files and
// every assertion that matters is cross-checked with `PRAGMA integrity_check`.
const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(): unknown[]; get(): unknown };
  close(): void;
};

const BLANK = fileURLToPath(new URL("../../../tests/fixtures/blank.sqlite", import.meta.url));

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-boundary-${label}-`));
  return {
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

function external(path: string): { db: InstanceType<typeof BetterSqlite>; dispose: () => void } {
  const db = new BetterSqlite(path);
  return { db, dispose: () => db.close() };
}

function rowsSql(): string {
  return JSON.stringify([
    { name: "id", declaredType: "INTEGER", primaryKey: true },
    { name: "label", declaredType: "TEXT" },
    { name: "payload", declaredType: "BLOB" },
  ]);
}

test("blank fixture stays a valid one page snapshot", () => {
  const bytes = readFileSync(BLANK);
  assert.equal(bytes.length, 4096);
  assert.equal(bytes.subarray(0, 16).toString("binary"), "SQLite format 3\0");
  assert.equal(bytes.readUInt32BE(56), 1, "fixture declares UTF-8");

  assert.deepEqual(openSnapshot(bytes).schema(), []);
  assert.deepEqual(openSnapshot(bytes).table("sqlite_master"), []);
  assert.equal(openSnapshot(bytes).ping(), 1);
  assert.equal(openSnapshot(bytes).encoding(), "utf8");
  assert.equal(openSnapshot(bytes).pages().length, 4096);

  // The snapshot owns a copy: mutating the source buffer must not corrupt it.
  const copy = openSnapshot(bytes);
  bytes.fill(0);
  assert.deepEqual(copy.schema(), []);
  assert.equal(copy.ping(), 1);
});

test("snapshot rejects bytes that are not SQLite main files", () => {
  assert.throws(() => openSnapshot(Buffer.alloc(15, 0x41)), /header too short/);
  assert.throws(() => openSnapshot(Buffer.alloc(512)), /magic mismatch/);
  assert.throws(() => openSnapshot(readFileSync(BLANK).subarray(0, 100)), /not page-aligned/);
  assert.throws(() => openSnapshot(readFileSync(BLANK), 1024), /byte limit/);
  assert.throws(() => openSnapshot(readFileSync(BLANK).subarray(0, 4095)), /not page-aligned/);
});

test("read limits bound pages rows payload and total payload", () => {
  const space = workspace("limits");
  try {
    const writer = createWriter(4096);
    writer.createTable("items", rowsSql());
    for (let id = 1; id <= 200; id += 1) {
      writer.insert("items", writeSlots([id, `row-${id}`, Buffer.alloc(32, id)]));
    }
    writer.save(space.path);
    const snapshot = openSnapshot(readFileSync(space.path));

    assert.throws(() => snapshot.table("items", { maxPages: 1 }), /page limit/);
    assert.throws(() => snapshot.table("items", { maxRows: 1 }), /row limit/);
    assert.throws(() => snapshot.table("items", { maxPayloadBytes: 8 }), /payload limit/);
    assert.throws(() => snapshot.table("items", { maxTotalPayloadBytes: 16 }), /total payload limit/);
    assert.equal(snapshot.table("items").length, 200);

    const externalFile = external(space.path);
    try {
      const integrity = externalFile.db.pragma("integrity_check", { simple: true });
      assert.equal(integrity, "ok");
    } finally {
      externalFile.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("schema scans share the row limit and reject missing names", () => {
  const space = workspace("schema");
  try {
    const oracle = new BetterSqlite(space.path);
    oracle.exec("create table first (id integer primary key, a text)");
    oracle.exec("create table second (id integer primary key, b text)");
    oracle.exec("create index second_b on second (b)");
    oracle.close();

    const snapshot = openSnapshot(readFileSync(space.path));
    assert.equal(snapshot.schema().length, 3);
    assert.throws(() => snapshot.schema({ maxRows: 1 }), /row limit/);
    assert.throws(() => snapshot.table("missing"), /not found/);
    assert.throws(() => snapshot.tableDecoded("missing"), /not found/);
  } finally {
    space.dispose();
  }
});

test("virtual tables and deeply nested views fail closed", () => {
  const space = workspace("views");
  try {
    const oracle = new BetterSqlite(space.path);
    oracle.exec("create virtual table docs using fts5(body)");
    oracle.exec("create table base (id integer primary key, name text)");
    oracle.exec("insert into base (name) values ('one')");
    oracle.exec("create view v1 as select id, name from base");
    for (let depth = 2; depth <= 10; depth += 1) {
      oracle.exec(`create view v${depth} as select id, name from v${depth - 1}`);
    }
    const integrity = oracle.pragma("integrity_check", { simple: true });
    oracle.close();
    assert.equal(integrity, "ok");

    const snapshot = openSnapshot(readFileSync(space.path));
    assert.throws(() => snapshot.table("docs"), /virtual table/);
    const view = snapshot.tableDecoded("v1");
    assert.equal(view.length, 1);
    assert.equal(view[0].rowid, 1n);
    assert.deepEqual(
      view[0].columns.map((column) => [column.kind, column.valueInteger ?? column.valueText]),
      [["integer", 1n], ["text", "one"]],
    );
    assert.throws(() => snapshot.table("v9"), /view nesting depth/);
    assert.throws(() => snapshot.table("v10"), /view nesting depth/);
  } finally {
    space.dispose();
  }
});

test("decodeRecord rejects truncated and malformed payloads", () => {
  assert.throws(() => bindings.decodeRecord(Buffer.from([2, 0x0a])), /reserved serial type/);
  assert.throws(() => bindings.decodeRecord(Buffer.from([2, 0x01])), /record body/);
  assert.throws(() => bindings.decodeRecord(Buffer.from([0]), "utf-16"), /unsupported/);
  assert.deepEqual(
    bindings.decodeRecord(Buffer.from([2, 0x01, 0x05]), "utf8").map((value) => [value.kind, value.valueInteger]),
    [["integer", 5n]],
  );
});
