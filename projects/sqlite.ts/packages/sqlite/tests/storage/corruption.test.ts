// 损坏文件矩阵：每一个坏文件都必须在有界时间内以结构化 `SQLiteError` 拒绝，
// 不能 panic、挂起，也不能被只读打开悄悄改写。
//
// 基准镜像由外部 `better-sqlite3` 写出，损坏点按 SQLite format-3 布局定点修改：
// 文件头、页号、表/索引 b-tree 页类型、cell 指针与热 `-journal`。
// 同一坏文件交给 `better-sqlite3` 与 CPython `sqlite3` 读取，差异通过
// `t.diagnostic` 记录。本实现比外部引擎更严格的地方（例如打开时就校验索引页
// 类型）如实保留为差异，不把外部结果当成本实现的期望值。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { SQLite, SQLiteError } from "../../src/index.ts";
import { writeHotJournal } from "./journal-fixture.ts";

interface ExternalStatement {
  all(): unknown[];
  get(): unknown;
  run(...args: unknown[]): unknown;
}

interface ExternalDatabase {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): ExternalStatement;
  close(): void;
}

interface SchemaRow {
  type: string;
  name: string;
  rootpage: number;
}

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean },
) => ExternalDatabase;

const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const PAGE_SIZE = 512;
const ROOT = mkdtempSync(join(tmpdir(), "sqlite-corruption-"));
const BASE = join(ROOT, "base.sqlite3");
const INDEXED = join(ROOT, "indexed.sqlite3");
let sequence = 0;

function seedBase(path: string, withIndex: boolean): void {
  const external = new BetterSqlite(path);
  external.pragma("page_size = 512");
  external.exec("create table records (id integer primary key, body text not null)");
  const insert = external.prepare("insert into records (id, body) values (?, ?)");
  external.exec("begin");
  for (let id = 1; id <= 2000; id += 1) insert.run(id, `row-${id}-${"x".repeat(390)}`);
  external.exec("commit");
  if (withIndex) external.exec("create index records_body on records (body)");
  external.close();
}

function readObjects(path: string): SchemaRow[] {
  const external = new BetterSqlite(path, { readonly: true });
  try {
    return external.prepare("select type, name, rootpage from sqlite_master").all() as SchemaRow[];
  } finally {
    external.close();
  }
}

seedBase(BASE, false);
seedBase(INDEXED, true);
const table = readObjects(BASE).find((object) => object.type === "table");
const index = readObjects(INDEXED).find((object) => object.type === "index");
assert.ok(table, "the external base must contain a table");
assert.ok(index, "the external indexed base must contain an index");
// 表与索引分开取基准镜像；「表根损坏 + 同库存在索引」的组合由套件末尾的
// 回归门禁单独覆盖，确保越界 cell 指针以 `corrupt` 拒绝而不是 panic。
const TABLE_ROOT = table.rootpage;
const INDEX_ROOT = index.rootpage;
assert.equal(readFileSync(BASE)[(TABLE_ROOT - 1) * PAGE_SIZE], 0x05, "the table root must be an interior page");
assert.ok(INDEX_ROOT > 1 && INDEX_ROOT <= readFileSync(INDEXED).length / PAGE_SIZE, "the index root must be a real page");

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows 持有句柄时忽略清理失败，临时目录随系统回收。
  }
});

function writeBytes(label: string, bytes: Buffer): string {
  const path = join(ROOT, `${String((sequence += 1)).padStart(2, "0")}-${label}.sqlite3`);
  writeFileSync(path, bytes);
  return path;
}

function mutateBase(label: string, change: (bytes: Buffer) => void, source = BASE): string {
  const bytes = Buffer.from(readFileSync(source));
  change(bytes);
  return writeBytes(label, bytes);
}

/** 结构化拒绝：必须是 `SQLiteError`，而不是绑定层的泛化 `engine`。 */
function structured(error: unknown, context: string): SQLiteError {
  assert.ok(error instanceof SQLiteError, `${context}: expected SQLiteError, got ${String(error)}`);
  assert.notEqual(error.code, "engine", `${context}: a structured native rejection must not become the generic engine code`);
  return error;
}

