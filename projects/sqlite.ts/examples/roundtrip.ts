// 下游验收示例：本仓 writer / reader 与真实 SQLite 引擎的写读双向核对。
//
// 期望值全部来自外部引擎（better-sqlite3 与 `PRAGMA integrity_check`），不读取
// 本仓任何内部常量。运行：`pnpm --dir projects/sqlite.ts examples`

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriter, openDatabase, type RecordValue } from "../src/index.ts";

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

  console.log(`ok sqlite.ts examples: ${ROWS} rows verified in both directions`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
