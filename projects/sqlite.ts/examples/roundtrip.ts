// 下游验收示例：本仓 writer / reader 与真实 SQLite 引擎的写读双向核对。
//
// 期望值全部来自外部引擎（better-sqlite3 与 `PRAGMA integrity_check`），不读取
// 本仓任何内部常量。运行：`pnpm --dir projects/sqlite.ts examples`

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriter, openDatabase, type RecordValue } from "../packages/sqlite/src/index.ts";

const PAGE_SIZE = 4096;
const ROWS = 1000;

function column(value: RecordValue): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "integer":
      return Number(value.valueInteger);
    case "real":
      return value.valueReal;
    case "text":
      return value.valueText;
    case "blob":
      return Buffer.from(value.valueBlob ?? []).toString("hex");
    default:
      throw new Error(`unknown column kind ${value.kind}`);
  }
}

const columns = [
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
];

const expected = Array.from({ length: ROWS }, (_, index) => ({
  id: index + 1,
  label: `row-${index + 1}`,
  score: (index + 1) / 4,
}));

const folder = mkdtempSync(join(tmpdir(), "sqlite-example-"));

try {
  // 方向一：本仓写入 → 外部引擎读。
  const written = join(folder, "written.sqlite3");
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", JSON.stringify(columns));
  for (const row of expected) {
    writer.insert("items", JSON.stringify([row.id, row.label, row.score]));
  }
  writer.save(written);

  const external = new Database(written, { readonly: true });
  const externalRows = external.prepare("SELECT id, label, score FROM items ORDER BY id").all();
  const integrity = external.pragma("integrity_check", { simple: true });
  external.close();

  if (integrity !== "ok") throw new Error(`integrity_check failed: ${integrity}`);
  if (externalRows.length !== ROWS) throw new Error(`external read ${externalRows.length} rows, expected ${ROWS}`);
  for (const row of expected) {
    const observed = externalRows[row.id - 1] as { id: number; label: string; score: number };
    if (observed.id !== row.id || observed.label !== row.label || observed.score !== row.score) {
      throw new Error(`write-to-external mismatch at id=${row.id}: ${JSON.stringify(observed)}`);
    }
  }

  // 方向二：外部引擎写 → 本仓读。
  const externalWritten = join(folder, "external.sqlite3");
  const created = new Database(externalWritten);
  created.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, score REAL)");
  const insert = created.prepare("INSERT INTO items (id, label, score) VALUES (?, ?, ?)");
  for (const row of expected) insert.run(row.id, row.label, row.score);
  created.close();

  const reader = openDatabase(externalWritten);
  const decoded = reader.table("items");
  if (decoded.length !== ROWS) throw new Error(`native read ${decoded.length} rows, expected ${ROWS}`);
  for (const row of expected) {
    const observed = decoded[row.id - 1].columns.map(column);
    // `INTEGER PRIMARY KEY` 是 rowid 别名，序列化 payload 里没有它的值，行标识只看 rowid。
    if (Number(decoded[row.id - 1].rowid) !== row.id || observed[1] !== row.label || observed[2] !== row.score) {
      throw new Error(`external-to-read mismatch at id=${row.id}: ${JSON.stringify(observed)}`);
    }
  }

  // 方向三：本仓在一个事务里写入、更新、删除，再由外部引擎核对最终状态与唯一约束。
  const ledgerRows = Array.from({ length: ROWS }, (_, index) => ({
    id: index + 1,
    label: `entry-${index + 1}`,
    score: (index + 1) / 2,
  }));
  const updated = new Map(ledgerRows.slice(0, 50).map((row) => [row.id, row.score + 5]));
  const removed = new Set(ledgerRows.slice(800).map((row) => row.id));

  const ledger = join(folder, "ledger.sqlite3");
  const ledgerWriter = createWriter(PAGE_SIZE);
  ledgerWriter.createTable("ledger", JSON.stringify(columns));
  ledgerWriter.createIndex("uq_ledger_label", "ledger", ["label"], true);
  ledgerWriter.begin();
  for (const row of ledgerRows) ledgerWriter.insert("ledger", JSON.stringify([row.id, row.label, row.score]));
  for (const [rowid, score] of updated) {
    ledgerWriter.update("ledger", rowid, JSON.stringify([{ keep: true }, { keep: true }, { set: score }]));
  }
  for (const rowid of removed) ledgerWriter.delete("ledger", rowid);
  ledgerWriter.commit();
  ledgerWriter.save(ledger);

  const ledgerExternal = new Database(ledger, { readonly: true });
  const ledgerRowsRead = ledgerExternal
    .prepare("SELECT id, label, score FROM ledger ORDER BY id")
    .all() as { id: number; label: string; score: number }[];
  const distinct = ledgerExternal.prepare("SELECT count(DISTINCT label) AS total FROM ledger").get() as { total: number };
  const ledgerIntegrity = ledgerExternal.pragma("integrity_check", { simple: true });
  ledgerExternal.close();

  if (ledgerIntegrity !== "ok") throw new Error(`integrity_check failed after transaction: ${ledgerIntegrity}`);
  if (ledgerRowsRead.length !== ROWS - removed.size) {
    throw new Error(`external read ${ledgerRowsRead.length} rows, expected ${ROWS - removed.size}`);
  }
  if (distinct.total !== ledgerRowsRead.length) {
    throw new Error(`external read ${distinct.total} distinct labels for ${ledgerRowsRead.length} rows`);
  }
  for (const row of ledgerRows) {
    if (removed.has(row.id)) continue;
    const observed = ledgerRowsRead.find((candidate) => candidate.id === row.id);
    const score = updated.get(row.id) ?? row.score;
    if (observed === undefined || observed.label !== row.label || observed.score !== score) {
      throw new Error(`transactional update/delete mismatch at id=${row.id}: ${JSON.stringify(observed)}`);
    }
  }

  const duplicate = new Database(ledger);
  let rejected = false;
  try {
    duplicate.exec("INSERT INTO ledger (id, label, score) VALUES (2000, 'entry-1', 1.0)");
  } catch {
    rejected = true;
  } finally {
    duplicate.close();
  }
  if (!rejected) throw new Error("external engine accepted a duplicate label despite the unique index");

  // 方向四：本仓 rollback 之后的数据库不包含事务里的行。
  const rolled = join(folder, "rolled.sqlite3");
  const rollbackWriter = createWriter(PAGE_SIZE);
  rollbackWriter.createTable("items", JSON.stringify(columns));
  rollbackWriter.begin();
  for (const row of expected.slice(0, 10)) {
    rollbackWriter.insert("items", JSON.stringify([row.id, row.label, row.score]));
  }
  rollbackWriter.rollback();
  rollbackWriter.save(rolled);

  const rolledExternal = new Database(rolled, { readonly: true });
  const rolledRows = rolledExternal.prepare("SELECT count(*) AS total FROM items").get() as { total: number };
  const rolledIntegrity = rolledExternal.pragma("integrity_check", { simple: true });
  rolledExternal.close();

  if (rolledIntegrity !== "ok") throw new Error(`integrity_check failed after rollback: ${rolledIntegrity}`);
  if (rolledRows.total !== 0) throw new Error(`rolled back database kept ${rolledRows.total} rows`);

  console.log(`ok sqlite.ts examples: ${ROWS} rows verified in both directions, mutations and rollback confirmed`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
