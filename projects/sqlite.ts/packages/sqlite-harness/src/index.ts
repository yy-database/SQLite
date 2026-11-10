// 正式 harness API：判定、统计、台账、门禁、报告与 fuzz 的作者面。
//
// 原生接合在 `native/binding.ts`（私有），CLI 入口在 `cli/main.ts`。本文件
// 只暴露结构化能力面：比较、统计、收缩、台账与门禁算法全部在上游
// `database.harness`（经 N-API 出口），这里不实现第二套判定，也不暴露加载器细节。

export {
  benchPerOp,
  benchSummary,
  checkBaseline,
  classify,
  compare,
  digest,
  digestJson,
  evaluateGate,
  fuzzEnvelopeText,
  fuzzGenerate,
  fuzzRender,
  fuzzShrinkNext,
  fuzzShrinkReport,
  fuzzShrinkStart,
} from "./native/binding.ts";

export { renderBenchChart, renderReport, writeBenchCharts } from "./report/index.ts";

export type {
  Baseline,
  BaselineIdentity,
  BaselineProblem,
  BaselineSignal,
  BaselineVerdict,
  BenchRow,
  BenchStats,
  Cell,
  Comparison,
  CompareMode,
  CorpusReport,
  CorpusSpec,
  DifferenceClass,
  DifferenceObservation,
  Digest,
  ErrorShape,
  Floor,
  FuzzInput,
  FuzzPlan,
  GatePolicy,
  GateProblem,
  GateVerdict,
  Grammar,
  KnownDifference,
  Metric,
  Observed,
  ObservedBody,
  OracleQualification,
  ReportEnvelope,
  Rule,
  ShrinkMove,
  ShrinkSession,
  ShrinkStep,
  SlotPool,
  SuiteReport,
  SuiteTally,
  Symbol,
  TraceEntry,
  TruthProvenance,
} from "./native/binding.ts";
