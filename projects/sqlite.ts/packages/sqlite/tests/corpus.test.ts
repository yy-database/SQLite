import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/index.ts";

// External truth: the corpus is written by Python `sqlite3` and by
// `better-sqlite3`, then compared row by row and with `PRAGMA integrity_check`.
const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(): unknown[]; get(): unknown };
  close(): void;
};

const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-corpus-${label}-`));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows 持有句柄时忽略清理失败，临时目录随系统回收。
      }
    },
  };
}

function runPython(script: string, path: string, extra: string[] = []): void {
  const output = spawnSync(PYTHON, ["-c", script, path, ...extra], { encoding: "utf8", timeout: 30_000 });
  assert.ifError(output.error);
  assert.equal(output.status, 0, output.stderr);
}

const CORPUS = `
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.executescript("""
create table every (id integer primary key, i integer, r real, t text, b blob, empty text);
create table unique_probe (value text unique);
create table strict_probe (id integer primary key, n integer, s text) strict;
create view projected as select id, t from every;
create index every_t on every (t);
create index every_ti on every (t, i);
""")
rows = [
    (1, -9223372036854775808, -2.5, "案例-明", b"\\x00\\xff", ""),
    (2, 9223372036854775807, 0.0, "😀 surrogate", b"", None),
    (3, None, None, "", None, "full"),
]
connection.executemany("insert into every values (?, ?, ?, ?, ?, ?)", rows)
connection.execute("insert into unique_probe values ('unique')")
connection.execute("insert into strict_probe values (1, 7, 'strict')")
connection.commit()
assert connection.execute("pragma integrity_check").fetchone()[0] == "ok"
connection.close()
`;

test("external corpus reads with matching schema rows and exact page count", () => {
  const space = workspace("external");
  try {
    runPython(CORPUS, space.path);

    const oracle = new BetterSqlite(space.path);
    const externalSchema = oracle.prepare("select name, type, tbl_name from sqlite_master order by name").all() as Array<{
      name: string;
      type: string;
      tbl_name: string;
    }>;
    const pageCount = Number(oracle.pragma("page_count", { simple: true }));
    const every = oracle.prepare("select id, i, r, t, b, empty from every order by id").all() as Array<Record<string, unknown>>;
    const integrity = oracle.pragma("integrity_check", { simple: true });
    oracle.close();
    assert.equal(integrity, "ok");

    const bytes = readFileSync(space.path);
    assert.equal(bytes.readUInt32BE(28), pageCount, "header page count matches pragma page_count");
    assert.equal(bytes.length / Number(oraclePageSize(bytes)), pageCount);

    const database = openDatabase(space.path);
    const schema = database.schema();
    assert.deepEqual(
      schema.map((object) => [object.name, object.kind, object.tableName]).sort(),
      externalSchema.map((object) => [object.name, object.type, object.tbl_name]).sort(),
    );

    const rows = database.table("every");
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => {
        const columns = row.columns;
        return [
          Number(row.rowid),
          columns[1] === null ? null : Number(columns[1]),
          columns[2] === null ? null : Number(columns[2]),
          columns[3],
          columns[4] === null ? null : (columns[4] as Buffer).length,
          columns[5],
        ];
      }),
      every.map((row) => [
        Number(row.id),
        row.i === null ? null : Number(row.i),
        row.r === null ? null : Number(row.r),
        row.t,
        row.b === null ? null : (row.b as Buffer).length,
        row.empty,
      ]),
    );
  } finally {
    space.dispose();
  }
});

test("UTF-16LE and UTF-16BE corpora decode through the declared encoding", () => {
  for (const encoding of ["UTF-16le", "UTF-16be"] as const) {
    const space = workspace(encoding.toLowerCase());
    try {
      const script = `
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("pragma encoding='${encoding}'")
connection.execute("create table words (id integer primary key, v text)")
connection.executemany("insert into words (id, v) values (?, ?)", [(1, "純粋"), (2, "😀"), (3, "日本語テキスト")])
connection.commit()
assert connection.execute("pragma integrity_check").fetchone()[0] == "ok"
connection.close()
`;
      runPython(script, space.path);
      const database = openDatabase(space.path);
      assert.equal(database.encoding(), encoding === "UTF-16le" ? "utf16le" : "utf16be");
      assert.deepEqual(
        database.table("words").map((row) => row.columns[1]),
        ["純粋", "😀", "日本語テキスト"],
      );
    } finally {
      space.dispose();
    }
  }
});

function oraclePageSize(bytes: Buffer): number {
  const raw = bytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}