function openError(path: string): SQLiteError {
  try {
    new SQLite({ filename: path, readOnly: true });
  } catch (error) {
    return structured(error, "open");
  }
  assert.fail(`expected a structured rejection opening ${path}`);
}

function readError(path: string, sql: string): SQLiteError {
  const db = new SQLite({ filename: path, readOnly: true });
  try {
    db.all(sql);
  } catch (error) {
    return structured(error, sql);
  } finally {
    db.close();
  }
  assert.fail(`expected a structured rejection executing ${sql} against ${path}`);
}

/** 打开与读取任一侧的拒绝都要校验：索引页在打开阶段校验，表页在扫描阶段校验。 */
function openOrReadError(path: string, sql: string): SQLiteError {
  let db: SQLite;
  try {
    db = new SQLite({ filename: path, readOnly: true });
  } catch (error) {
    return structured(error, "open");
  }
  try {
    db.all(sql);
  } catch (error) {
    return structured(error, sql);
  } finally {
    db.close();
  }
  assert.fail(`expected a structured rejection opening or reading ${path}`);
}

function externalOutcome(path: string, sql: string): string {
  try {
    const external = new BetterSqlite(path, { readonly: true });
    try {
      const row = external.prepare(sql).get() as Record<string, unknown>;
      return `ok:${String(Object.values(row)[0])}`;
    } finally {
      external.close();
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    return `error:${code ?? (error as Error).name}`;
  }
}

const PYTHON_PROBE = [
  "import pathlib, sqlite3, sys",
  "uri = pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro'",
  "try:",
  "    connection = sqlite3.connect(uri, uri=True)",
  "    try:",
  "        print('ok:' + str(connection.execute(sys.argv[2]).fetchone()[0]))",
  "    finally:",
  "        connection.close()",
  "except Exception as error:",
  "    print('error:' + type(error).__name__ + ':' + str(error))",
].join("\n");

function pythonOutcome(path: string, sql: string): string {
  const result = spawnSync(PYTHON, ["-c", PYTHON_PROBE, path, sql], { encoding: "utf8", timeout: 30_000 });
  if (result.error) return `unavailable:${result.error.message}`;
  const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").filter((line) => line.length > 0);
  return lines.at(-1) ?? "no output";
}

function reference(path: string, sql: string): string {
  return `better-sqlite3 ${externalOutcome(path, sql)}; CPython ${pythonOutcome(path, sql)}`;
}

function ids(db: SQLite): number[] {
  return db.all<{ id: bigint }>("select id from t order by id").map((row) => Number(row.id));
}

function expectCode(code: string, run: () => unknown): SQLiteError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SQLiteError, `expected SQLiteError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected SQLiteError with code ${code}`);
}

interface JournalSpace {
  path: string;
  before: Buffer;
  main: Buffer;
  journalPath: string;
}

/** 主文件已是新镜像，`-journal` 保存旧镜像：一个真实的热日志窗口。 */
function seedJournal(label: string): JournalSpace {
  const path = join(ROOT, `${String((sequence += 1)).padStart(2, "0")}-${label}.sqlite3`);
  const db = new SQLite({ filename: path, journalMode: "delete" });
  db.exec("create table t (id integer primary key, v text not null)");
  db.run("insert into t (id, v) values (1, 'a')");
  const before = readFileSync(path);
  db.run("insert into t (id, v) values (2, 'b')");
  db.run("insert into t (id, v) values (3, 'c')");
  db.close();
  const main = readFileSync(path);
  assert.notDeepEqual(main, before, "the journal must describe an older image than the main file");
  const journalPath = writeHotJournal(path, before);
  return { path, before, main, journalPath };
}

test("a truncated header is rejected as corruption", (t) => {
  const path = writeBytes("truncated-header", readFileSync(BASE).subarray(0, 50));
  const bytes = readFileSync(path);
  const error = openError(path);
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite header too short/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only open must not rewrite the corrupt file");
  t.diagnostic(`truncated header reference: ${reference(path, "select count(*) from records")}`);
});

