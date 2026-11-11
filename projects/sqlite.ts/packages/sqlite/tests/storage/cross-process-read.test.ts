// 跨进程读写一致性：一个子进程持续提交小批量事务，父进程在它运行期间
// 反复按路径重新打开同一文件读取。
//
// 写入侧每次提交发布完整镜像（临时文件 + 原子改名），所以父进程读到的
// 必须始终是某个已提交前缀：行数等于批大小的整数倍、id 从 1 连续、v 列
// 等于 id * 7。出现半镜像、缺行或错行都直接失败。写入方退出后再用本实现
// 与外部 `better-sqlite3` 各做一次 `integrity_check`。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SQLite } from "../../src/index.ts";

const writerPath = fileURLToPath(new URL("./mirror-writer.mjs", import.meta.url));
const BATCHES = 60;
const BATCH_SIZE = 50;
const TOTAL = BATCHES * BATCH_SIZE;

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): { get(...args: unknown[]): unknown };
  close(): void;
};

function tempDir(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-mirror-"));
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

interface WriterProcess {
  child: ChildProcess;
  ready: Promise<void>;
  exited: Promise<number | null>;
  stderr: () => string;
}

function startWriter(filename: string): WriterProcess {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", writerPath, filename, String(BATCHES), String(BATCH_SIZE)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mirror writer not ready: ${stderr}`)), 30_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ready\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mirror writer exited before ready (${code}): ${stderr}`));
    });
  });
  return { child, ready, exited, stderr: () => stderr };
}

function assertComplete(image: { id: bigint; v: bigint }[], label: string): void {
  assert.equal(image.length % BATCH_SIZE, 0, `${label}: ${image.length} rows is not a whole batch`);
  for (let index = 0; index < image.length; index += 1) {
    if (image[index]!.id !== BigInt(index + 1) || image[index]!.v !== BigInt((index + 1) * 7)) {
      assert.fail(`${label}: broken image at row ${index}: ${JSON.stringify(image[index], (_key, value) => (typeof value === "bigint" ? value.toString() : value))}`);
    }
  }
}

test("readers only see complete committed images while another process writes", { timeout: 120_000 }, async (t) => {
  const space = tempDir();
  let writer: WriterProcess | undefined;
  try {
    writer = startWriter(space.path);
    await writer.ready;

    let exited = false;
    const exit = writer.exited.then((code) => {
      exited = true;
      return code;
    });

    const observed: number[] = [];
    while (!exited) {
      const reader = new SQLite({ filename: space.path, readOnly: true });
      try {
        const rows = reader.all<{ id: bigint; v: bigint }>("select id, v from mirror order by id");
        assertComplete(rows, `live read #${observed.length}`);
        observed.push(rows.length);
      } finally {
        reader.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    assert.equal(await exit, 0, writer.stderr());
    assert.ok(observed.length > 0, "the reader must run at least once while the writer is alive");
    assert.ok(
      observed.some((count) => count > BATCH_SIZE && count < TOTAL),
      `live reads must include an in-progress image, saw ${JSON.stringify([...new Set(observed)])}`,
    );

    // 写入方已退出：最后一版镜像必须完整，并且两边引擎都能通过完整性检查。
    const verifier = new SQLite({ filename: space.path, readOnly: true });
    try {
      const rows = verifier.all<{ id: bigint; v: bigint }>("select id, v from mirror order by id");
      assert.equal(rows.length, TOTAL);
      assertComplete(rows, "final image");
      assert.equal(verifier.pragma("integrity_check", { scalar: true }), "ok");
    } finally {
      verifier.close();
    }

    const oracle = new BetterSqlite(space.path);
    try {
      assert.equal(oracle.pragma("integrity_check", { simple: true }), "ok");
      const counted = oracle.prepare("select count(*) as c from mirror").get() as { c: number };
      assert.equal(Number(counted.c), TOTAL);
    } finally {
      oracle.close();
    }

    t.diagnostic(
      `live reads: ${observed.length}, distinct images: ${new Set(observed).size}, final: ${TOTAL} rows, integrity: ok`,
    );
  } finally {
    if (writer && writer.child.exitCode === null) {
      writer.child.kill();
      await writer.exited;
    }
    space.dispose();
  }
});
