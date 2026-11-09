// object/raw/pluck 行投影。投影是 JS 形状决定，值本身来自原生忠实映射。

import { SQLiteError } from "../errors.ts";
import type { NativeRunResult } from "../native/binding.ts";
import type { SQLiteRow, SQLiteValue } from "../values.ts";

export type ResultView = "object" | "raw" | "pluck";

/** 把结果第 `index` 行投影成当前视图形状。 */
export function projectRow(result: NativeRunResult, view: ResultView, index: number): SQLiteValue | SQLiteRow | SQLiteValue[] {
  const row = result.rows[index]!;
  if (view === "raw") return row;
  if (view === "pluck") return row[0] ?? null;
  const labels = result.columns;
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      throw new SQLiteError("duplicate-column", `duplicate result label "${label}"; disambiguate with AS or use .raw()/.pluck()`);
    }
    seen.add(label);
  }
  const object: Record<string, SQLiteValue> = {};
  for (let column = 0; column < labels.length; column += 1) {
    object[labels[column]!] = row[column] ?? null;
  }
  return object;
}
