// 绑定接合层：上游 `database.harness` 的能力经 N-API 以 JSON 文本进出。
//
// 本文件是该包唯一对 addon 线协议做 `JSON.stringify` / `JSON.parse` 的地方：
// 上层拿到的是结构化对象，不再手写序列化。比较、统计、收缩、台账与门禁算法
// 全部在上游 Rust 侧，这里只做类型转换与字段命名适配，不实现第二份判定逻辑。
//
// 与 `sqlite` 包并列：两者消费同一个 `.node`，产品面走 `SqliteConnection` 等句柄，
// harness 面走这里的 `harness*` 函数。能力缺失时直接抛错，不回退 JS。

import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export type PlatformKey = "win32-x64" | "linux-x64" | "darwin-x64" | "darwin-arm64";

/** 把 Node 平台与架构映射到平台包后缀。 */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

// 绑定由平台包 `main` 给出，`scripts/build-napi.mjs` 负责落地。经包入口解析，
// 缺构建时得到平台错误而不是裸 `MODULE_NOT_FOUND`；调用方不拼接 `.node` 文件名。
export function nativeModulePath(): string {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  return require.resolve(`@yydb/sqlite-${key}`);
}

// ---- 上游 serde 形态 ----

/** SHA-256 摘要的小写十六进制。 */
export type Digest = string;

/** 语料参数。 */
export interface CorpusSpec {
  readonly version: number;
  readonly seed: number;
  readonly count: number;
}

/** 期望值的来源。 */
export type TruthProvenance =
  | { readonly kind: "external_engine"; readonly id: string; readonly version: string }
  | { readonly kind: "official_corpus"; readonly id: string; readonly digest: Digest }
  | { readonly kind: "frozen_baseline"; readonly id: string; readonly digest: Digest };

/** 行集合里的单元格（serde 外部标签形态）。 */
export type Cell =
  | "null"
  | { readonly bool: boolean }
  | { readonly int: number }
  | { readonly float: number }
  | { readonly text: string }
  | { readonly blob: number[] };

/** 错误结构。 */
export interface ErrorShape {
  readonly fields: Readonly<Record<string, string>>;
}

/** 一次观测的载荷。 */
export type ObservedBody =
  | { readonly kind: "rows"; readonly rows: Cell[][] }
  | { readonly kind: "wire"; readonly bytes: number[] }
  | { readonly kind: "error"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "unavailable"; readonly code: string; readonly reason: string };

/** 一侧的观测值：来源（仅期望侧需要）加载荷。 */
export interface Observed {
  readonly provenance: TruthProvenance | null;
  readonly body: ObservedBody;
}

/** 比较模式，由调用方声明。 */
export type CompareMode =
  | { readonly kind: "exact" }
  | { readonly kind: "structured_fields"; readonly fields: readonly string[] }
  | { readonly kind: "wire_hex" };

/** 一条具体差异。 */
export type Diff =
  | { readonly kind: "body_kind"; readonly expected: string; readonly actual: string }
  | { readonly kind: "row_count"; readonly expected: number; readonly actual: number }
  | { readonly kind: "column_count"; readonly row: number; readonly expected: number; readonly actual: number }
  | { readonly kind: "row_cell"; readonly row: number; readonly column: number; readonly expected: Cell; readonly actual: Cell }
  | { readonly kind: "wire_length"; readonly expected: number; readonly actual: number }
  | { readonly kind: "wire_byte"; readonly offset: number; readonly expected: string; readonly actual: string }
  | { readonly kind: "error_field"; readonly field: string; readonly expected: string | null; readonly actual: string | null }
  | { readonly kind: "unavailable_code"; readonly expected: string; readonly actual: string };

/** 一次比对的完整结果。 */
export interface Comparison {
  readonly matched: boolean;
  /** 期望侧缺少来源标记时为真，此时即使一致也不计通过。 */
  readonly unverified: boolean;
  /** 任一侧不可用时的执行状态证据；不可用不是值语义通过。 */
  readonly unavailable: { readonly expected: string | null; readonly actual: string | null } | null;
  readonly signal: readonly string[];
  readonly diffs: readonly Diff[];
  readonly truncated: boolean;
}

