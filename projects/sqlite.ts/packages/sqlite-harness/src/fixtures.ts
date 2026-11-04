// `fixtures` subcommand: every acceptance asset is produced by an external
// engine (`better-sqlite3` or Python's `sqlite3`), never by this repository's
// writer. The command prints a sha256 for each file so a regenerated asset can
// be compared without a separate manifest.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { emit, execFile, repoPath, renderTable, type CliOptions } from "./util.ts";

const require = createRequire(repoPath("projects", "sqlite.ts", "packages", "sqlite", "package.json"));
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

const PYTHON = process.platform === "win32" ? "python" : "python3";

export interface GeneratedFixture {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly engine: string;
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function fixturePath(directory: string, name: string): string {
  return join(directory, name);
}

function withDatabase(path: string, populate: (database: InstanceType<typeof BetterSqlite>) => void): void {
  rmSync(path, { force: true });
  const database = new BetterSqlite(path);
  try {
    populate(database);
  } finally {
    database.close();
  }
}

function blank(path: string): void {
  withDatabase(path, (database) => {
    database.pragma("page_size = 4096");
    database.exec("create table seeded(only_one integer)");
    database.exec("drop table seeded");
    database.exec("vacuum");
  });
}

function utf16(path: string, encoding: "UTF-16le" | "UTF-16be"): void {
  withDatabase(path, (database) => {
    database.pragma("page_size = 4096");
    database.pragma(`encoding = '${encoding}'`);
    database.exec("create table texts(id integer primary key, body text, note text)");
    database.prepare("insert into texts (id, body, note) values (?, ?, ?)").run(1, "純粋な日本語", "😀 emoji");
    database.prepare("insert into texts (id, body, note) values (?, ?, ?)").run(2, "ASCII", "mixed 😀");
    database.pragma("synchronous = off");
  });
}

function overflow(path: string): void {
  withDatabase(path, (database) => {
    database.pragma("page_size = 512");
    database.exec("create table payloads(id integer primary key, body text)");
    database.prepare("insert into payloads (id, body) values (?, ?)").run(1, "A".repeat(8_999) + "B");
  });
}

function widePages(path: string): void {
  withDatabase(path, (database) => {
    database.pragma("page_size = 65536");
    database.exec("create table wide(id integer primary key, label text)");
    const insert = database.prepare("insert into wide (id, label) values (?, ?)");
    for (let row = 1; row <= 100; row += 1) insert.run(row, `row-${row}`);
  });
}

export interface WalFixture {
  readonly path: string;
  readonly walPath: string;
}

// A WAL that still holds committed frames needs the producing process to exit
// without closing the connection, because closing the last connection
// checkpoints and removes `-wal`. Python drives that through `os._exit`.
export function uncheckpointedWal(directory: string, name: string): WalFixture {
  const path = fixturePath(directory, name);
  const walPath = `${path}-wal`;
  rmSync(path, { force: true });
  rmSync(walPath, { force: true });
  rmSync(`${path}-shm`, { force: true });
  const script = `
import os, sqlite3, sys
path = sys.argv[1]
connection = sqlite3.connect(path)
connection.execute("pragma journal_mode = wal")
connection.execute("pragma wal_autocheckpoint = 0")
connection.execute("create table wal_items (id integer primary key, label text)")
connection.execute("insert into wal_items (id, label) values (1, 'w1')")
connection.execute("insert into wal_items (id, label) values (2, 'w2')")
connection.commit()
os._exit(0)
`;
  const result = execFile(PYTHON, ["-c", script, path]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "failed to build a WAL fixture");
  return { path, walPath };
}

export interface FixtureSet {
  readonly directory: string;
  readonly files: GeneratedFixture[];
  readonly wal: WalFixture;
}

export function generateFixtures(directory: string): FixtureSet {
  mkdirSync(directory, { recursive: true });
  const files: GeneratedFixture[] = [];
  const record = (name: string, engine: string, path = fixturePath(directory, name)): void => {
    files.push({
      name,
      path,
      bytes: readFileSync(path).length,
      sha256: sha256(path),
      engine,
    });
  };

  blank(fixturePath(directory, "blank.sqlite"));
  record("blank.sqlite", "better-sqlite3");

  utf16(fixturePath(directory, "utf16le.sqlite"), "UTF-16le");
  record("utf16le.sqlite", "better-sqlite3");
  utf16(fixturePath(directory, "utf16be.sqlite"), "UTF-16be");
  record("utf16be.sqlite", "better-sqlite3");

  overflow(fixturePath(directory, "overflow.sqlite"));
  record("overflow.sqlite", "better-sqlite3");

  widePages(fixturePath(directory, "wide-pages.sqlite"));
  record("wide-pages.sqlite", "better-sqlite3");

  const source = fixturePath(directory, "overflow.sqlite");
  const bitflip = fixturePath(directory, "corrupt-bitflip.sqlite");
  copyFileSync(source, bitflip);
  const bytes = readFileSync(bitflip);
  const target = Math.floor(bytes.length / 2);
  bytes[target] ^= 0x40;
  writeFileSync(bitflip, bytes);
  record("corrupt-bitflip.sqlite", "better-sqlite3 bytes, flipped bit");

  const truncated = fixturePath(directory, "corrupt-truncated.sqlite");
  copyFileSync(source, truncated);
  writeFileSync(truncated, readFileSync(truncated).subarray(0, bytes.length - 200));
  record("corrupt-truncated.sqlite", "better-sqlite3 bytes, truncated");

  const header = fixturePath(directory, "corrupt-header.sqlite");
  copyFileSync(source, header);
  const headerBytes = readFileSync(header);
  headerBytes.fill(0, 0, 16);
  writeFileSync(header, headerBytes);
  record("corrupt-header.sqlite", "better-sqlite3 bytes, zeroed header");

  const wal = uncheckpointedWal(directory, "wal-uncheckpointed.sqlite");
  record("wal-uncheckpointed.sqlite", "python sqlite3");
  files.push({
    name: "wal-uncheckpointed.sqlite-wal",
    path: wal.walPath,
    bytes: readFileSync(wal.walPath).length,
    sha256: sha256(wal.walPath),
    engine: "python sqlite3",
  });

  return { directory, files, wal };
}

export function commandFixtures(options: CliOptions): number {
  const directory = repoPath("projects", "sqlite.ts", "packages", "sqlite-fixtures", "fixtures");
  const generated = generateFixtures(directory);
  const payload = { command: "fixtures", ok: true, directory, files: generated.files };
  const text = () => {
    const rows = generated.files.map((file) => [file.name, file.bytes, file.engine, file.sha256]);
    return renderTable(["file", "bytes", "engine", "sha256"], rows);
  };
  emit(options, payload as unknown as Record<string, unknown>, text);
  return 0;
}
