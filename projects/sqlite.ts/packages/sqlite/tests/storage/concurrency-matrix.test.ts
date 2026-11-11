// 并发矩阵：1 个写者持续提交小批量事务，N 个读者同时按路径重开只读连接。
//
// 读者只能看到完整提交镜像（行数是批大小的整数倍、id 连续、v = id * 7）；
// 每读一次都重新打开文件，因此读到的是某个已发布版本，而不是打开时的旧快照。
// 写者存活期间，父进程再用 `busyTimeoutMs` 打开第二个写连接：必须等在配置的
// 毫秒数后以 `busy` 拒绝，并且文件在此期间仍能通过完整性检查。
// 写者释放锁后，同一个超时值必须能正常打开并写入。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SQLite, SQLiteError } from "../../src/index.ts";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): { get(): unknown; raw(): { all(): unknown[][] } };
  close(): void;
};

const writerPath = fileURLToPath(new URL("./concurrency-writer.mjs", import.meta.url));
const readerPath = fileURLToPath(new URL("./concurrency-reader.mjs", import.meta.url));
const BATCHES = 120;
const BATCH = 16;
const TOTAL = BATCHES * BATCH;
const READERS = 3;

function workspace(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-concurrency-"));
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

interface Child {
  process: ChildProcess;
  stderr: () => string;
  stdout: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor(line: string): Promise<void>;
  stop(): void;
}

function startChild(script: string, args: string[]): Child {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const waitFor = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never printed ${JSON.stringify(line)}: ${stderr}`)), 60_000);
      const check = (): void => {
        if (stdout.includes(line)) {
          clearTimeout(timer);
          child.stdout?.off("data", check);
          resolve();
        }
      };
      child.stdout?.on("data", check);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited before ${JSON.stringify(line)} (${code}): ${stderr}`));
      });
      check();
    });
  return {
    process: child,
    stderr: () => stderr,
    stdout: () => stdout,
    exited,
    waitFor,
    stop: () => child.stdin?.write("stop\n"),
  };
}

function assertCompleteImage(path: string, expected: number, label: string): void {
  const reader = new SQLite({ filename: path, readOnly: true });
  let visible = 0;
  try {
    const rows = reader.all<{ id: bigint; v: bigint; label: string }>("select id, v, label from mirror order by id");
    visible = rows.length;
    assert.equal(rows.length, expected, `${label}: visible rows`);
    for (let index = 0; index < rows.length; index += 1) {
      const id = index + 1;
      assert.equal(rows[index]!.id, BigInt(id), `${label}: id at row ${index}`);
      assert.equal(rows[index]!.v, BigInt(id * 7), `${label}: v at row ${index}`);
      assert.equal(rows[index]!.label, `row-${id}`, `${label}: label at row ${index}`);
    }
    assert.equal(reader.pragma("integrity_check", { scalar: true }), "ok", `${label}: our integrity_check`);
  } finally {
    reader.close();
  }
  const oracle = new BetterSqlite(path);
  try {
    assert.equal(oracle.pragma("integrity_check", { simple: true }), "ok", `${label}: better-sqlite3 integrity_check`);
    const counted = oracle.prepare("select count(*) as c from mirror").get() as { c: number };
    assert.equal(Number(counted.c), expected, `${label}: better-sqlite3 row count`);
  } finally {
    oracle.close();
  }
}

/** 写者存活期间：每个引擎各自必须看到某个完整已提交前缀（两者可以不同步）。 */
function assertPrefixImage(path: string, label: string): void {
  const reader = new SQLite({ filename: path, readOnly: true });
  try {
    const rows = reader.all<{ id: bigint; v: bigint; label: string }>("select id, v, label from mirror order by id");
    validatePrefix(rows, label);
    assert.equal(reader.pragma("integrity_check", { scalar: true }), "ok", `${label}: our integrity_check`);
  } finally {
    reader.close();
  }
  const oracle = new BetterSqlite(path);
  try {
    const rows = oracle.prepare("select id, v, label from mirror order by id").raw().all() as Array<[number, number, string]>;
    validatePrefix(
      rows.map(([id, v, label]) => ({ id: BigInt(id), v: BigInt(v), label })),
      `${label} (better-sqlite3)`,
    );
    assert.equal(oracle.pragma("integrity_check", { simple: true }), "ok", `${label}: better-sqlite3 integrity_check`);
  } finally {
    oracle.close();
  }
}