/** 差异归类。 */
export type DifferenceClass =
  | { readonly kind: "clean" }
  | { readonly kind: "unverified" }
  | { readonly kind: "unavailable"; readonly expected: string | null; readonly actual: string | null }
  | { readonly kind: "known"; readonly key: string; readonly reason: string }
  | { readonly kind: "unlisted" };

/** 基线中的一条已知差异。 */
export interface KnownDifference {
  readonly key: string;
  readonly signal: readonly string[];
  readonly reason: string;
}

/** 本次运行中实际观测到的一条差异。 */
export interface DifferenceObservation {
  readonly key: string;
  readonly signal: readonly string[];
  readonly reason: string;
}

/** 基线声明的身份。 */
export interface BaselineIdentity {
  readonly spec: CorpusSpec;
  readonly digest: Digest;
}

/** 一条完整基线。 */
export interface Baseline {
  readonly identity: BaselineIdentity;
  readonly entries: readonly KnownDifference[];
}

/** 台账判定问题（kebab-case 判别值，与既有线名逐字节对齐）。 */
export type BaselineProblem =
  | { readonly kind: "version-drift"; readonly baseline: number; readonly current: number }
  | { readonly kind: "seed-drift"; readonly baseline: number; readonly current: number }
  | { readonly kind: "count-drift"; readonly baseline: number; readonly current: number }
  | { readonly kind: "digest-drift"; readonly baseline: string; readonly current: string }
  | { readonly kind: "unlisted"; readonly key: string; readonly signal: readonly string[]; readonly reason: string }
  | { readonly kind: "signal-changed"; readonly key: string; readonly baseline: readonly string[]; readonly current: readonly string[] }
  | { readonly kind: "stale"; readonly key: string; readonly signal: readonly string[]; readonly reason: string };

/** 台账判定结果。 */
export interface BaselineVerdict {
  readonly matched: number;
  readonly problems: readonly BaselineProblem[];
}

/** 门禁的执行状态计数。 */
export interface SuiteTally {
  readonly cases: number;
  readonly assertions: number;
  readonly attempts: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly unverified: number;
  readonly unavailable: number;
  readonly timed_out: number;
  readonly cancelled: number;
  readonly crashed: number;
  readonly not_run: number;
}

/** floor 指标。 */
export type Metric = "cases" | "assertions" | "passed";

/** 一条 floor。 */
export interface Floor {
  readonly metric: Metric;
  readonly min: number;
}

/** oracle 资格。 */
export interface OracleQualification {
  readonly required: boolean;
  readonly available: boolean;
  readonly provenance: string | null;
}

/** 基线信号。 */
export type BaselineSignal = "none" | "matched" | "stale" | "unlisted" | "changed";

/** 一个用例的最终状态。 */
export type CaseOutcome =
  | "passed"
  | "failed"
  | "skipped"
  | "unverified"
  | "unavailable"
  | "timed_out"
  | "cancelled"
  | "crashed"
  | "not_run";

/** 一个用例的一次执行记录。 */
export interface CaseRecord {
  readonly case: string;
  readonly attempt: number;
  readonly outcome: CaseOutcome;
}

/** 一个 suite 进门禁所需的全部证据。 */
export interface SuiteReport {
  readonly name: string;
  readonly tally: SuiteTally;
  /** 逐用例证据；完整验收必须提供。 */
  readonly cases?: readonly CaseRecord[];
  readonly floors: readonly Floor[];
  readonly oracle: OracleQualification;
  readonly baseline: BaselineSignal;
}

/** 门禁策略。 */
export interface GatePolicy {
  readonly allow_partial?: boolean;
  readonly allow_skipped?: boolean;
  readonly allow_empty_suites?: boolean;
  readonly require_case_evidence?: boolean;
  readonly required_suites?: readonly string[];
}

