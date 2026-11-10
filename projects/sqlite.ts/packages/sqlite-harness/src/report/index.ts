// 报告能力模块：把判定结果渲染为稳定文本与图表。
//
// 渲染算法在上游 `database.harness`，本模块只组织作者面调用与落盘时机，
// 不实现第二套渲染，也不做 `JSON.stringify` / `JSON.parse`（线协议收在
// `native/binding.ts`）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderBenchChart, type BenchRow } from "../native/binding.ts";

export { renderBenchChart, renderReport } from "../native/binding.ts";
export type { BenchRow, ReportEnvelope } from "../native/binding.ts";

/** 把一组基准报告行渲染为 median 与 p95 两张分组柱图写入 `dir`，返回文件路径。 */
export function writeBenchCharts(
  rows: readonly BenchRow[],
  options: { readonly dir: string; readonly medianTitle: string; readonly p95Title: string },
): { readonly median: string; readonly p95: string } {
  mkdirSync(options.dir, { recursive: true });
  const median = join(options.dir, "bench-median.svg");
  const p95 = join(options.dir, "bench-p95.svg");
  writeFileSync(median, renderBenchChart(rows, "median", options.medianTitle), "utf8");
  writeFileSync(p95, renderBenchChart(rows, "p95", options.p95Title), "utf8");
  return { median, p95 };
}