test("a wrong magic string is rejected as corruption", (t) => {
  const path = mutateBase("wrong-magic", (bytes) => bytes.fill(0, 0, 16));
  const bytes = readFileSync(path);
  const error = openError(path);
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite magic mismatch/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only open must not rewrite the corrupt file");
  t.diagnostic(`wrong magic reference: ${reference(path, "select count(*) from records")}`);
});

test("an illegal page size is rejected as corruption", (t) => {
  const path = mutateBase("page-size-513", (bytes) => bytes.writeUInt16BE(513, 16));
  const bytes = readFileSync(path);
  const error = openError(path);
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite page size invalid/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only open must not rewrite the corrupt file");
  t.diagnostic(`illegal page size reference: ${reference(path, "select count(*) from records")}`);
});

test("a declared page count beyond the file is rejected as corruption", (t) => {
  const path = mutateBase("page-count-out-of-range", (bytes) => bytes.writeUInt32BE(999_999, 28));
  const bytes = readFileSync(path);
  const error = openError(path);
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite declared page count exceeds file size/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only open must not rewrite the corrupt file");
  t.diagnostic(`page count reference: ${reference(path, "select count(*) from records")}`);
});

test("a table b-tree page with an illegal type is rejected on read", (t) => {
  const path = mutateBase("table-page-type", (bytes) => {
    bytes[(TABLE_ROOT - 1) * PAGE_SIZE] = 0xff;
  });
  const bytes = readFileSync(path);
  const error = readError(path, "select id from records");
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite table b-tree page type invalid/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only scan must not rewrite the corrupt file");
  t.diagnostic(`table page type reference: ${reference(path, "select count(*) from records")}`);
});

test("an index b-tree page with an illegal type is rejected on open", (t) => {
  const path = mutateBase("index-page-type", (bytes) => {
    bytes[(INDEX_ROOT - 1) * PAGE_SIZE] = 0x0d;
  }, INDEXED);
  const bytes = readFileSync(path);
  const error = openError(path);
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite index b-tree page type invalid/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only open must not rewrite the corrupt file");
  // 外部引擎只在真正读取索引时才失败，本实现打开即校验，因此这里记录严格性差异。
  t.diagnostic(`index page type reference: ${reference(path, "select count(*) from records")}`);
});

test("a table b-tree cell pointer outside the page is rejected on read", (t) => {
  const path = mutateBase("cell-pointer-out-of-bounds", (bytes) => {
    bytes.writeUInt16BE(600, (TABLE_ROOT - 1) * PAGE_SIZE + 12);
  });
  const bytes = readFileSync(path);
  const error = readError(path, "select id from records");
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite cell pointer out of bounds/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only scan must not rewrite the corrupt file");
  t.diagnostic(`cell pointer reference: ${reference(path, "select count(*) from records")}`);
});

test("a b-tree child page number outside the file is rejected on read", (t) => {
  const path = mutateBase("page-number-out-of-bounds", (bytes) => {
    bytes.writeUInt32BE(999_999, (TABLE_ROOT - 1) * PAGE_SIZE + 8);
  });
  const bytes = readFileSync(path);
  const error = readError(path, "select id from records");
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite page reference out of bounds/);
  assert.deepEqual(readFileSync(path), bytes, "a read-only scan must not rewrite the corrupt file");
  t.diagnostic(`page number reference: ${reference(path, "select count(*) from records")}`);
});

test("a corrupt table root beside an out-of-bounds index cell is rejected instead of crashing", (t) => {
  // 旧 facade 在「表根损坏 + 同库存在索引」时打开阶段会越界切片 panic。
  // 新 facade 先校验索引 cell 指针，再在扫描表根时校验页类型，两处都必须以
  // 结构化 `corrupt` 拒绝，进程不能崩溃。
  const indexHeader = readFileSync(INDEXED)[(INDEX_ROOT - 1) * PAGE_SIZE] === 0x02 ? 12 : 8;
  const path = mutateBase("table-root-with-index", (bytes) => {
    bytes[(TABLE_ROOT - 1) * PAGE_SIZE] = 0xff;
    bytes.writeUInt16BE(600, (INDEX_ROOT - 1) * PAGE_SIZE + indexHeader);
  }, INDEXED);
  const bytes = readFileSync(path);
  const error = openOrReadError(path, "select id from records");
  assert.equal(error.code, "corrupt");
  assert.match(error.message, /corrupt database file: sqlite /);
  assert.deepEqual(readFileSync(path), bytes, "a read-only open must not rewrite the corrupt file");
  t.diagnostic(`indexed table root reference: ${reference(path, "select count(*) from records")}`);
});