/** 门禁问题（kebab-case 判别值）。 */
export type GateProblem =
  | { readonly kind: "tally-inconsistent"; readonly suite: string; readonly cases: number; readonly counted: number }
  | { readonly kind: "empty-suite"; readonly suite: string }
  | { readonly kind: "duplicate-suite"; readonly suite: string }
  | { readonly kind: "missing-case-evidence"; readonly suite: string }
  | { readonly kind: "duplicate-case"; readonly suite: string; readonly case: string; readonly attempt: number }
  | { readonly kind: "case-tally-mismatch"; readonly suite: string; readonly field: string; readonly declared: number; readonly derived: number }
  | { readonly kind: "failed"; readonly suite: string; readonly count: number }
  | { readonly kind: "skipped"; readonly suite: string; readonly count: number }
  | { readonly kind: "unverified"; readonly suite: string; readonly count: number }
  | { readonly kind: "unavailable"; readonly suite: string; readonly count: number }
  | { readonly kind: "timed-out"; readonly suite: string; readonly count: number }
  | { readonly kind: "cancelled"; readonly suite: string; readonly count: number }
  | { readonly kind: "crashed"; readonly suite: string; readonly count: number }
  | { readonly kind: "not-run"; readonly suite: string; readonly count: number }
  | { readonly kind: "oracle-unavailable"; readonly suite: string }
  | { readonly kind: "missing-evidence"; readonly suite: string }
  | { readonly kind: "baseline-stale"; readonly suite: string }
  | { readonly kind: "baseline-unlisted"; readonly suite: string }
  | { readonly kind: "baseline-changed"; readonly suite: string }
  | { readonly kind: "floor-unmet"; readonly suite: string; readonly metric: Metric; readonly min: number; readonly actual: number }
  | { readonly kind: "missing-suite"; readonly suite: string };

/** 门禁判定结果。 */
export interface GateVerdict {
  readonly ok: boolean;
  readonly problems: readonly GateProblem[];
}

/** 基准统计（N-API 对象已是 camelCase）。 */
export interface BenchStats {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly rounds: number;
}

/** 一行基准报告；`reference` 为空表示有意不配对照。 */
export interface BenchRow {
  readonly workload: string;
  readonly unit: string;
  readonly ours: BenchStats;
  readonly reference: BenchStats | null;
  readonly referenceEngine: string | null;
}

/** 产生式符号。 */
export type Symbol =
  | { readonly literal: string }
  | { readonly slot: { readonly pool: string } }
  | { readonly rule: string }
  | { readonly typed: string };

/** 一条产生式规则。 */
export interface Rule {
  readonly id: string;
  readonly type_tag: string;
  readonly alternatives: readonly (readonly Symbol[])[];
}

/** 命名槽位池。 */
export interface SlotPool {
  readonly name: string;
  readonly values: readonly string[];
}

/** 完整语法。 */
export interface Grammar {
  readonly version: number;
  readonly start: string;
  readonly rules: readonly Rule[];
  readonly pools: readonly SlotPool[];
}

/** 生成参数。 */
export interface FuzzPlan {
  readonly seed: number;
  readonly depth: number;
  readonly count: number;
}

/** 复现信封中的一个决策点。 */
export interface TraceEntry {
  readonly rule: string;
  readonly alternative: number;
  readonly choices: number;
}

/** 一条可复现的生成输入。 */
export interface FuzzInput {
  readonly seed: number;
  readonly grammar_version: number;
  readonly depth: number;
  readonly count: number;
  readonly trace: readonly TraceEntry[];
}

/** 一条收缩候选动作。 */
export interface ShrinkMove {
  readonly kind: "reduce_count" | "lower_alternative";
  readonly count: number;
  readonly point: number;
  readonly alternative: number;
}

/** 收缩状态机。 */
export interface ShrinkSession {
  readonly base: FuzzInput;
  readonly moves: readonly ShrinkMove[];
  readonly cursor: number;
  readonly pending: FuzzInput | null;
  readonly done: boolean;
}

