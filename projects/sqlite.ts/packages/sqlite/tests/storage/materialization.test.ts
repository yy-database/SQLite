// 大结果集内存对比：`all()` 与窗口化 `iterate()` 在 50,000 行上的 RSS 增量。
//
// `iterate()` 通过连接内游标按 256 行窗口取行，JS 侧不再一次构造全部行对象；
// 但 Rust 侧打开游标时仍物化完整行集（引擎没有逐行执行接口），所以这不是
// 端到端流式执行，内存收益只来自 JS 侧的行对象与结果数组。
//
// 两种模式各跑在独立子进程里，避免前一次测量的 RSS 高水位污染后一次基线。
// RSS 是进程级高水位指标，这里只如实报告测量值，不设绝对上限。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWriter, writeSlots } from "../../src/index.ts";

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

interface Measurement {
  rows: number;
  ms: number;
  rss: number;
  after: number;
}

/** 在独立进程里运行一种读取方式，返回行数、耗时与 RSS 增量。 */
function measure(mode: "all" | "iterate", filename: string): Measurement {
  const entry = new URL("../../src/index.ts", import.meta.url).href;
  const script = `
const { SQLite } = await import(process.env.SQLITE_ENTRY);
const db = new SQLite({ filename: process.env.SQLITE_DB, readOnly: true });
const sql = "select id, label from big order by id";
const before = process.memoryUsage().rss;
const started = performance.now();
let count = 0;
let rows;
if (process.env.SQLITE_MODE === "all") {
  rows = db.all(sql);
  count = rows.length;
} else {
  for (const row of db.iterate(sql)) {
    count += 1;
    if (count === 1 && (row.id !== 1n || row.label !== "row-1")) throw new Error("bad first row");
    if (row.id !== BigInt(count) || row.label !== "row-" + count) throw new Error("bad row " + count);
  }
}
const ms = performance.now() - started;
const after = process.memoryUsage().rss;
if (rows !== undefined && rows.length !== count) throw new Error("row count drift");
db.close();
console.log(JSON.stringify({ rows: count, ms, rss: after - before, after }));
`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, SQLITE_ENTRY: entry, SQLITE_DB: filename, SQLITE_MODE: mode },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${mode} child failed: ${result.stderr}`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, `${mode} child produced no measurement`);
  return JSON.parse(line) as Measurement;
}

test("windowed iterate and all() RSS deltas over 50,000 rows", { timeout: 180_000 }, (t) => {
  const space = workspace("materialize");
  try {
    seed(space.path);
    const all = measure("all", space.path);
    const iterate = measure("iterate", space.path);
    assert.equal(all.rows, ROWS);
    assert.equal(iterate.rows, ROWS);

    t.diagnostic(
      `all: rows=${all.rows} ${all.ms.toFixed(1)}ms rss +${(all.rss / 1048576).toFixed(1)}MiB (after ${(all.after / 1048576).toFixed(1)}MiB)`,
    );
    t.diagnostic(
      `iterate(256-row windows): rows=${iterate.rows} ${iterate.ms.toFixed(1)}ms ` +
        `rss +${(iterate.rss / 1048576).toFixed(1)}MiB (after ${(iterate.after / 1048576).toFixed(1)}MiB)`,
    );
  } finally {
    space.dispose();
  }
});
