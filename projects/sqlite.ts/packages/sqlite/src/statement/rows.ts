// object/raw/pluck 行投影。投影是 JS 形状决定，值本身来自原生忠实映射。

import { SQLiteError } from "../errors.ts";
import type { NativeCell } from "../native/binding.ts";
import type { SQLiteRow, SQLiteValue } from "../values.ts";

export type ResultView = "object" | "raw" | "pluck";

/** 行投影只需要表头与当前行缓冲，单次执行结果与游标窗口都满足。 */
export interface ResultRows {
  columns: string[];
  rows: NativeCell[][];
}

/**
 * 校验结果表头没有重名列。
 *
 * object 视图用它把重名列报成 `duplicate-column`；校验结果与表头一一对应，
 * 因此一次执行只需做一次——批量投影不再为每行重建一个 `Set`。
 */
export function assertUniqueLabels(labels: string[]): void {
  if (labels.length < 2) return;
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      throw new SQLiteError("duplicate-column", `duplicate result label "${label}"; disambiguate with AS or use .raw()/.pluck()`);
    }
    seen.add(label);
  }
}

/**
 * 把结果第 `index` 行投影成当前视图形状。
 *
 * `labelsChecked` 表示调用方已经对本结果的表头跑过 {@link assertUniqueLabels}，
 * 批量投影因此只在首行之前校验一次。
 */
export function projectRow(result: ResultRows, view: ResultView, index: number, labelsChecked = false): SQLiteValue | SQLiteRow | SQLiteValue[] {
  const row = result.rows[index]!;
  if (view === "raw") return row;
  if (view === "pluck") return row[0] ?? null;
  const labels = result.columns;
  if (!labelsChecked) assertUniqueLabels(labels);
  const object: Record<string, SQLiteValue> = {};
  for (let column = 0; column < labels.length; column += 1) {
    object[labels[column]!] = row[column] ?? null;
  }
  return object;
}