/** 统一报告信封。 */
export interface CorpusReport {
  readonly spec: CorpusSpec;
  readonly digest: Digest;
  readonly matched: number;
  readonly problems: readonly BaselineProblem[];
  readonly clean: boolean;
}

/** 报告信封：只承载判定结果，不承载期望值。 */
export interface ReportEnvelope {
  readonly version: number;
  readonly command: string;
  readonly corpus: CorpusReport | null;
}

/** 收缩推进结果：`candidate` 为空表示动作队列耗尽。 */
export interface ShrinkStep {
  readonly session: ShrinkSession;
  readonly candidate: readonly [FuzzInput, readonly string[]] | null;
}

// ---- 原生模块 ----

interface HarnessAddon {
  harnessDigest(bytes: Uint8Array): string;
  harnessCheckBaseline(baselineJson: string, currentJson: string, observedJson: string): string;
  harnessRenderReport(reportJson: string): string;
  harnessCompare(expectedJson: string, actualJson: string, modeJson: string): string;
  harnessClassify(comparisonJson: string, caseKey: string | null, knownJson: string): string;
  harnessEvaluateGate(inputJson: string): string;
  harnessBenchSummary(samplesMs: number[]): BenchStats;
  harnessBenchPerOp(stats: BenchStats, ops: number): number;
  harnessRenderBenchChart(rowsJson: string, metric: string, title: string): string;
  harnessFuzzGenerate(grammarJson: string, planJson: string): string;
  harnessFuzzRender(grammarJson: string, inputJson: string): string;
  harnessFuzzShrinkStart(grammarJson: string, inputJson: string): string;
  harnessFuzzShrinkNext(grammarJson: string, sessionJson: string): string;
  harnessFuzzShrinkReport(sessionJson: string, failing: boolean): string;
}

let cached: HarnessAddon | null = null;

function addon(): HarnessAddon {
  if (cached) return cached;
  let loaded: HarnessAddon & { default?: HarnessAddon };
  try {
    loaded = require(nativeModulePath()) as HarnessAddon & { default?: HarnessAddon };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite harness addon not available; run \`node scripts/build-napi.mjs\`. ${message}`);
  }
  cached = loaded.default ?? loaded;
  return cached;
}

// ---- 作者面：结构化进出，序列化收在本文件内部 ----

/** 对给定字节取 SHA-256，返回小写十六进制。 */
export function digest(bytes: Uint8Array): Digest {
  return addon().harnessDigest(bytes);
}

/** 对结构化数据的规范 JSON 文本取摘要（语料摘要与台账键的字节口径）。 */
export function digestJson(value: unknown): Digest {
  return digest(Buffer.from(canonicalJson(value)));
}

/**
 * 规范 JSON：对象键按字典序排列，数组保序，拒绝无法稳定表示的值。
 *
 * 语料身份不能依赖对象字段的插入顺序；非有限数与 bigint 会静默变成
 * `null` 或抛错，必须在入口明确拒绝，避免同一语料得到两个摘要。
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON refuses non-finite number: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") throw new Error("canonical JSON refuses bigint; encode it as a string first");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON refuses ${typeof value}`);
}

/** 按已知差异台账判定一次语料运行。 */
export function checkBaseline(
  baseline: Baseline,
  current: BaselineIdentity,
  observed: readonly DifferenceObservation[],
): BaselineVerdict {
  return JSON.parse(addon().harnessCheckBaseline(JSON.stringify(baseline), JSON.stringify(current), JSON.stringify(observed))) as BaselineVerdict;
}

/** 将报告信封渲染为稳定 JSON 文本。 */
export function renderReport(report: ReportEnvelope): string {
  return addon().harnessRenderReport(JSON.stringify(report));
}

