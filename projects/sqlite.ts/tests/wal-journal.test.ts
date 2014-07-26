import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../packages/sqlite/src/index.ts";

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(): unknown[] };
  close(): void;
};

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows 仍持有句柄时忽略清理失败，临时目录随系统回收。
      }
    },
  };
}

test("committed WAL frames are visible without a checkpoint", () => {
  const space = workspace("wal");
  try {
    const oracle = new BetterSqlite(space.path);
    oracle.pragma("journal_mode = WAL");
    oracle.exec("create table w (id integer primary key, label text)");
    for (let index = 1; index <= 5; index += 1) {
      oracle.prepare("insert into w (label) values (?)").run(`w-${index}`);
    }
    const walPath = `${space.path}-wal`;
    assert.equal(existsSync(walPath), true);
    assert.ok(statSync(walPath).size > 32);

    const reader = openDatabase(space.path);
    const rows = reader.table("w");
    assert.equal(rows.length, 5);
    assert.equal(rows[4].rowid, 5n);

    const live = oracle.prepare("select count(*) c from w").get() as { c: number };
    assert.equal(live.c, 5);
    oracle.close();
  } finally {
    space.dispose();
  }
});

test("hot rollback journal rolls partially written pages back", () => {
  const space = workspace("journal");
  try {
    const seed = new BetterSqlite(space.path);
    seed.pragma("journal_mode = delete");
    seed.exec("create table j (id integer primary key, label text)");
    seed.prepare("insert into j (label) values (?)").run("committed-one");
    seed.prepare("insert into j (label) values (?)").run("committed-two");
    seed.close();

    const child = `
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(space.path)});
      db.pragma("journal_mode = delete");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("insert into j (label) values (?)").run("uncommitted");
      process.kill(process.pid, "SIGKILL");
    `;
    const result = spawnSync(process.execPath, ["-e", child], {
      cwd: join(import.meta.dirname, ".."),
      stdio: "ignore",
    });
    // Windows 的 `spawnSync` 不填 `signal`，被强杀的子进程以非零退出码呈现。
    assert.ok(result.signal !== null || (result.status ?? 0) !== 0);
    assert.equal(existsSync(`${space.path}-journal`), true);
    assert.ok(statSync(`${space.path}-journal`).size >= 512);

    const reader = openDatabase(space.path);
    const rows = reader.table("j");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.columns[1].valueText),
      ["committed-one", "committed-two"],
    );

    const oracle = new BetterSqlite(space.path);
    const state = oracle.prepare("select count(*) c from j").get() as { c: number };
    const integrity = oracle.pragma("integrity_check") as { integrity_check: string }[];
    oracle.close();
    assert.equal(state.c, 2);
    assert.equal(integrity[0].integrity_check, "ok");
  } finally {
    space.dispose();
  }
});
