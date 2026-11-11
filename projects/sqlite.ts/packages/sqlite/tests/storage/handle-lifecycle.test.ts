// 连接生命周期：未显式 `close()` 的句柄在被回收时兜底释放 `<db>.lock`，
// 显式关闭后不再重复释放，关闭后的 API 仍以 `db-closed` 拒绝。
//
// GC 由 `global.gc()` 触发；测试进程没有带 `--expose-gc` 时，用
// `v8.setFlagsFromString` 在运行时暴露同一个入口。回收与终结器回调都是
// 异步的，所以每次强制 GC 之间都让出一个宏任务，再轮询 WeakRef 与锁。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import v8 from "node:v8";
import vm from "node:vm";

import { SQLite, SQLiteError } from "../../src/index.ts";

let collect: (() => void) | undefined;

function forceGC(): void {
  if (collect === undefined) {
    const exposed = (globalThis as { gc?: () => void }).gc;
    if (exposed !== undefined) {
      collect = exposed;
    } else {
      v8.setFlagsFromString("--expose-gc");
      collect = vm.runInNewContext("gc") as () => void;
    }
  }
  collect();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 反复强制 GC 并让出事件循环，直到 `done()` 成立。 */
async function gcUntil(done: () => boolean, attempts = 100): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    forceGC();
    await tick();
    if (done()) return true;
    // `deref()` 会把目标保活到当前 job 结束，下一次 GC 必须换一个 job。
    await tick();
  }
  return done();
}

function tempDir(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-lifecycle-"));
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

function expectCode(code: string, run: () => unknown): SQLiteError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SQLiteError, `expected SQLiteError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}: ${error.message}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected SQLiteError with code ${code}` });
}

/** 打开一个写连接后不保留强引用，只返回 WeakRef。 */
function openAndForget(path: string): WeakRef<SQLite> {
  const db = new SQLite({ filename: path });
  db.exec("create table leaked (id integer primary key)");
  return new WeakRef(db);
}

/** 轮询直到第二个写连接能以默认零超时打开，返回等待毫秒数。 */
async function waitForLockRelease(path: string, timeoutMs = 15_000): Promise<number> {
  const started = performance.now();
  let last: unknown;
  while (performance.now() - started < timeoutMs) {
    try {
      const probe = new SQLite({ filename: path });
      probe.close();
      return Math.round(performance.now() - started);
    } catch (error) {
      last = error;
      assert.ok(error instanceof SQLiteError && error.code === "busy", `unexpected open failure: ${error}`);
    }
    // 这里刻意不再强制 GC：锁必须由已注册的终结器释放，而不是等原生析构。
    await tick();
  }
  throw new Error(`write lock was not released within ${timeoutMs}ms: ${String(last)}`);
}

test("an unreferenced unclosed handle releases the write lock at GC", { timeout: 60_000 }, async () => {
  const space = tempDir();
  try {
    const leaked = openAndForget(space.path);
    // 句柄仍存活时锁被占用。
    expectCode("busy", () => new SQLite({ filename: space.path }));

    const collected = await gcUntil(() => leaked.deref() === undefined);
    assert.ok(collected, "the unreferenced instance must be collected");

    const waited = await waitForLockRelease(space.path);
    assert.ok(waited < 1_000, `the finalizer must release the lock promptly, waited ${waited}ms`);

    const reopened = new SQLite({ filename: space.path });
    assert.equal(reopened.prepare("select count(*) from leaked").pluck<bigint>().get(), 0n);
    reopened.close();
  } finally {
    space.dispose();
  }
});

test("an explicit close unregisters the finalizer and stays idempotent under GC", { timeout: 60_000 }, async () => {
  const space = tempDir();
  try {
    let db: SQLite | undefined = new SQLite({ filename: space.path });
    db.exec("create table t (id integer primary key)");
    const ref = new WeakRef(db);

    db.close();
    db.close();
    expectCode("db-closed", () => db!.exec("select 1"));
    db = undefined;

    const collected = await gcUntil(() => ref.deref() === undefined);
    assert.ok(collected, "the closed instance must be collectable");

    const reopened = new SQLite({ filename: space.path });
    reopened.close();
  } finally {
    space.dispose();
  }
});

test("a reachable instance is not finalized and reports db-closed after close", { timeout: 60_000 }, async () => {
  const space = tempDir();
  try {
    const db = new SQLite({ filename: space.path });
    db.exec("create table t (id integer primary key)");
    const ref = new WeakRef(db);

    forceGC();
    await tick();
    forceGC();
    await tick();
    assert.notEqual(ref.deref(), undefined, "a reachable instance must not be collected");
    assert.equal(db.isOpen, true);
    assert.equal(db.prepare("select count(*) from t").pluck<bigint>().get(), 0n);

    db.close();
    expectCode("db-closed", () => db.exec("select 1"));
    expectCode("db-closed", () => db.prepare("select 1"));
    expectCode("db-closed", () => db.filename);
    assert.equal(db.isOpen, false);

    const reopened = new SQLite({ filename: space.path });
    reopened.close();
  } finally {
    space.dispose();
  }
});
