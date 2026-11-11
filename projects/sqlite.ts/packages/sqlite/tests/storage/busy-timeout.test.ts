// `busyTimeoutMs` 合同：默认 0、正数等待、非法值拒绝，以及真实跨进程争用。
//
// 争用由 `node:child_process` 起的持锁子进程制造：它在另一进程里持有同一文件的
// 写连接，父进程只能用上游的跨进程写锁与超时来观察 `busy`。这里没有进程内
// mutex 替身。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SQLite, SQLiteError } from "../../src/index.ts";

const holderPath = fileURLToPath(new URL("./lock-holder.mjs", import.meta.url));

function tempDir(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-busy-"));
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

interface Holder {
  child: ChildProcess;
  ready: Promise<void>;
  stderr: () => string;
  exited: Promise<number | null>;
}

/** 起一个子进程，等它拿到写锁并写完一行后返回。 */
function startHolder(filename: string): Holder {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", holderPath, filename], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ready")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited before ready (${code}): ${stderr}`)));
  });
  return { child, ready, stderr: () => stderr, exited };
}

test("busyTimeoutMs defaults to 0: a second writer is rejected at once", () => {
  const space = tempDir();
  try {
    const first = new SQLite({ filename: space.path });
    first.exec("create table t (id integer primary key)");
    const started = performance.now();
    const error = expectCode("busy", () => new SQLite({ filename: space.path }));
    const elapsed = performance.now() - started;
    assert.match(error.message, /SQLITE_BUSY/);
    assert.ok(elapsed < 500, `a zero timeout must not wait, waited ${elapsed}ms`);
    first.close();
  } finally {
    space.dispose();
  }
});

test("busyTimeoutMs waits the configured milliseconds before rejecting", () => {
  const space = tempDir();
  try {
    const first = new SQLite({ filename: space.path });
    first.exec("create table t (id integer primary key)");
    const started = performance.now();
    const error = expectCode("busy", () => new SQLite({ filename: space.path, busyTimeoutMs: 100 }));
    const elapsed = performance.now() - started;
    assert.match(error.message, /SQLITE_BUSY/);
    assert.ok(elapsed >= 80, `the timeout must be honoured, waited ${elapsed}ms`);
    assert.ok(elapsed < 5000, `the timeout must not overrun, waited ${elapsed}ms`);
    first.close();
    // 锁释放后同一个正数超时值正常打开。
    const reopened = new SQLite({ filename: space.path, busyTimeoutMs: 100 });
    assert.equal(reopened.prepare("select count(*) from t").pluck<bigint>().get(), 0n);
    reopened.close();
  } finally {
    space.dispose();
  }
});

test("busyTimeoutMs rejects negative, fractional and non-numeric values", () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number]) {
    expectCode("option-invalid", () => new SQLite({ busyTimeoutMs: value }));
  }
});

test("a writer in another process holds the lock: busy after the timeout, then reopen succeeds", async () => {
  const space = tempDir();
  let holder: Holder | undefined;
  try {
    holder = startHolder(space.path);
    await holder.ready;

    const started = performance.now();
    const error = expectCode("busy", () => new SQLite({ filename: space.path, busyTimeoutMs: 100 }));
    const elapsed = performance.now() - started;
    assert.match(error.message, /SQLITE_BUSY/);
    assert.ok(elapsed >= 80, `the timeout must be honoured across processes, waited ${elapsed}ms`);
    assert.ok(elapsed < 5000, `the timeout must not overrun, waited ${elapsed}ms`);

    holder.child.stdin?.write("stop\n");
    assert.equal(await holder.exited, 0, holder.stderr());
    holder = undefined;

    const reopened = new SQLite({ filename: space.path, busyTimeoutMs: 100 });
    assert.equal(reopened.prepare("select count(*) from held").pluck<bigint>().get(), 1n);
    assert.equal(reopened.prepare("select label from held").pluck<string>().get(), "held");
    reopened.close();
  } finally {
    if (holder) {
      holder.child.kill();
      await holder.exited;
    }
    space.dispose();
  }
});
