import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWriter, openDatabase, writeSlots } from "../../src/index.ts";
import type { DecodedRow, DecodedValue } from "../../src/index.ts";

const require = createRequire(import.meta.url);
const ROWS = 1000;
const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

interface Statement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
  safeIntegers(flag: boolean): Statement;
}

interface ExternalDatabase {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): Statement;
  close(): void;
}

const BetterSqlite = require("better-sqlite3") as new (path: string) => ExternalDatabase;

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-scenario-${label}-`));
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

function headerPageSize(bytes: Buffer): number {
  const raw = bytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

function pageSize(path: string): number {
  const oracle = new BetterSqlite(path);
  const row = oracle.prepare("pragma page_size").get() as { page_size: number };
  oracle.close();
  return Number(row.page_size);
}

function integrity(database: ExternalDatabase): string {
  return (database.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
}

function sha(payload: Buffer | null): string {
  return payload === null ? "null" : createHash("sha256").update(payload).digest("hex");
}

function shuffledIds(count = ROWS): number[] {
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = (index * 7919) % (index + 1);
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
  }
  return ids;
}

function standardColumns(): string {
  return JSON.stringify([
    { name: "id", declaredType: "INTEGER", primaryKey: true },
    { name: "label", declaredType: "TEXT" },
    { name: "score", declaredType: "REAL" },
    { name: "payload", declaredType: "BLOB" },
    { name: "flag", declaredType: "INTEGER" },
  ]);
}

function numeric(value: DecodedValue): string {
  return value === null ? "null" : String(Number(value));
}

function standardDigests(rows: DecodedRow[]): string[] {
  return rows.map((row) => {
    const [, label, score, payload, flag] = row.columns;
    return [
      row.rowid.toString(),
      label === null ? "null" : String(label),
      numeric(score),
      sha(Buffer.isBuffer(payload) ? payload : null),
      flag === null ? "null" : String(flag),
    ].join("|");
  });
}

function externalStandard(database: ExternalDatabase, table: string): string[] {
  const rows = database
    .prepare(`select rowid as rid, label, score, payload, flag from ${table} order by rowid`)
    .safeIntegers(true)
    .all() as { rid: bigint; label: string | null; score: number | null; payload: Buffer | null; flag: bigint | null }[];
  return rows.map((row) =>
    [
      row.rid.toString(),
      row.label ?? "null",
      row.score === null ? "null" : String(Number(row.score)),
      sha(row.payload),
      row.flag === null ? "null" : row.flag.toString(),
    ].join("|"),
  );
}

function insertStandard(writer: ReturnType<typeof createWriter>, table: string, ids: number[]): void {
  for (const index of ids) {
    const flag = index === 1 ? { $i64: "-9223372036854775808" } : index === 2 ? { $i64: "9223372036854775807" } : index % 997;
    const payload = index % 10 === 0 ? Buffer.alloc(3000, index % 251) : null;
    const label = index % 3 === 0 ? `案例-${index}` : `row-${index}`;
    const score = index % 2 === 0 ? index : index / 7;
    writer.insert(table, writeSlots([index, label, score, payload, flag]));
  }
}

test("narrow rows fill multiple leaf pages with matching dividers", () => {
  const space = workspace("narrow");
  try {
    const writer = createWriter(1024);
    writer.createTable("n", JSON.stringify([{ name: "id", declaredType: "INTEGER", primaryKey: true }, { name: "label", declaredType: "TEXT" }]));
    for (const id of shuffledIds()) writer.insert("n", writeSlots([id, `n-${id}`]));
    const image = writer.pages();
    assert.equal(headerPageSize(image), 1024);
    assert.ok(image.length / 1024 >= 2, "1000 narrow rows must exceed one leaf page");
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const external = oracle.prepare("select rowid as rid, label from n order by rowid").safeIntegers(true).all() as { rid: bigint; label: string }[];
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.equal(external.length, ROWS);

    const mine = openDatabase(space.path)
      .table("n")
      .map((row) => `${row.rowid.toString()}|${row.columns[1]}`);
    assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${row.label}`), "leaf dividers must keep every row in rowid order");
  } finally {
    space.dispose();
  }
});

