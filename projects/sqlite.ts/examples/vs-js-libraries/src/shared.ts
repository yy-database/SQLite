import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecodedValue, NativeDatabase } from "../../../packages/sqlite/src/index.ts";

export const PAGE_SIZE = 4096;
export const ROWS = 64;

export const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
]);

export type ExpectedRow = {
  id: number;
  label: string;
  score: number;
};

// 存储类别由 JS 类型表达：bigint 整数、number 实数、string 文本、Buffer blob、null 空值。
export function column(value: DecodedValue): unknown {
  if (value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}

export function expectedRows(): ExpectedRow[] {
  return Array.from({ length: ROWS }, (_, index) => ({
    id: index + 1,
    label: `row-${index + 1}`,
    score: (index + 1) / 4,
  }));
}

// 新 reader API 的双向读回断言:点查命中/未命中 + 闭区间窗口,与 peer 写入的内容一致。
export function verifyPointAndRange(reader: NativeDatabase, rows: ExpectedRow[]): void {
  for (const row of [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]]) {
    const hit = reader.rowByRowid("items", row.id);
    if (hit === null || hit.length !== 1) throw new Error(`rowByRowid miss id=${row.id}`);
    const cells = hit[0].columns.map(column);
    if (Number(hit[0].rowid) !== row.id || cells[1] !== row.label || cells[2] !== row.score) {
      throw new Error(`rowByRowid mismatch id=${row.id}: rowid=${hit[0].rowid} cells=${JSON.stringify(cells)}`);
    }
  }
  if (reader.rowByRowid("items", 999_999) !== null) throw new Error("rowByRowid must miss an absent rowid");
  const window = reader.range("items", rows[4].id, rows[9].id);
  if (window.length !== 6) throw new Error(`range returned ${window.length} rows, expected 6`);
  for (const [offset, hit] of window.entries()) {
    if (Number(hit.rowid) !== rows[4 + offset].id) throw new Error(`range order mismatch at offset ${offset}`);
  }
}

export function workspace(prefix: string): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
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