function validatePrefix(rows: Array<{ id: bigint; v: bigint; label: string }>, label: string): void {
  assert.equal(rows.length % BATCH, 0, `${label}: rows must be a whole number of batches, saw ${rows.length}`);
  assert.ok(rows.length >= BATCH && rows.length <= TOTAL, `${label}: rows must stay within the run, saw ${rows.length}`);
  for (let index = 0; index < rows.length; index += 1) {
    const id = index + 1;
    assert.equal(rows[index]!.id, BigInt(id), `${label}: id at row ${index}`);
    assert.equal(rows[index]!.v, BigInt(id * 7), `${label}: v at row ${index}`);
    assert.equal(rows[index]!.label, `row-${id}`, `${label}: label at row ${index}`);
  }
}

test("one writer and three readers keep complete images; a second writer times out busy", { timeout: 240_000 }, async (t) => {
  const space = workspace();
  const children: Child[] = [];
  try {
    const writer = startChild(writerPath, [space.path, String(BATCHES), String(BATCH)]);
    children.push(writer);
    await writer.waitFor("ready\n");

    const readers = Array.from({ length: READERS }, () => startChild(readerPath, [space.path, String(BATCH)]));
    children.push(...readers);
    await Promise.all(readers.map((reader) => reader.waitFor("started\n")));

    // 第二个写者：写锁被占用时只等配置的毫秒数，然后以 busy 拒绝。
    const started = performance.now();
    let busy: unknown;
    try {
      new SQLite({ filename: space.path, busyTimeoutMs: 200 }).close();
    } catch (error) {
      busy = error;
    }
    const elapsed = performance.now() - started;
    assert.ok(busy instanceof SQLiteError, `expected SQLiteError, got ${String(busy)}`);
    assert.equal(busy.code, "busy", busy.message);
    assert.ok(elapsed >= 150, `busyTimeoutMs must wait before rejecting, waited ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `busyTimeoutMs must not overrun, waited ${elapsed}ms`);

    // 拒绝之后文件仍是完整镜像，而不是被第二个写者破坏。
    assertPrefixImage(space.path, "after busy rejection");

    await writer.waitFor("done\n");
    for (const reader of readers) reader.stop();
    const stats = await Promise.all(
      readers.map(async (reader) => {
        const exit = await reader.exited;
        assert.equal(exit.code, 0, reader.stderr());
        const last = reader.stdout().trim().split(/\r?\n/).at(-1) ?? "";
        return JSON.parse(last) as { reads: number; images: number; maxImage: number; inProgress: boolean };
      }),
    );
    assert.ok(
      stats.every((entry) => entry.reads > 0 && entry.inProgress),
      `every reader must read a complete image: ${JSON.stringify(stats)}`,
    );
    assert.ok(
      stats.some((entry) => entry.images >= 2),
      `at least one reader must observe more than one published image: ${JSON.stringify(stats)}`,
    );

    assertCompleteImage(space.path, TOTAL, "final image");

    writer.stop();
    const writerExit = await writer.exited;
    assert.equal(writerExit.code, 0, writer.stderr());

    // 锁释放后，同一个正数超时必须能正常打开并写入。
    const second = new SQLite({ filename: space.path, busyTimeoutMs: 500 });
    try {
      second.run("insert into mirror (id, v, label) values (?, ?, ?)", [BigInt(TOTAL + 1), BigInt((TOTAL + 1) * 7), `row-${TOTAL + 1}`]);
    } finally {
      second.close();
    }
    assertCompleteImage(space.path, TOTAL + 1, "after the lock is released");

    t.diagnostic(
      `readers: ${stats.map((entry) => `${entry.reads} reads/${entry.images} images`).join(", ")}; ` +
        `second writer waited ${elapsed.toFixed(0)}ms then got busy; final ${TOTAL} rows + 1 after release`,
    );
  } finally {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) {
        child.process.kill("SIGKILL");
        await child.exited;
      }
    }
    space.dispose();
  }
});
