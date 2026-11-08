// 影子比对：让既有 corpus 台账与新的 `database.harness` napi 原语吃同一份输入，
// 只比较规范化之后的输出，不改动任何调用方。
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { NATIVE_ARTIFACTS } from "../../../../../scripts/native-artifacts.mjs";
import {
  checkBaseline,
  entryKey,
  generate,
  identityProblems,
  loadBaseline,
  type BaselineEntry,
  type BaselineFile,
  type ObservedDifference,
} from "./corpus.ts";

const artifact = NATIVE_ARTIFACTS.find(
  (entry) => entry.hostPlatform === process.platform && entry.hostArch === process.arch,
);
if (!artifact) throw new Error(`没有 ${process.platform}-${process.arch} 的 SQLite 原生包映射`);

const require = createRequire(import.meta.url);
const addon = require(
  fileURLToPath(new URL(`../../../platforms/${artifact.pkg}/${artifact.fileName}`, import.meta.url)),
) as {
  harnessDigest?: (bytes: Buffer) => string;
  harnessCheckBaseline?: (baseline: string, current: string, observed: string) => string;
  harnessRenderReport?: (report: string) => string;
};

for (const name of ["harnessDigest", "harnessCheckBaseline", "harnessRenderReport"] as const) {
  if (typeof addon[name] !== "function") {
    throw new Error(`原生包缺少 ${name} 导出，请先运行 build:napi`);
  }
}

const baseline = loadBaseline();
const canonical = JSON.stringify(
  generate(baseline.seed, baseline.count).map((item) => [item.cluster, item.sql, item.check ?? null]),
);
const legacyDigest = createHash("sha256").update(canonical).digest("hex");
const harnessDigest = addon.harnessDigest!(Buffer.from(canonical));
const digestEqual = legacyDigest === harnessDigest && harnessDigest === baseline.digest;

type RawObservation = {
  readonly entry: BaselineEntry;
  readonly id: number;
  readonly cluster: BaselineEntry["cluster"];
  readonly sql: string;
  readonly check: string | null;
  readonly kind: BaselineEntry["kind"];
  readonly better: { readonly rows: readonly never[]; readonly checkRows: readonly never[] };
  readonly python: { readonly rows: readonly never[]; readonly checkRows: readonly never[] };
};

const emptySide = { rows: [], checkRows: [] } as const;

function observed(entry: BaselineEntry, overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    entry,
    id: entry.id,
    cluster: entry.cluster,
    sql: entry.sql,
    check: entry.check,
    kind: entry.kind,
    better: emptySide,
    python: emptySide,
    ...overrides,
  };
}

function oldKind(text: string): string {
  if (text.startsWith("seed: ")) return "seed-drift";
  if (text.startsWith("count: ")) return "count-drift";
  if (text.startsWith("corpus digest: ")) return "digest-drift";
  if (text.startsWith("unexpected difference")) return "unlisted";
  if (text.startsWith("known difference changed shape")) return "signal-changed";
  if (text.startsWith("baseline entry no longer differs")) return "stale";
  return "unknown";
}

function ledgerRequest(file: BaselineFile, observations: readonly RawObservation[]) {
  return {
    baseline: {
      identity: {
        spec: { version: file.version, seed: file.seed, count: file.count },
        digest: file.digest,
      },
      entries: file.entries.map((entry) => ({
        key: entryKey(entry),
        signal: [...entry.signal],
        reason: entry.reason,
      })),
    },
    observed: observations.map((item) => ({
      key: entryKey(item.entry),
      signal: [...item.entry.signal],
      reason: item.entry.reason,
    })),
  };
}

function runScenario(
  name: string,
  observations: readonly RawObservation[],
  options: { seed: number; count: number },
  currentDigest: string,
) {
  const request = ledgerRequest(baseline, observations);
  const current = {
    spec: { version: baseline.version, seed: options.seed, count: options.count },
    digest: currentDigest,
  };
  const legacyIdentity = identityProblems(baseline, options as never, currentDigest);
  const legacyLedger = checkBaseline(baseline, observations as ObservedDifference[]);
  const legacyProblems = [...legacyIdentity, ...legacyLedger.problems].map(oldKind);
  const verdict = JSON.parse(addon.harnessCheckBaseline!(
    JSON.stringify(request.baseline),
    JSON.stringify(current),
    JSON.stringify(request.observed),
  )) as { matched: number; problems: Array<{ kind: string }> };
  const legacy = JSON.stringify({ matched: legacyLedger.matched, problems: legacyProblems });
  const harness = JSON.stringify({
    matched: verdict.matched,
    problems: verdict.problems.map((problem) => problem.kind),
  });
  return { name, equal: legacy === harness, legacy, harness, verdict };
}

const entries = baseline.entries;
const first = entries[0];
if (!first) throw new Error("baseline 没有条目，无法做影子比对");

const clean = entries.map((entry) => observed(entry));
const unlisted = [
  ...clean,
  observed(first, {
    entry: { ...first, id: first.id + 100000, sql: `${first.sql} -- shadow` },
    id: first.id + 100000,
    sql: `${first.sql} -- shadow`,
  }),
];
const signalChanged = clean.map((item, index) =>
  index === 0
    ? observed(first, { entry: { ...first, signal: [...first.signal, "shadow-signal"] } })
    : item,
);
const stale = clean.slice(0, -1);

const scenarios = [
  runScenario("clean", clean, { seed: baseline.seed, count: baseline.count }, baseline.digest),
  runScenario("unlisted", unlisted, { seed: baseline.seed, count: baseline.count }, baseline.digest),
  runScenario(
    "signal-changed",
    signalChanged,
    { seed: baseline.seed, count: baseline.count },
    baseline.digest,
  ),
  runScenario("stale", stale, { seed: baseline.seed, count: baseline.count }, baseline.digest),
  runScenario("identity-drift", clean, { seed: baseline.seed + 1, count: baseline.count + 1 }, "0".repeat(64)),
];

const report = {
  version: 1,
  command: "corpus",
  corpus: {
    spec: { version: baseline.version, seed: baseline.seed, count: baseline.count },
    digest: baseline.digest,
    matched: scenarios[0]!.verdict.matched,
    problems: scenarios[0]!.verdict.problems,
    clean: scenarios[0]!.verdict.problems.length === 0,
  },
};
const legacyReport = `${JSON.stringify(report, null, 2)}\n`;
const harnessReport = addon.harnessRenderReport!(JSON.stringify(report));
const reportEqual = legacyReport === harnessReport;

const ok = digestEqual && scenarios.every((scenario) => scenario.equal) && reportEqual;
console.log(
  JSON.stringify(
    {
      ok,
      digest: { legacy: legacyDigest, harness: harnessDigest, baseline: baseline.digest },
      scenarios: scenarios.map(({ name, equal, legacy, harness }) => ({ name, equal, legacy, harness })),
      report: { equal: reportEqual },
    },
    null,
    2,
  ),
);
if (!ok) process.exit(1);
