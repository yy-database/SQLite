// 大结果集物化边界：`all()` 与 `iterate()` 都在原生侧一次取回完整行集，
// TS 层再投影。这里用 50,000 行验证结果完整、不崩溃，并输出行数、耗时与
// RSS 变化；不设绝对内存/耗时上限，避免把机器差异当成回归。
//
// 已知边界：`iterate()` 只是对已物化结果的 Iterator 协议，不是流式游标，
// 峰值内存随结果行数增长。需要流式消费时应在 SQL 侧分页。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLite, createWriter, writeSlots } from "../../src/index.ts";

const ROWS = 50_000;

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may keep the handle briefly.
      }
    },
  };
}

function seed(path: string): void {
  const writer = createWriter(4096);
  writer.createTable(
    "big",
    JSON.stringify([
      { name: "id", declaredType: "INTEGER", primaryKey: true },
      { name: "label", declaredType: "TEXT" },
    ]),
  );
  writer.begin();
  for (let id = 1; id <= ROWS; id += 1) writer.insert("big", writeSlots([id, `row-${id}`]));
  writer.commit();
  writer.save(path);
}

function assertRows(rows: { id: bigint; label: string }[], label: string): void {
  assert.equal(rows.length, ROWS, `${label}: row count`);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.id !== BigInt(index + 1) || rows[index]!.label !== `row-${index + 1}`) {
      assert.fail(`${label}: broken row at ${index}: ${JSON.stringify(rows[index])}`);
    }
  }
}

test("known boundary: a 50,000-row result is fully materialized, not streaming", { timeout: 120_000 }, (t) => {
  const space = workspace("materialize");
  try {
    seed(space.path);
    const db = new SQLite({ filename: space.path, readOnly: true });
    try {
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();
      const rows = db.all<{ id: bigint; label: string }>("select id, label from big order by id");
      const allMs = performance.now() - started;
      assertRows(rows, "all");

      const iterStarted = performance.now();
      const iterated: { id: bigint; label: string }[] = [];
      for (const row of db.iterate<{ id: bigint; label: string }>("select id, label from big order by id")) iterated.push(row);
      const iterateMs = performance.now() - iterStarted;
      assertRows(iterated, "iterate");
      const rssAfter = process.memoryUsage().rss;

      t.diagnostic(
        `rows=${ROWS} all=${allMs.toFixed(1)}ms iterate=${iterateMs.toFixed(1)}ms ` +
          `rss +${((rssAfter - rssBefore) / 1048576).toFixed(1)}MiB (after ${(rssAfter / 1048576).toFixed(1)}MiB)`,
      );
    } finally {
      db.close();
    }
  } finally {
    space.dispose();
  }
});
