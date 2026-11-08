import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWriter, openDatabase, writeSlots } from "../src/index.ts";

// External truth: the same operation stream is replayed into `better-sqlite3`
// (and once through Python `sqlite3`) and the full table contents are compared.
const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(): unknown[]; get(): unknown };
  close(): void;
};

const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const ROWS = 600;

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-diff-${label}-`));
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

/** Deterministic 32-bit LCG shared by the writer stream and the oracle stream. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function payloadAt(id: number): Buffer {
  const bytes = Buffer.alloc(24);
  for (let offset = 0; offset < bytes.length; offset += 1) {
    bytes[offset] = (id * 31 + offset) % 251;
  }
  return bytes;
}

function labelAt(id: number): string {
  return `k-${String((id * 37) % 1000).padStart(4, "0")}`;
}

interface Stream {
  inserts: number[];
  updates: Array<{ id: number; n: number }>;
  deletes: number[];
}

function stream(seed: number, size: number): Stream {
  const random = lcg(seed);
  const inserts = Array.from({ length: size }, (_unused, index) => index + 1);
  for (let index = inserts.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [inserts[index], inserts[swap]] = [inserts[swap], inserts[index]];
  }
  const updates = Array.from({ length: 120 }, (_unused, index) => ({
    id: (index * 5 + 3) % size + 1,
    n: (index * 7919) % 100003,
  }));
  const deletes = Array.from({ length: 120 }, (_unused, index) => (index * 7 + 11) % size + 1);
  return { inserts, updates, deletes };
}

function createTable(target: { createTable(name: string, columns: string): void }): void {
  target.createTable(
    "items",
    JSON.stringify([
      { name: "id", declaredType: "INTEGER", primaryKey: true },
      { name: "label", declaredType: "TEXT" },
      { name: "n", declaredType: "INTEGER" },
      { name: "data", declaredType: "BLOB" },
    ]),
  );
}

function replay(space: { path: string }, operations: Stream): void {
  const writer = createWriter(1024);
  createTable(writer);
  for (const id of operations.inserts) {
    writer.insert("items", writeSlots([id, labelAt(id), (id * 31) % 100003, payloadAt(id)]));
  }
  for (const update of operations.updates) {
    writer.update("items", update.id, writeSlots([{ keep: true }, { keep: true }, { set: update.n }, { keep: true }]));
  }
  for (const id of operations.deletes) {
    writer.delete("items", id);
  }
  writer.save(space.path);
}

function replayExternal(space: { path: string }, operations: Stream): void {
  const oracle = new BetterSqlite(space.path);
  oracle.exec("pragma page_size = 1024");
  oracle.exec("create table items (id integer primary key, label text, n integer, data blob)");
  const insert = oracle.prepare("insert into items (id, label, n, data) values (?, ?, ?, ?)");
  const update = oracle.prepare("update items set n = ? where id = ?");
  const remove = oracle.prepare("delete from items where id = ?");
  for (const id of operations.inserts) {
    insert.run(id, labelAt(id), (id * 31) % 100003, payloadAt(id));
  }
  for (const updated of operations.updates) {
    update.run(updated.n, updated.id);
  }
  for (const id of operations.deletes) {
    remove.run(id);
  }
  assert.equal(oracle.pragma("integrity_check", { simple: true }), "ok");
  oracle.close();
}

function snapshotRows(path: string): Array<[number, string, number, string]> {
  const oracle = new BetterSqlite(path);
  const rows = oracle.prepare("select id, label, n, hex(data) h from items order by id").all() as Array<{
    id: number;
    label: string;
    n: number;
    h: string;
  }>;
  oracle.close();
  return rows.map((row) => [Number(row.id), row.label, Number(row.n), row.h.toLowerCase()]);
}

test("seeded insert update delete stream matches better-sqlite3 exactly", () => {
  const ours = workspace("stream");
  const mirror = workspace("mirror");
  try {
    const operations = stream(0x5eed, ROWS);
    replay(ours, operations);
    replayExternal(mirror, operations);
    assert.deepEqual(snapshotRows(ours.path), snapshotRows(mirror.path));

    // Our own reader must agree with the external row order and values.
    const reader = openDatabase(ours.path);
    const rows = reader.table("items");
    const expected = snapshotRows(ours.path);
    assert.equal(rows.length, expected.length);
    assert.deepEqual(
      rows.map((row) => {
        const columns = row.columns;
        return [Number(row.rowid), columns[1], Number(columns[2])];
      }),
      expected.map((row) => row.slice(0, 3)),
    );
  } finally {
    ours.dispose();
    mirror.dispose();
  }
});

test("seeded stream survives a Python sqlite3 replay", () => {
  const ours = workspace("python");
  try {
    const operations = stream(0x1ced, ROWS);
    replay(ours, operations);
    const expected = snapshotRows(ours.path);
    const script = [
      "import json, sqlite3, sys",
      "connection = sqlite3.connect(sys.argv[1])",
      "assert connection.execute('pragma integrity_check').fetchone()[0] == 'ok'",
      "rows = connection.execute('select id, label, n, lower(hex(data)) from items order by id').fetchall()",
      "print(json.dumps([[int(row[0]), row[1], int(row[2]), row[3]] for row in rows]))",
      "connection.close()",
    ].join("\n");
    const output = spawnSync(PYTHON, ["-c", script, ours.path], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(output.error);
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout) as unknown, expected);
  } finally {
    ours.dispose();
  }
});

test("index streams keep duplicate labels reachable through the external scan", () => {
  const space = workspace("index");
  try {
    const writer = createWriter(4096);
    createTable(writer);
    writer.createIndex("items_label", "items", ["label"], false);
    const operations = stream(0x1de, ROWS);
    for (const id of operations.inserts) {
      writer.insert("items", writeSlots([id, labelAt(id), (id * 31) % 100003, payloadAt(id)]));
    }
    for (const id of operations.deletes) {
      writer.delete("items", id);
    }
    writer.save(space.path);

    const path = space.path;
    const oracle = new BetterSqlite(path);
    const external = oracle.prepare("select id, label from items indexed by items_label order by label, id").all() as Array<{
      id: number;
      label: string;
    }>;
    assert.equal(oracle.pragma("integrity_check", { simple: true }), "ok");
    oracle.close();

    const index = openDatabase(path).index("items_label");
    assert.deepEqual(
      index.map((row) => [Number(row.rowid), row.columns[0]]),
      external.map((row) => [Number(row.id), row.label]),
    );
  } finally {
    space.dispose();
  }
});
