// 基准计时与统计。median/p95 走上游 `database.harness` 的基准统计（与产品共用 `.node`），
// 不在本地重写统计算法；空样本等非法输入由上游拒绝，不返回貌似成功的 0/NaN。

import { harnessAddon } from "../../../packages/sqlite-harness/src/util.ts";

export function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

export function median(samples: number[]): number {
  return harnessAddon().harnessBenchSummary(samples).medianMs;
}

export function p95(samples: number[]): number {
  return harnessAddon().harnessBenchSummary(samples).p95Ms;
}

export function throughput(rows: number, ms: number): string {
  if (ms <= 0) return "n/a";
  return `${Math.round((rows / ms) * 1_000).toLocaleString("en-US")}/s`;
}
