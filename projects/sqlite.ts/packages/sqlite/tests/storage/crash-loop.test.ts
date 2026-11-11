// 崩溃循环：子进程反复「BEGIN + 多行写入 + COMMIT」，在一个固定点位被
// SIGKILL 强杀，父进程重开同一文件断言只有完整提交可见。
//
// 固定点位：子进程先提交一整批（提交点可复现），再开下一个事务写入同样
// 行数后打印 `armed` 并挂起；父进程在收到 `armed` 后立刻强杀。因此每轮的
// 崩溃点总是 “第 N 批已提交、第 N+1 批未提交”，失败时能直接复现。
//
// 每轮断言：
//   1. 可见行数恰好是批大小的整数倍，id 连续，v = id * 7；
//   2. 本实现与外部的 `better-sqlite3` 都能通过 `integrity_check`；
//   3. 若崩溃留下了热 journal，重开后必须回滚到已提交镜像并清理日志。
//
// 此外每轮固定抽查一次 “已发布、未清日志” 的崩溃窗口：用上一版已提交
// 镜像写出真实格式的热 journal，再提交一批，重开必须回滚掉这一批。
// `delete` 与 `truncate` 各 20 轮，使用固定种子。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SQLite } from "../../src/index.ts";
import { writeHotJournal } from "./journal-fixture.ts";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): { get(): unknown };
  close(): void;
};

const writerPath = fileURLToPath(new URL("./crash-writer.mjs", import.meta.url));
const ROUNDS = 20;
const BATCH = 16;
const MODES = ["delete", "truncate"] as const;
type Mode = (typeof MODES)[number];

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-crash-${label}-`));
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
  child: ChildProcess;
  armed: Promise<number>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
}

/** 起一个写入子进程，返回 `armed` 行号（未提交批次的首行）。 */
function startCrashWriter(filename: string, mode: Mode, committedBatches: number, startId: number): Child {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      writerPath,
      filename,
      mode,
      "arm",
      String(committedBatches),
      String(startId),
      String(BATCH),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const armed = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`crash writer did not arm: ${stderr}`)), 30_000);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /armed (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`crash writer exited before arming (${code}): ${stderr}`));
    });
  });
  return { child, armed, exited, stderr: () => stderr };
}

async function runCommitter(filename: string, mode: Mode, batches: number, startId: number): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      writerPath,
      filename,
      mode,
      "commit",
      String(batches),
      String(startId),
      String(BATCH),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const code = await result;
  assert.equal(code, 0, `committer failed (${code}): ${stderr}`);
}

/** 重开文件并断言可见镜像恰好是 `expectedRows` 行完整提交。 */
function assertCommittedImage(path: string, expectedRows: number, label: string): void {
  const reader = new SQLite({ filename: path, readOnly: true });
  try {
    const rows = reader.all<{ id: bigint; v: bigint; label: string }>("select id, v, label from crashes order by id");
    assert.equal(rows.length, expectedRows, `${label}: visible rows`);
    assert.equal(rows.length % BATCH, 0, `${label}: rows must be a whole number of batches`);
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
    const counted = oracle.prepare("select count(*) as c from crashes").get() as { c: number };
    assert.equal(Number(counted.c), expectedRows, `${label}: better-sqlite3 row count`);
  } finally {
    oracle.close();
  }
}

function journalState(path: string): "absent" | "empty" | "hot" {
  const journalPath = `${path}-journal`;
  if (!existsSync(journalPath)) return "absent";
  return statSync(journalPath).size === 0 ? "empty" : "hot";
}

for (const mode of MODES) {
  test(`crash loop keeps only complete commits (${mode}, ${ROUNDS} rounds)`, { timeout: 240_000 }, async (t) => {
    const space = workspace(mode);
    try {
      const seed = new SQLite({ filename: space.path, journalMode: mode });
      seed.exec("create table crashes (id integer primary key, v integer not null, label text not null)");
      seed.close();
      assertCommittedImage(space.path, 0, "empty seed");

      let committedBatches = 0;
      let hotJournals = 0;
      let replayedJournals = 0;
      const states = new Set<string>();

      for (let round = 1; round <= ROUNDS; round += 1) {
        const startId = committedBatches * BATCH + 1;
        const writer = startCrashWriter(space.path, mode, 1, startId);
        try {
          const armedId = await writer.armed;
          assert.equal(armedId, startId + BATCH, `round ${round}: the staged batch starts after the commit`);
          // 固定点位：上一个事务已提交，当前事务已写入但未提交。
          writer.child.kill("SIGKILL");
        } finally {
          const exit = await writer.exited;
          assert.ok(exit.code !== 0 || exit.signal === "SIGKILL", `round ${round}: the writer must be killed hard`);
        }

        committedBatches += 1;
        const expected = committedBatches * BATCH;

        // 崩溃留下的热日志（若存在）必须在重开时回滚，而不是被当成已提交。
        const state = journalState(space.path);
        states.add(state);
        if (state === "hot") {
          hotJournals += 1;
          const journalPath = `${space.path}-journal`;
          const hotBytes = readFileSync(journalPath);
          const leftover = new SQLite({ filename: space.path, readOnly: true });
          try {
            assert.equal(leftover.pragma("integrity_check", { scalar: true }), "ok", `round ${round}: hot journal image`);
            const rows = leftover.all<{ id: bigint }>("select id from crashes order by id");
            assert.equal(rows.length % BATCH, 0, `round ${round}: a hot journal must not expose a partial batch`);
            assert.ok(rows.length <= expected, `round ${round}: a hot journal cannot hide committed rows`);
          } finally {
            leftover.close();
          }
          assert.ok(hotBytes.length > 0, `round ${round}: hot journal is non-empty`);
        }

        assertCommittedImage(space.path, expected, `round ${round} after kill`);

        if (round === 1 || round === ROUNDS) {
          // “已发布、未清日志” 的崩溃窗口：主文件已是新镜像，日志仍保存旧页。
          const before = readFileSync(space.path);
          await runCommitter(space.path, mode, 1, committedBatches * BATCH + 1);
          const published = new SQLite({ filename: space.path, readOnly: true });
          const publishedRows = published.all<{ id: bigint }>("select id from crashes order by id").length;
          published.close();
          assert.equal(publishedRows, expected + BATCH, `round ${round}: the extra batch is published`);

          writeHotJournal(space.path, before);
          assert.equal(journalState(space.path), "hot", `round ${round}: the journal must be hot before recovery`);
          replayedJournals += 1;

          const recovered = new SQLite({ filename: space.path, journalMode: mode });
          recovered.close();
          assertCommittedImage(space.path, expected, `round ${round} after hot journal recovery`);
          assert.equal(
            journalState(space.path),
            mode === "delete" ? "absent" : "empty",
            `round ${round}: recovery cleans the journal (${mode})`,
          );
          assert.deepEqual(readFileSync(space.path), before, `round ${round}: recovery restores the old image`);
        }
      }

      t.diagnostic(
        `${mode}: ${ROUNDS} hard kills, ${committedBatches * BATCH} committed rows, ` +
          `journal states after kill ${JSON.stringify([...states])}, ` +
          `hot journals observed ${hotJournals}, published-then-crashed windows replayed ${replayedJournals}`,
      );
    } finally {
      space.dispose();
    }
  });
}