test("a read-only connection replays a hot journal in memory and never writes it back", (t) => {
  const space = seedJournal("hot-journal-read-only");
  const beforeMain = readFileSync(space.path);
  const beforeJournal = readFileSync(space.journalPath);
  const db = new SQLite({ filename: space.path, readOnly: true });
  try {
    assert.deepEqual(ids(db), [1], "the hot journal must hide the newer commits");
    const error = expectCode("read-only", () => db.run("insert into t (id, v) values (4, 'd')"));
    assert.match(error.message, /cannot modify a read-only database/);
    assert.deepEqual(ids(db), [1]);
  } finally {
    db.close();
  }
  assert.deepEqual(readFileSync(space.path), beforeMain, "a read-only replay must not rewrite the main file");
  assert.deepEqual(readFileSync(space.journalPath), beforeJournal, "a read-only replay must not delete or rewrite the journal");
  assert.ok(existsSync(space.journalPath), "the hot journal must still exist after a read-only open");
  t.diagnostic(`hot journal read-only reference: ${reference(space.path, "select count(*) from t")}`);
});

test("a writable connection rolls a hot journal back and cleans it", (t) => {
  const space = seedJournal("hot-journal-writable");
  const db = new SQLite({ filename: space.path, journalMode: "delete" });
  try {
    assert.deepEqual(ids(db), [1], "the hot journal must hide the newer commits");
  } finally {
    db.close();
  }
  assert.deepEqual(readFileSync(space.path), space.before, "recovery must restore the journaled image byte for byte");
  assert.equal(existsSync(space.journalPath), false, "delete mode removes the replayed journal");
  t.diagnostic(`hot journal writable reference: ${reference(space.path, "select count(*) from t")}`);
});

test("a truncated hot journal falls back to the main image without touching either file", (t) => {
  const space = seedJournal("hot-journal-truncated");
  const journal = readFileSync(space.journalPath);
  const truncated = journal.subarray(0, journal.length - 100);
  writeFileSync(space.journalPath, truncated);
  const db = new SQLite({ filename: space.path, readOnly: true });
  try {
    assert.deepEqual(ids(db), [1, 2, 3], "an unusable journal must not hide the committed main image");
  } finally {
    db.close();
  }
  assert.deepEqual(readFileSync(space.path), space.main, "the read-only open must not rewrite the main file");
  assert.deepEqual(readFileSync(space.journalPath), truncated, "the read-only open must not rewrite the truncated journal");
  t.diagnostic(`truncated journal reference: ${reference(space.path, "select count(*) from t")}`);
});

test("a hot journal with a mismatched checksum falls back to the main image", (t) => {
  const space = seedJournal("hot-journal-checksum");
  const journal = Buffer.from(readFileSync(space.journalPath));
  const pageSize = journal.readUInt32BE(24);
  const checksumOffset = 512 + 4 + pageSize;
  assert.ok(checksumOffset + 4 <= journal.length, "the journal must contain a page record checksum");
  journal[checksumOffset] ^= 0xff;
  writeFileSync(space.journalPath, journal);
  const db = new SQLite({ filename: space.path, readOnly: true });
  try {
    assert.deepEqual(ids(db), [1, 2, 3], "an unusable journal must not hide the committed main image");
  } finally {
    db.close();
  }
  assert.deepEqual(readFileSync(space.path), space.main, "the read-only open must not rewrite the main file");
  assert.deepEqual(readFileSync(space.journalPath), journal, "the read-only open must not rewrite the journal");
  t.diagnostic(`checksum journal reference: ${reference(space.path, "select count(*) from t")}`);
});
