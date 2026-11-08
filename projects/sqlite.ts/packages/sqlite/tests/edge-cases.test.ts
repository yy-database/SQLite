import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWriter, openDatabase, openSnapshot, writeSlots } from "../src/index.ts";

// External truth: `better-sqlite3` creates the WITHOUT ROWID reference files and
// every case re-reads with `PRAGMA integrity_check` and `PRAGMA page_count`.
const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(): unknown[]; get(): unknown };
  close(): void;
};

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-edge-${label}-`));
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

function headerPageSize(bytes: Buffer): number {
  const raw = bytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

function columns(): string {
  return JSON.stringify([
    { name: "id", declaredType: "INTEGER", primaryKey: true },
    { name: "label", declaredType: "TEXT" },
    { name: "score", declaredType: "REAL" },
  ]);
}

test("page_size 65536 stores the header marker and stays externally valid", () => {
  const space = workspace("65536");
  try {
    const writer = createWriter(65536);
    assert.equal(writer.pageSize(), 65536);
    writer.createTable("items", columns());
    for (let id = 1; id <= 100; id += 1) {
      writer.insert("items", writeSlots([id, `row-${id}`, id / 2]));
    }
    writer.save(space.path);

    const bytes = readFileSync(space.path);
    assert.equal(headerPageSize(bytes), 65536, "header must encode 65536 as raw value 1");
    assert.equal(bytes.length % 65536, 0);
    assert.equal(bytes.readUInt32BE(28), bytes.length / 65536, "page count matches file size");

    const oracle = new BetterSqlite(space.path);
    const pageSize = oracle.pragma("page_size", { simple: true });
    const pageCount = oracle.pragma("page_count", { simple: true });
    const integrity = oracle.pragma("integrity_check", { simple: true });
    const rows = oracle.prepare("select count(*) c from items").get() as { c: number };
    oracle.close();
    assert.equal(Number(pageSize), 65536);
    assert.equal(Number(pageCount), bytes.length / 65536);
    assert.equal(integrity, "ok");
    assert.equal(Number(rows.c), 100);

    const database = openDatabase(space.path);
    assert.equal(database.table("items").length, 100);
    assert.equal(database.encoding(), "utf8");
  } finally {
    space.dispose();
  }
});

test("composite PRIMARY KEY WITHOUT ROWID is read in key order", () => {
  const space = workspace("composite");
  try {
    const oracle = new BetterSqlite(space.path);
    oracle.exec("create table pairs (a text not null, b integer not null, note text, primary key (a, b)) without rowid");
    const insert = oracle.prepare("insert into pairs (a, b, note) values (?, ?, ?)");
    for (const [a, b] of [["b", 2], ["a", 3], ["a", 1], ["c", 2], ["b", 1]] as const) {
      insert.run(a, b, `${a}-${b}`);
    }
    assert.throws(() => insert.run("a", 1, "duplicate"), /UNIQUE constraint failed/i);
    const integrity = oracle.pragma("integrity_check", { simple: true });
    const external = oracle.prepare("select a, b, note from pairs order by a, b").all() as Array<{ a: string; b: bigint; note: string }>;
    oracle.close();
    assert.equal(integrity, "ok");
    assert.deepEqual(
      external.map((row) => [row.a, Number(row.b), row.note]),
      [["a", 1, "a-1"], ["a", 3, "a-3"], ["b", 1, "b-1"], ["b", 2, "b-2"], ["c", 2, "c-2"]],
    );

    const rows = openDatabase(space.path).tableWithoutRowid("pairs");
    assert.deepEqual(
      rows.map((columns) => [columns[0], Number(columns[1]), columns[2]]),
      external.map((row) => [row.a, Number(row.b), row.note]),
    );

    const snapshot = openSnapshot(readFileSync(space.path));
    const objects = snapshot.schema();
    assert.equal(objects.filter((object) => object.name === "pairs").length, 1);
    assert.equal(objects.find((object) => object.name === "pairs")?.kind, "table");
  } finally {
    space.dispose();
  }
});

test("header page count stays exact across deletes and the freelist", () => {
  const space = workspace("pages");
  try {
    const writer = createWriter(512);
    writer.createTable("items", columns());
    for (let id = 1; id <= 1000; id += 1) {
      writer.insert("items", writeSlots([id, `row-${id}`, id / 2]));
    }
    writer.save(space.path);

    const pageSize = 512;
    const before = statSync(space.path).size;
    assert.equal(before / pageSize, readFileSync(space.path).readUInt32BE(28));

    const oracle = new BetterSqlite(space.path);
    const beforeCount = Number(oracle.pragma("page_count", { simple: true }));
    const beforeFree = Number(oracle.pragma("freelist_count", { simple: true }));
    assert.equal(beforeCount, before / pageSize);
    assert.equal(beforeFree, 0);
    oracle.close();

    for (let id = 1; id <= 1000; id += 2) {
      assert.equal(writer.delete("items", id), true, `delete id ${id}`);
    }
    writer.save(space.path);

    const after = statSync(space.path).size;
    const afterBytes = readFileSync(space.path);
    assert.equal(after % pageSize, 0);
    assert.equal(after / pageSize, afterBytes.readUInt32BE(28), "header page count must match physical pages");

    const verifier = new BetterSqlite(space.path);
    try {
      const afterCount = Number(verifier.pragma("page_count", { simple: true }));
      const afterFree = Number(verifier.pragma("freelist_count", { simple: true }));
      const integrity = verifier.pragma("integrity_check", { simple: true });
      const rows = verifier.prepare("select count(*) c from items").get() as { c: number };
      assert.equal(afterCount, after / pageSize);
      assert.equal(afterFree, afterBytes.readUInt32BE(36));
      assert.equal(integrity, "ok");
      assert.equal(Number(rows.c), 500);
    } finally {
      verifier.close();
    }
  } finally {
    space.dispose();
  }
});

test("schema root pages are unique and inside the header page count", () => {
  const space = workspace("catalog");
  try {
    const writer = createWriter(4096);
    writer.createTable("items", columns());
    writer.createIndex("items_label", "items", ["label"], false);
    writer.createIndex("items_label_unique", "items", ["label"], true);
    writer.insert("items", writeSlots([1, "alpha", 1]));
    writer.save(space.path);

    const bytes = readFileSync(space.path);
    const pageCount = bytes.readUInt32BE(28);
    const objects = openSnapshot(bytes).schema();
    const roots = objects.filter((object) => object.kind === "table" || object.kind === "index").map((object) => object.rootPage);
    assert.equal(roots.length, 3);
    for (const root of roots) {
      assert.equal(typeof root, "number");
      assert.ok(Number(root) >= 2 && Number(root) <= pageCount, `root page ${String(root)} lies inside 2..${pageCount}`);
    }
    assert.equal(new Set(roots).size, roots.length, "each schema object owns a distinct root page");
  } finally {
    space.dispose();
  }
});