/** 按指定模式比对两侧观测值。 */
export function compare(expected: Observed, actual: Observed, mode: CompareMode): Comparison {
  return JSON.parse(addon().harnessCompare(JSON.stringify(expected), JSON.stringify(actual), JSON.stringify(mode))) as Comparison;
}

/** 把一次比对结果对照已知差异台账归类；`caseKey` 必须对应当前用例。 */
export function classify(comparison: Comparison, caseKey: string | null, known: readonly KnownDifference[]): DifferenceClass {
  return JSON.parse(addon().harnessClassify(JSON.stringify(comparison), caseKey, JSON.stringify(known))) as DifferenceClass;
}

/** 门禁判定：消费执行状态、oracle 资格、证据与 floors，失败关闭。 */
export function evaluateGate(input: { readonly suites: readonly SuiteReport[]; readonly policy: GatePolicy }): GateVerdict {
  return JSON.parse(addon().harnessEvaluateGate(JSON.stringify(input))) as GateVerdict;
}

/** 对一组毫秒样本求 median/p95/极值。 */
export function benchSummary(samplesMs: readonly number[]): BenchStats {
  return addon().harnessBenchSummary([...samplesMs]);
}

/** 单次操作的归一毫秒；`ops` 为 0 时返回 NaN。 */
export function benchPerOp(stats: BenchStats, ops: number): number {
  return addon().harnessBenchPerOp(stats, ops);
}

/** 把基准报告行渲染为分组柱图 SVG。 */
export function renderBenchChart(rows: readonly BenchRow[], metric: "median" | "p95", title: string): string {
  return addon().harnessRenderBenchChart(JSON.stringify(rows.map(benchRowWire)), metric, title);
}

/** 复现信封的规范文本形态；台账键与语料摘要按这些字节计算。 */
export function fuzzEnvelopeText(input: FuzzInput): string {
  return JSON.stringify(input);
}

/** 用调用方声明的语法生成一条复现信封，不含任何期望值。 */
export function fuzzGenerate(grammar: Grammar, plan: FuzzPlan): FuzzInput {
  return JSON.parse(addon().harnessFuzzGenerate(JSON.stringify(grammar), JSON.stringify(plan))) as FuzzInput;
}

/** 按复现信封重放语句序列。 */
export function fuzzRender(grammar: Grammar, input: FuzzInput): string[] {
  return JSON.parse(addon().harnessFuzzRender(JSON.stringify(grammar), JSON.stringify(input))) as string[];
}

/** 以失败输入初始化收缩状态机。 */
export function fuzzShrinkStart(grammar: Grammar, input: FuzzInput): ShrinkSession {
  return JSON.parse(addon().harnessFuzzShrinkStart(JSON.stringify(grammar), JSON.stringify(input))) as ShrinkSession;
}

/** 产出下一个收缩候选；谓词本身由调用方执行。 */
export function fuzzShrinkNext(grammar: Grammar, session: ShrinkSession): ShrinkStep {
  return JSON.parse(addon().harnessFuzzShrinkNext(JSON.stringify(grammar), JSON.stringify(session))) as ShrinkStep;
}

/** 回报当前候选是否仍失败，返回更新后的收缩状态机。 */
export function fuzzShrinkReport(session: ShrinkSession, failing: boolean): ShrinkSession {
  return JSON.parse(addon().harnessFuzzShrinkReport(JSON.stringify(session), failing)) as ShrinkSession;
}

// 核心 `BenchRow` 说 snake_case，作者面用 camelCase；只在接合层改名。
function benchRowWire(row: BenchRow): Record<string, unknown> {
  return {
    workload: row.workload,
    unit: row.unit,
    ours: statsWire(row.ours),
    reference: row.reference === null ? null : statsWire(row.reference),
    reference_engine: row.referenceEngine,
  };
}

function statsWire(stats: BenchStats): Record<string, unknown> {
  return {
    median_ms: stats.medianMs,
    p95_ms: stats.p95Ms,
    min_ms: stats.minMs,
    max_ms: stats.maxMs,
    rounds: stats.rounds,
  };
}