test("wide rows round trip every overflow payload", () => {
  const space = workspace("overflow");
  try {
    const writer = createWriter(1024);
    writer.createTable("w", standardColumns());
    insertStandard(writer, "w", shuffledIds());
    assert.ok(writer.pages().length / 1024 > 100, "overflow payloads must allocate many pages");
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const external = externalStandard(oracle, "w");
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.equal(external.length, ROWS);
    assert.deepEqual(standardDigests(openDatabase(space.path).table("w")), external, "each 3000 byte BLOB must survive the overflow chain");
  } finally {
    space.dispose();
  }
});

test("deleting the middle 200 rows keeps interior routing exact", () => {
  const space = workspace("delete");
  try {
    const writer = createWriter(512);
    writer.createTable("d", standardColumns());
    insertStandard(writer, "d", shuffledIds());
    for (let id = 401; id <= 600; id += 1) assert.equal(writer.delete("d", id), true);
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const external = externalStandard(oracle, "d");
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.equal(external.length, 800);
    assert.deepEqual(standardDigests(openDatabase(space.path).table("d")), external, "interior upper-bound keys must route the survivors correctly");

    const mirrored = workspace("delete-external");
    try {
      const seed = new BetterSqlite(mirrored.path);
      seed.pragma("page_size = 512");
      seed.exec("create table d (id integer primary key, label text, score real, payload blob, flag integer)");
      const insert = seed.prepare("insert into d (id, label, score, payload, flag) values (?, ?, ?, ?, ?)").safeIntegers(true);
      for (const index of shuffledIds()) {
        const flag = index === 1 ? BigInt("-9223372036854775808") : index === 2 ? BigInt("9223372036854775807") : BigInt(index % 997);
        insert.run(BigInt(index), index % 3 === 0 ? `案例-${index}` : `row-${index}`, index % 2 === 0 ? index : index / 7, index % 10 === 0 ? Buffer.alloc(3000, index % 251) : null, flag);
      }
      seed.exec("delete from d where id between 401 and 600");
      const external2 = externalStandard(seed, "d");
      assert.equal(integrity(seed), "ok");
      seed.close();
      assert.equal(external2.length, 800);
      assert.deepEqual(standardDigests(openDatabase(mirrored.path).table("d")), external2, "external deletes must not confuse interior routing either");
    } finally {
      mirrored.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("WITHOUT ROWID rows stay in primary-key order", () => {
  const space = workspace("without-rowid");
  try {
    const seed = new BetterSqlite(space.path);
    seed.pragma("page_size = 1024");
    seed.exec("create table wr (k text primary key, v text) without rowid");
    const insert = seed.prepare("insert into wr (k, v) values (?, ?)");
    for (const id of shuffledIds()) insert.run(`k-${String(id).padStart(4, "0")}`, `v-${id}`);
    const external = seed.prepare("select k, v from wr order by k").all() as { k: string; v: string }[];
    assert.equal(integrity(seed), "ok");
    seed.close();
    assert.equal(external.length, ROWS);

    const mine = openDatabase(space.path)
      .tableWithoutRowid("wr")
      .map((columns) => `${columns[0]}|${columns[1]}`);
    assert.deepEqual(mine, external.map((row) => `${row.k}|${row.v}`), "the primary-key index b-tree must be walked in key order");
  } finally {
    space.dispose();
  }
});

test("duplicate index keys preserve label and rowid order", () => {
  const space = workspace("index");
  try {
    const writer = createWriter(512);
    writer.createTable("ix", JSON.stringify([
      { name: "id", declaredType: "INTEGER", primaryKey: true },
      { name: "label", declaredType: "TEXT" },
    ]));
    writer.createIndex("i_label", "ix", ["label"]);
    for (const id of shuffledIds()) writer.insert("ix", writeSlots([id, `label-${id % 10}`]));
    assert.ok(writer.pages().length / 512 > 100, "the table plus index must span many pages");
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const external = oracle.prepare("select label, rowid as rid from ix indexed by i_label order by label, rowid").safeIntegers(true).all() as {
      label: string;
      rid: bigint;
    }[];
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.equal(external.length, ROWS);
    const mine = openDatabase(space.path)
      .index("i_label")
      .map((row) => `${row.columns[0]}|${row.rowid.toString()}`);
    assert.deepEqual(mine, external.map((row) => `${row.label}|${row.rid.toString()}`), "duplicate keys must tie break by rowid");

    const mirrored = workspace("autoindex");
    try {
      const seed = new BetterSqlite(mirrored.path);
      seed.pragma("page_size = 512");
      seed.exec("create table d (id integer primary key, label text, code text unique)");
      const insert = seed.prepare("insert into d (id, label, code) values (?, ?, ?)").safeIntegers(true);
      for (const id of shuffledIds()) insert.run(BigInt(id), `label-${id % 10}`, `code-${id}`);
      const names = seed.prepare("select name from sqlite_master where type = 'index' order by name").all() as { name: string }[];
      const auto = names.map((row) => row.name).find((name) => name.startsWith("sqlite_autoindex_"));
      assert.ok(auto, "a UNIQUE column must create an automatic index");
      const autoRows = seed.prepare(`select code, rowid as rid from d indexed by ${auto} order by code, rowid`).safeIntegers(true).all() as {
        code: string;
        rid: bigint;
      }[];
      seed.close();
      assert.deepEqual(
        openDatabase(mirrored.path).index(auto).map((row) => `${row.columns[0]}|${row.rowid.toString()}`),
        autoRows.map((row) => `${row.code}|${row.rid.toString()}`),
        "the automatic index must be readable through the public index API",
      );
    } finally {
      mirrored.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("mixed serial types survive both directions", () => {
  const space = workspace("serial");
  try {
    const writer = createWriter(1024);
    writer.createTable("m", standardColumns());
    insertStandard(writer, "m", shuffledIds());
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const written = externalStandard(oracle, "m");
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.deepEqual(standardDigests(openDatabase(space.path).table("m")), written, "our writer to external reader");

    const mirrored = workspace("serial-external");
    try {
      const seed = new BetterSqlite(mirrored.path);
      seed.pragma("page_size = 1024");
      seed.exec("create table m (id integer primary key, label text, score real, payload blob, flag integer)");
      const insert = seed.prepare("insert into m (id, label, score, payload, flag) values (?, ?, ?, ?, ?)").safeIntegers(true);
      for (const index of shuffledIds()) {
        const flag = index === 1 ? BigInt("-9223372036854775808") : index === 2 ? BigInt("9223372036854775807") : BigInt(index % 997);
        insert.run(BigInt(index), index % 3 === 0 ? `案例-${index}` : `row-${index}`, index % 2 === 0 ? index : index / 7, index % 10 === 0 ? Buffer.alloc(3000, index % 251) : null, flag);
      }
      const external = externalStandard(seed, "m");
      assert.equal(integrity(seed), "ok");
      seed.close();
      assert.deepEqual(standardDigests(openDatabase(mirrored.path).table("m")), external, "external writer to our reader");
    } finally {
      mirrored.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("WAL replay survives 50 checkpoint rounds", () => {
  const space = workspace("wal");
  try {
    const seed = new BetterSqlite(space.path);
    seed.pragma("page_size = 512");
    seed.pragma("journal_mode = wal");
    seed.exec("create table w (id integer primary key, label text)");
    const insert = seed.prepare("insert into w (label) values (?)");
    for (let round = 0; round < 50; round += 1) {
      for (let index = 1; index <= 20; index += 1) insert.run(`round-${round}-${index}`);
      seed.pragma("wal_checkpoint(PASSIVE)");
    }
    const walPath = `${space.path}-wal`;
    assert.ok(existsSync(walPath), "PASSIVE checkpoints keep the -wal sidecar");
    assert.ok(readFileSync(walPath).length > 32, "the -wal sidecar holds committed frames");
    assert.ok(existsSync(`${space.path}-shm`), "the -shm sidecar exists while the wal is live");
    const external = seed.prepare("select rowid as rid, label from w order by rowid").safeIntegers(true).all() as { rid: bigint; label: string }[];
    assert.equal(integrity(seed), "ok");
    seed.close();
    assert.equal(external.length, ROWS);

    const mine = openDatabase(space.path)
      .table("w")
      .map((row) => `${row.rowid.toString()}|${row.columns[1]}`);
    assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${row.label}`), "every checkpoint round must replay");
  } finally {
    space.dispose();
  }
});

test("hot journal rolls a killed 200 row transaction back", () => {
  const space = workspace("journal");
  try {
    const seed = new BetterSqlite(space.path);
    seed.pragma("page_size = 512");
    seed.exec("create table j (id integer primary key, label text)");
    const insert = seed.prepare("insert into j (label) values (?)");
    for (let index = 1; index <= ROWS; index += 1) insert.run(`committed-${index}`);
    seed.close();

    const script = [
      "import os, sqlite3, sys",
      "connection = sqlite3.connect(sys.argv[1], isolation_level=None)",
      "connection.execute('pragma journal_mode = delete')",
      "connection.execute('begin immediate')",
      "for index in range(200): connection.execute('insert into j (label) values (?)', (f'uncommitted-{index}',))",
      "os._exit(9)",
    ].join("\n");
    const result = spawnSync(PYTHON, ["-c", script, space.path]);
    assert.notEqual(result.status, 0, "the writer process must be killed");
    assert.ok(existsSync(`${space.path}-journal`), "a killed transaction leaves a hot journal");
    assert.ok(readFileSync(`${space.path}-journal`).length >= 512, "the hot journal holds page images");

    const oracle = new BetterSqlite(space.path);
    const external = oracle.prepare("select rowid as rid, label from j order by rowid").safeIntegers(true).all() as { rid: bigint; label: string }[];
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.equal(external.length, ROWS);
    const mine = openDatabase(space.path)
      .table("j")
      .map((row) => `${row.rowid.toString()}|${row.columns[1]}`);
    assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${row.label}`), "the 200 uncommitted rows must be rolled back");
  } finally {
    space.dispose();
  }
});

test("thousand same-key updates settle on one value", () => {
  const space = workspace("update");
  try {
    const writer = createWriter(512);
    writer.createTable("u", JSON.stringify([{ name: "id", declaredType: "INTEGER", primaryKey: true }, { name: "label", declaredType: "TEXT" }]));
    writer.insert("u", writeSlots([1, "start"]));
    for (let index = 1; index <= ROWS; index += 1) assert.equal(writer.update("u", 1, JSON.stringify([{ keep: true }, { set: `v-${index}` }])), true);
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const written = oracle.prepare("select label from u where rowid = 1").get() as { label: string };
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    assert.equal(written.label, `v-${ROWS}`);
    assert.equal(openDatabase(space.path).table("u")[0].columns[1], `v-${ROWS}`);

    const mirrored = workspace("update-external");
    try {
      const seed = new BetterSqlite(mirrored.path);
      seed.pragma("page_size = 512");
      seed.exec("create table u (id integer primary key, label text)");
      seed.prepare("insert into u (id, label) values (?, ?)").run(1, "start");
      const update = seed.prepare("update u set label = ? where id = 1");
      for (let index = 1; index <= ROWS; index += 1) update.run(`v-${index}`);
      const external = seed.prepare("select label from u where rowid = 1").get() as { label: string };
      assert.equal(integrity(seed), "ok");
      seed.close();
      assert.equal(openDatabase(mirrored.path).table("u")[0].columns[1], external.label);
    } finally {
      mirrored.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("page sizes 512 1024 and 4096 agree with external pragma", () => {
  for (const size of [512, 1024, 4096]) {
    const space = workspace(`page-${size}`);
    try {
      const writer = createWriter(size);
      writer.createTable("p", JSON.stringify([{ name: "id", declaredType: "INTEGER", primaryKey: true }, { name: "label", declaredType: "TEXT" }]));
      for (let index = 1; index <= ROWS; index += 1) writer.insert("p", writeSlots([index, `p-${index}`]));
      assert.equal(headerPageSize(writer.pages()), size, `writer header must declare ${size}`);
      assert.ok(writer.pages().length / size >= 2);
      writer.save(space.path);
      assert.equal(pageSize(space.path), size, `external pragma must report ${size}`);

      const oracle = new BetterSqlite(space.path);
      const external = oracle.prepare("select rowid as rid, label from p order by rowid").safeIntegers(true).all() as { rid: bigint; label: string }[];
      assert.equal(integrity(oracle), "ok");
      oracle.close();
      const mine = openDatabase(space.path)
        .table("p")
        .map((row) => `${row.rowid.toString()}|${row.columns[1]}`);
      assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${row.label}`), `rows at page size ${size}`);
    } finally {
      space.dispose();
    }
  }
});

test("1000 UTF-16 rows decode through the declared encoding", () => {
  const variants: [string, string, number][] = [
    ["UTF-16le", "utf16le", 2],
    ["UTF-16be", "utf16be", 3],
  ];
  for (const [label, expectedEncoding, marker] of variants) {
    const space = workspace(`utf16-${expectedEncoding}`);
    try {
      const seed = new BetterSqlite(space.path);
      seed.pragma(`encoding = '${label}'`);
      seed.pragma("page_size = 1024");
      seed.exec("create table u (id integer primary key, label text)");
      const insert = seed.prepare("insert into u (id, label) values (?, ?)");
      for (const id of shuffledIds()) insert.run(id, `案例-${id}`);
      const encoding = seed.prepare("pragma encoding").get() as { encoding: string };
      assert.equal(integrity(seed), "ok");
      seed.close();
      assert.equal(encoding.encoding.toUpperCase(), label.toUpperCase());

      const reader = openDatabase(space.path);
      assert.equal(reader.encoding(), expectedEncoding);
      assert.equal(reader.pages().readUInt32BE(56), marker);
      const mine = reader.table("u").map((row) => `${row.rowid.toString()}|${row.columns[1]}`);
      const oracle = new BetterSqlite(space.path);
      const external = oracle.prepare("select rowid as rid, label from u order by rowid").safeIntegers(true).all() as { rid: bigint; label: string }[];
      oracle.close();
      assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${row.label}`), `rows in ${label}`);
    } finally {
      space.dispose();
    }
  }
});

test("STRICT tables read and simple views resolve while virtual tables fail closed", () => {
  const space = workspace("objects");
  try {
    const seed = new BetterSqlite(space.path);
    seed.pragma("page_size = 1024");
    seed.exec("create table s (id integer primary key, label text) strict");
    const insert = seed.prepare("insert into s (id, label) values (?, ?)");
    for (const id of shuffledIds()) insert.run(id, `strict-${id}`);
    seed.exec("create view v as select id, label from s");
    seed.exec("create virtual table vt using fts5(body)");
    seed.prepare("insert into vt (body) values (?)").run("virtual-row");
    const master = seed.prepare("select type, name from sqlite_master order by name").all() as { type: string; name: string }[];
    assert.equal(integrity(seed), "ok");
    seed.close();

    const reader = openDatabase(space.path);
    assert.deepEqual(
      reader.schema().map((object) => `${object.kind}:${object.name}`).sort(),
      master.map((row) => `${row.type}:${row.name}`).sort(),
      "schema listing must match the external sqlite_master",
    );
    assert.equal(reader.table("s").length, ROWS);
    assert.equal(reader.table("v").length, ROWS, "a simple projection view resolves against its base table");
    assert.throws(() => reader.table("vt"), /virtual/i, "a virtual table must fail closed");
  } finally {
    space.dispose();
  }
});

test("REAL affinity keeps numeric values at 1000 rows", () => {
  const space = workspace("real");
  try {
    const writer = createWriter(1024);
    writer.createTable("r", JSON.stringify([{ name: "id", declaredType: "INTEGER", primaryKey: true }, { name: "score", declaredType: "REAL" }]));
    for (const id of shuffledIds()) writer.insert("r", writeSlots([id, id % 2 === 0 ? id : id / 7]));
    writer.save(space.path);
    const oracle = new BetterSqlite(space.path);
    const external = oracle.prepare("select rowid as rid, score from r order by rowid").safeIntegers(true).all() as { rid: bigint; score: number }[];
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    const mine = openDatabase(space.path).table("r").map((row) => `${row.rowid.toString()}|${Number(row.columns[1])}`);
    assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${Number(row.score)}`), "numeric values must match despite integer storage");
  } finally {
    space.dispose();
  }
});

test("INTEGER PRIMARY KEY stays a rowid alias at 1000 rows", () => {
  const space = workspace("alias");
  try {
    const ids = [...shuffledIds(500), ...shuffledIds(500).map((id) => -id)];
    const writer = createWriter(1024);
    writer.createTable("a", JSON.stringify([{ name: "id", declaredType: "INTEGER", primaryKey: true }, { name: "label", declaredType: "TEXT" }]));
    for (const id of ids) writer.insert("a", writeSlots([id, `id-${id}`]));
    writer.save(space.path);
    const oracle = new BetterSqlite(space.path);
    const external = oracle.prepare("select rowid as rid, id, label from a order by rowid").safeIntegers(true).all() as { rid: bigint; id: bigint; label: string }[];
    assert.equal(integrity(oracle), "ok");
    const drifted = external.filter((row) => row.rid.toString() !== row.id.toString());
    oracle.close();
    assert.deepEqual(drifted, [], "the external engine must also see rowid == id");
    const mine = openDatabase(space.path).table("a").map((row) => `${row.rowid.toString()}|${row.columns[1]}`);
    assert.deepEqual(mine, external.map((row) => `${row.rid.toString()}|${row.label}`), "our rowid must match the external id alias");
    assert.ok(
      openDatabase(space.path)
        .table("a")
        .every((row) => row.columns[0] === null),
      "the rowid alias column is stored as NULL in the record, which external SQL resolves through rowid",
    );
  } finally {
    space.dispose();
  }
});

test("sqlite_master lists explicit and automatic indexes at scale", () => {
  const space = workspace("master");
  try {
    const writer = createWriter(1024);
    writer.createTable("t", JSON.stringify([
      { name: "id", declaredType: "INTEGER", primaryKey: true },
      { name: "label", declaredType: "TEXT", unique: true },
      { name: "group_name", declaredType: "TEXT" },
    ]));
    writer.createIndex("i_group", "t", ["group_name"]);
    writer.createIndex("i_label_group", "t", ["label", "group_name"]);
    for (const id of shuffledIds()) writer.insert("t", writeSlots([id, `label-${id}`, `group-${id % 10}`]));
    writer.save(space.path);

    const oracle = new BetterSqlite(space.path);
    const external = oracle.prepare("select type, name, tbl_name, rootpage from sqlite_master order by name").all() as {
      type: string;
      name: string;
      tbl_name: string;
      rootpage: number;
    }[];
    assert.equal(integrity(oracle), "ok");
    oracle.close();
    const mine = openDatabase(space.path).schema().map((object) => `${object.kind}:${object.name}:${object.tableName}`).sort();
    assert.deepEqual(mine, external.map((row) => `${row.type}:${row.name}:${row.tbl_name}`), "schema objects must match at scale");
    const indexed = external.filter((row) => row.type === "index");
    assert.ok(indexed.length >= 3, "two explicit indexes plus at least one automatic index");
    assert.ok(indexed.every((row) => Number(row.rootpage) > 1), "every index must own a b-tree root page");
  } finally {
    space.dispose();
  }
});
