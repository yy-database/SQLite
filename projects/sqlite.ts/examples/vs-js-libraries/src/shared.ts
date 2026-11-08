import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RecordValue } from "../../../packages/sqlite/src/index.ts";

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

export function column(value: RecordValue): unknown {
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
      return Buffer.from(value.valueBlob ?? []);
    default:
      throw new Error(`unknown column kind ${(value as RecordValue).kind}`);
  }
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
