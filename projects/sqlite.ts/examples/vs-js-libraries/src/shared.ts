import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecodedValue } from "../../../packages/sqlite/src/index.ts";

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
