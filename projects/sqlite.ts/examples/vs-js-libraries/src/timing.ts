// Timing helpers for the cross-library benchmark. Median and p95 are computed
// by `database.harness` through the napi primitive `harnessBenchSummary`
// (middle-two median, nearest-rank p95 — the same formulas this file carried
// before, now pinned to the shared golden vectors).

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { NATIVE_ARTIFACTS } from "../../../../../scripts/native-artifacts.mjs";

export function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

interface BenchStats {
  readonly medianMs: number;
  readonly p95Ms: number;
}

const timingArtifact = NATIVE_ARTIFACTS.find(
  (entry) => entry.hostPlatform === process.platform && entry.hostArch === process.arch,
);
if (!timingArtifact) throw new Error(`没有 ${process.platform}-${process.arch} 的 SQLite 原生包映射`);

const timingAddon = createRequire(import.meta.url)(
  fileURLToPath(new URL(`../../../platforms/${timingArtifact.pkg}/${timingArtifact.fileName}`, import.meta.url)),
) as { harnessBenchSummary: (samplesMs: number[]) => BenchStats };

export function median(samples: number[]): number {
  return timingAddon.harnessBenchSummary(samples).medianMs;
}

export function p95(samples: number[]): number {
  return timingAddon.harnessBenchSummary(samples).p95Ms;
}

export function throughput(rows: number, ms: number): string {
  if (ms <= 0) return "n/a";
  return `${Math.round((rows / ms) * 1_000).toLocaleString("en-US")}/s`;
}
