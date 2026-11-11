// `journalMode` 合同：选项校验、delete / truncate 的 sidecar 生命周期，
// 以及热 rollback journal 在重开时把已发布镜像回滚到旧镜像。
//
// 崩溃点用真实格式的 hot journal sidecar 构造：主文件已经是新镜像，
// `<db>-journal` 仍保存旧页，等价于上游 “发布后、清理日志前崩溃” 的失败点。
// 这里没有在 JS 里模拟回滚语义，回放仍由 Rust facade 完成。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLite, SQLiteError } from "../../src/index.ts";

const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const JOURNAL_SECTOR_BYTES = 512;

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-journal-${label}-`));
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

function pageSizeOf(image: Buffer): number {
  const raw = image.readUInt16BE(16);
  return raw === 1 ? 65_536 : raw;
}

/** SQLite rollback-journal record checksum, matching the facade writer. */
function recordChecksum(page: Buffer, seed: number): number {
  let checksum = seed >>> 0;
  let index = page.length - 200;
  while (index > 0) {
    checksum = (checksum + page[index]!) >>> 0;
    index -= 200;
  }
  return checksum;
}

/** Writes a hot rollback journal that restores `image` over the main file. */
function writeHotJournal(path: string, image: Buffer): string {
  const pageSize = pageSizeOf(image);
  const pages = image.length / pageSize;
  assert.ok(Number.isInteger(pages) && pages > 0, "the image must be a whole number of pages");
  const seed = 0x9e37_79b1;
  const recordBytes = 4 + pageSize + 4;
  const journal = Buffer.alloc(JOURNAL_SECTOR_BYTES + pages * recordBytes);
  for (let index = 0; index < pages; index += 1) {
    const offset = JOURNAL_SECTOR_BYTES + index * recordBytes;
    const page = image.subarray(index * pageSize, (index + 1) * pageSize);
    journal.writeUInt32BE(index + 1, offset);
    page.copy(journal, offset + 4);
    journal.writeUInt32BE(recordChecksum(page, seed), offset + 4 + pageSize);
  }
  JOURNAL_MAGIC.copy(journal, 0);
  journal.writeUInt32BE(pages, 8);
  journal.writeUInt32BE(seed, 12);
  journal.writeUInt32BE(pages, 16);
  journal.writeUInt32BE(JOURNAL_SECTOR_BYTES, 20);
  journal.writeUInt32BE(pageSize, 24);
  const journalPath = `${path}-journal`;
  writeFileSync(journalPath, journal);
  return journalPath;
}

test("journalMode accepts preserve, delete and truncate", () => {
  for (const journalMode of ["preserve", "delete", "truncate"] as const) {
    const space = workspace(`option-${journalMode}`);
    try {
      const db = new SQLite({ filename: space.path, journalMode });
      db.exec("create table t (id integer primary key)");
      db.close();
    } finally {
      space.dispose();
    }
  }
});

test("journalMode rejects wal as unsupported and unknown values as option-invalid", () => {
  expectCode("unsupported", () => new SQLite({ journalMode: "wal" }));
  for (const journalMode of ["off", "memory", "banana", ""]) {
    expectCode("option-invalid", () => new SQLite({ journalMode: journalMode as unknown as "preserve" }));
  }
});

test("the default mode is preserve: a commit leaves no journal sidecar", () => {
  const space = workspace("default");
  try {
    const db = new SQLite({ filename: space.path });
    db.exec("create table t (id integer primary key, label text)");
    db.run("insert into t (label) values (?)", ["kept"]);
    assert.equal(existsSync(`${space.path}-journal`), false);
    db.close();
    const reopened = new SQLite({ filename: space.path });
    assert.equal(reopened.prepare("select count(*) from t").pluck<bigint>().get(), 1n);
    reopened.close();
  } finally {
    space.dispose();
  }
});

test("delete mode removes the journal after every commit", () => {
  const space = workspace("delete");
  try {
    const db = new SQLite({ filename: space.path, journalMode: "delete" });
    db.exec("create table t (id integer primary key, label text)");
    assert.equal(existsSync(`${space.path}-journal`), false, "create leaves no journal");
    db.run("insert into t (label) values (?)", ["kept"]);
    assert.equal(existsSync(`${space.path}-journal`), false, "insert leaves no journal");
    assert.equal(db.prepare("select label from t").pluck<string>().get(), "kept");
    db.close();
  } finally {
    space.dispose();
  }
});

test("truncate mode keeps a zero-byte journal after every commit", () => {
  const space = workspace("truncate");
  try {
    const db = new SQLite({ filename: space.path, journalMode: "truncate" });
    db.exec("create table t (id integer primary key, label text)");
    assert.equal(existsSync(`${space.path}-journal`), true, "create keeps the sidecar");
    assert.equal(statSync(`${space.path}-journal`).size, 0);
    db.run("insert into t (label) values (?)", ["kept"]);
    assert.equal(existsSync(`${space.path}-journal`), true, "insert keeps the sidecar");
    assert.equal(statSync(`${space.path}-journal`).size, 0);
    db.close();
  } finally {
    space.dispose();
  }
});

for (const journalMode of ["delete", "truncate"] as const) {
  test(`a hot journal rolls a published commit back on reopen (${journalMode})`, () => {
    const space = workspace(`recovery-${journalMode}`);
    try {
      const seed = new SQLite({ filename: space.path });
      seed.exec("create table t (id integer primary key, label text)");
      seed.run("insert into t (label) values (?)", ["one"]);
      seed.close();
      const before = readFileSync(space.path);

      // Publish a newer main-file image without touching the journal.
      const newer = new SQLite({ filename: space.path });
      newer.run("insert into t (label) values (?)", ["two"]);
      newer.close();
      assert.notDeepEqual(readFileSync(space.path), before, "the main file really moved forward");

      const journalPath = writeHotJournal(space.path, before);
      const recovered = new SQLite({ filename: space.path, journalMode });
      assert.equal(recovered.prepare("select count(*) from t").pluck<bigint>().get(), 1n);
      assert.equal(recovered.prepare("select label from t").pluck<string>().get(), "one");
      recovered.close();

      assert.deepEqual(readFileSync(space.path), before, "recovery restores the old image on disk");
      if (journalMode === "delete") {
        assert.equal(existsSync(journalPath), false, "delete recovery removes the journal");
      } else {
        assert.equal(statSync(journalPath).size, 0, "truncate recovery empties the journal");
      }
    } finally {
      space.dispose();
    }
  });
}
