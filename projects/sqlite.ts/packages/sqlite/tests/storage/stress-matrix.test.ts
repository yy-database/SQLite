import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWriter, openWriter, writeSlots } from "../../src/index.ts";

// External truth: every scenario is reopened by `better-sqlite3`, checked with
// `PRAGMA integrity_check`, and sampled row by row. The sequential artifact also
// goes through Python `sqlite3`.
const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): { run(...args: unknown[]): unknown; all(): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
};

const PYTHON = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const SCALE = 10_000;

function workspace(label: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sqlite-stress-${label}-`));
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

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffledIds(size: number, seed: number): number[] {
  const ids = Array.from({ length: size }, (_unused, index) => index + 1);
  const random = lcg(seed);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [ids[index], ids[swap]] = [ids[swap], ids[index]];
  }
  return ids;
}

function textAt(id: number): string {
  return `key-${String(id).padStart(10, "0")}`;
}

function intAt(id: number): number {
  return (id * 31) % 100003;
}

function blobAt(id: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 1) {
    bytes[offset] = (id * 31 + offset) % 251;
  }
  return bytes;
}

function sampleIds(count: number): number[] {
  const ids = [1, 2, 3, count - 2, count - 1, count];
  const step = Math.max(1, Math.floor(count / 97));
  for (let id = step; id <= count; id += step) ids.push(id);
  return [...new Set(ids)].filter((id) => id >= 1 && id <= count).sort((left, right) => left - right);
}

function itemsTable(writer: ReturnType<typeof createWriter>): void {
  writer.createTable(
    "items",
    JSON.stringify([
      { name: "id", declaredType: "INTEGER", primaryKey: true },
      { name: "k", declaredType: "TEXT" },
      { name: "v", declaredType: "INTEGER" },
      { name: "payload", declaredType: "BLOB" },
    ]),
  );
}

function insertItem(writer: ReturnType<typeof createWriter>, id: number): void {
  writer.insert("items", writeSlots([id, textAt(id), intAt(id), blobAt(id, 64)]));
}

interface Verifier {
  db: InstanceType<typeof BetterSqlite>;
  dispose(): void;
}

function verify(path: string): Verifier {
  const db = new BetterSqlite(path);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok", `${path}: integrity_check`);
  return { db, dispose: () => db.close() };
}

function countRows(db: InstanceType<typeof BetterSqlite>, table = "items"): number {
  const row = db.prepare(`select count(*) c from "${table}"`).get() as { c: number };
  return Number(row.c);
}

function assertSampledItems(
  db: InstanceType<typeof BetterSqlite>,
  scale: number,
  survivor: (id: number) => boolean,
  label: string,
): void {
  const statement = db.prepare("select k, v, payload from items where id = ?");
  let checked = 0;
  for (const id of sampleIds(scale)) {
    const row = statement.get(id) as { k: string; v: number; payload: Buffer } | undefined;
    if (!survivor(id)) {
      assert.equal(row, undefined, `${label}: deleted id ${id} must stay deleted`);
      continue;
    }
    assert.ok(row, `${label}: row id ${id} exists`);
    assert.equal(row.k, textAt(id), `${label}: id ${id} column k`);
    assert.equal(Number(row.v), intAt(id), `${label}: id ${id} column v`);
    assert.ok(row.payload.equals(blobAt(id, 64)), `${label}: id ${id} payload bytes`);
    checked += 1;
  }
  assert.ok(checked > 0, `${label}: sample set is not empty`);
}

test("sequential load stays externally valid at 10k rows", () => {
  const space = workspace("sequential");
  try {
    const writer = createWriter(4096);
    itemsTable(writer);
    for (let id = 1; id <= SCALE; id += 1) insertItem(writer, id);
    writer.save(space.path);
    const verifier = verify(space.path);
    try {
      assert.equal(countRows(verifier.db), SCALE);
      assertSampledItems(verifier.db, SCALE, () => true, "sequential");
    } finally {
      verifier.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("shuffled load stays externally valid at 10k rows", () => {
  const space = workspace("shuffled");
  try {
    const writer = createWriter(4096);
    itemsTable(writer);
    for (const id of shuffledIds(SCALE, 0x5eed)) insertItem(writer, id);
    writer.save(space.path);
    const verifier = verify(space.path);
    try {
      assert.equal(countRows(verifier.db), SCALE);
      assertSampledItems(verifier.db, SCALE, () => true, "shuffled");
    } finally {
      verifier.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("bulk transaction load stays externally valid at 10k rows", () => {
  const space = workspace("bulk");
  try {
    const writer = createWriter(4096);
    itemsTable(writer);
    writer.begin();
    for (let id = 1; id <= SCALE; id += 1) insertItem(writer, id);
    writer.commit();
    writer.save(space.path);
    const verifier = verify(space.path);
    try {
      assert.equal(countRows(verifier.db), SCALE);
      assertSampledItems(verifier.db, SCALE, () => true, "bulk");
    } finally {
      verifier.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("hollowed pages reach the freelist and reopen appends stay valid", () => {
  const space = workspace("hollow");
  try {
    const tailCut = Math.floor(SCALE * 0.95);
    const survivor = (id: number): boolean => id % 7 !== 1 && id % 7 !== 4 && id <= tailCut;
    const writer = createWriter(4096);
    itemsTable(writer);
    for (let id = 1; id <= SCALE; id += 1) insertItem(writer, id);
    let deleted = 0;
    for (let id = 1; id <= SCALE; id += 1) {
      if (!survivor(id)) {
        assert.equal(writer.delete("items", id), true, `delete id ${id}`);
        deleted += 1;
      }
    }
    writer.save(space.path);

    const verifier = verify(space.path);
    try {
      assert.equal(countRows(verifier.db), SCALE - deleted);
      assert.ok(Number(verifier.db.pragma("freelist_count", { simple: true })) > 0, "emptied pages reach the freelist");
      assertSampledItems(verifier.db, SCALE, survivor, "hollow first save");
    } finally {
      verifier.dispose();
    }

    const reopened = openWriter(space.path);
    for (let id = SCALE + 1; id <= SCALE + 1000; id += 1) insertItem(reopened, id);
    reopened.save(space.path);
    const after = verify(space.path);
    try {
      assert.equal(countRows(after.db), SCALE - deleted + 1000);
      assertSampledItems(after.db, SCALE, survivor, "hollow reopen");
    } finally {
      after.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("mixed inline and overflow payloads stay externally valid at 10k rows", () => {
  const space = workspace("overflow");
  try {
    const isOverflow = (id: number): boolean => id % 50 === 0;
    const writer = createWriter(4096);
    writer.createTable(
      "items",
      JSON.stringify([
        { name: "id", declaredType: "INTEGER", primaryKey: true },
        { name: "kind", declaredType: "TEXT" },
        { name: "data", declaredType: "BLOB" },
      ]),
    );
    for (let id = 1; id <= SCALE; id += 1) {
      const length = isOverflow(id) ? 8192 : 256;
      writer.insert("items", writeSlots([id, isOverflow(id) ? "overflow" : "inline", blobAt(id, length)]));
    }
    writer.save(space.path);

    const verifier = verify(space.path);
    try {
      assert.equal(countRows(verifier.db), SCALE);
      const statement = verifier.db.prepare("select kind, data from items where id = ?");
      let overflowChecked = 0;
      for (const id of sampleIds(SCALE)) {
        const row = statement.get(id) as { kind: string; data: Buffer };
        assert.equal(row.kind, isOverflow(id) ? "overflow" : "inline", `id ${id} kind`);
        assert.ok(row.data.equals(blobAt(id, isOverflow(id) ? 8192 : 256)), `id ${id} payload`);
        if (isOverflow(id)) overflowChecked += 1;
      }
      assert.ok(overflowChecked > 0, "overflow rows were sampled");
    } finally {
      verifier.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("dense secondary indexes stay externally valid after churn at 10k rows", () => {
  const space = workspace("index");
  try {
    const aAt = (id: number): number => (id * 7919) % 50021;
    const bAt = (id: number): string => `grp-${(id * 131) % 977}`;
    const cAt = (id: number): number => ((id * 37) % 1000) / 4;
    const writer = createWriter(4096);
    writer.createTable(
      "items",
      JSON.stringify([
        { name: "id", declaredType: "INTEGER", primaryKey: true },
        { name: "a", declaredType: "INTEGER" },
        { name: "b", declaredType: "TEXT" },
        { name: "c", declaredType: "REAL" },
      ]),
    );
    writer.createIndex("items_a", "items", ["a"], false);
    writer.createIndex("items_b", "items", ["b"], false);
    writer.createIndex("items_c", "items", ["c"], false);
    for (let id = 1; id <= SCALE; id += 1) {
      writer.insert("items", writeSlots([id, aAt(id), bAt(id), cAt(id)]));
    }
    const updates = Math.max(10, Math.floor(SCALE / 20));
    const updated = new Set<number>();
    for (let n = 0; n < updates; n += 1) {
      const id = ((n * 613) % SCALE) + 1;
      writer.update("items", id, writeSlots([{ keep: true }, { set: aAt(id) + 1 }, { keep: true }, { keep: true }]));
      updated.add(id);
    }
    let deleted = 0;
    for (let n = 0; n < updates; n += 1) {
      if (writer.delete("items", ((n * 1777) % SCALE) + 1)) deleted += 1;
    }
    writer.save(space.path);

    const verifier = verify(space.path);
    try {
      assert.equal(countRows(verifier.db), SCALE - deleted);
      const byId = verifier.db.prepare("select a, b, c from items where id = ?");
      const byA = verifier.db.prepare("select id from items where a = ? order by id");
      let probes = 0;
      for (const id of sampleIds(SCALE)) {
        const row = byId.get(id) as { a: number; b: string; c: number } | undefined;
        if (!row) continue;
        assert.equal(Number(row.a), updated.has(id) ? aAt(id) + 1 : aAt(id), `id ${id} column a`);
        assert.equal(row.b, bAt(id), `id ${id} column b`);
        assert.equal(Number(row.c), cAt(id), `id ${id} column c`);
        const viaA = (byA.all(Number(row.a)) as Array<{ id: number }>).map((entry) => Number(entry.id));
        assert.ok(viaA.includes(id), `id ${id} reachable through items_a`);
        probes += 1;
      }
      assert.ok(probes > 0, "index probes ran");
    } finally {
      verifier.dispose();
    }
  } finally {
    space.dispose();
  }
});

test("sequential 10k artifact also passes the Python sqlite3 oracle", () => {
  const space = workspace("python");
  try {
    const writer = createWriter(4096);
    itemsTable(writer);
    for (let id = 1; id <= SCALE; id += 1) insertItem(writer, id);
    writer.save(space.path);

    const script = [
      "import json, sqlite3, sys",
      "connection = sqlite3.connect(sys.argv[1])",
      "assert connection.execute('pragma integrity_check').fetchone()[0] == 'ok'",
      "count = connection.execute('select count(*) from items').fetchone()[0]",
      "sample = connection.execute('select id, k from items where id in (1, 2, 5000, 9999, 10000) order by id').fetchall()",
      "print(json.dumps({'count': count, 'sample': sample}))",
      "connection.close()",
    ].join("\n");
    const output = spawnSync(PYTHON, ["-c", script, space.path], { encoding: "utf8", timeout: 60_000 });
    assert.ifError(output.error);
    assert.equal(output.status, 0, output.stderr);
    const report = JSON.parse(output.stdout) as { count: number; sample: Array<[number, string]> };
    assert.equal(report.count, SCALE);
    assert.deepEqual(report.sample, [[1, textAt(1)], [2, textAt(2)], [5000, textAt(5000)], [9999, textAt(9999)], [10000, textAt(10000)]]);
  } finally {
    space.dispose();
  }
});
