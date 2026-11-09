//! 标准 harness 能力绑定：harness 判定、基准统计、图表与 fuzz 状态机。
//!
//! 这些是与产品 SQL 入口并列的正式能力，编译进同一个 `.node`，由 `sqlite-harness`
//! 包按模块导出取用；不为这个边界另造 addon，也不降为 dev-dependency。

use database::harness::chart::{BenchMetric, bench_chart_svg};
use database::harness::{
    Baseline, BaselineIdentity, BenchRow, Comparison, CompareMode, DifferenceObservation, Digest, FuzzInput, FuzzPlan, GatePolicy, Grammar,
    KnownDifference, Observed, ReportEnvelope, ShrinkSession, Stats, SuiteReport, check_baseline, classify, compare, evaluate, generate, per_op_ms,
    render, render_json, shrink_next, shrink_report, shrink_start, summarize,
};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

fn harness_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// 对给定字节取 SHA-256，返回小写十六进制。
#[napi]
pub fn harnessDigest(bytes: Buffer) -> String {
    Digest::of(bytes.as_ref()).to_hex()
}

/// 按已知差异台账判定一次语料运行。
#[napi]
pub fn harnessCheckBaseline(baseline_json: String, current_json: String, observed_json: String) -> napi::Result<String> {
    let baseline: Baseline = serde_json::from_str(&baseline_json).map_err(harness_error)?;
    let current: BaselineIdentity = serde_json::from_str(&current_json).map_err(harness_error)?;
    let observed: Vec<DifferenceObservation> = serde_json::from_str(&observed_json).map_err(harness_error)?;
    let verdict = check_baseline(&baseline, &current, &observed);
    serde_json::to_string(&verdict).map_err(harness_error)
}

/// 将报告信封渲染为稳定 JSON 文本。
#[napi]
pub fn harnessRenderReport(report_json: String) -> napi::Result<String> {
    let report: ReportEnvelope = serde_json::from_str(&report_json).map_err(harness_error)?;
    render_json(&report).map_err(harness_error)
}

/// 按指定模式比对两侧观测值，返回 `Comparison` 的 JSON。
///
/// `mode_json` 是 `CompareMode` 的 serde 形态：`{"kind":"exact"}`、
/// `{"kind":"structured_fields","fields":["code"]}` 或 `{"kind":"wire_hex"}`。
/// 期望侧缺少 `provenance` 时结果带 `unverified`，调用方不得计为通过。
#[napi]
pub fn harnessCompare(expected_json: String, actual_json: String, mode_json: String) -> napi::Result<String> {
    let expected: Observed = serde_json::from_str(&expected_json).map_err(harness_error)?;
    let actual: Observed = serde_json::from_str(&actual_json).map_err(harness_error)?;
    let mode: CompareMode = serde_json::from_str(&mode_json).map_err(harness_error)?;
    let comparison = compare(&expected, &actual, &mode);
    serde_json::to_string(&comparison).map_err(harness_error)
}

/// 把一次比对结果对照已知差异台账归类，返回 `DifferenceClass` 的 JSON。
#[napi]
pub fn harnessClassify(comparison_json: String, known_json: String) -> napi::Result<String> {
    let comparison: Comparison = serde_json::from_str(&comparison_json).map_err(harness_error)?;
    let known: Vec<KnownDifference> = serde_json::from_str(&known_json).map_err(harness_error)?;
    let class = classify(&comparison, &known);
    serde_json::to_string(&class).map_err(harness_error)
}

/// 门禁判定：消费执行状态、oracle 资格、证据与 floors，失败关闭，不用单个
/// `ok` 掩盖未验证项。`input_json` 是 `{ "suites": [SuiteReport..], "policy": GatePolicy }`
/// 的 serde 形态（核心类型 snake_case 字段），返回 `GateVerdict` 的 JSON。
/// 测试输出解析与 floor 数值由调用方提供，判定算法在此上游统一维护。
#[napi]
pub fn harnessEvaluateGate(input_json: String) -> napi::Result<String> {
    #[derive(serde::Deserialize)]
    struct GateInput {
        suites: Vec<SuiteReport>,
        #[serde(default)]
        policy: GatePolicy,
    }
    let input: GateInput = serde_json::from_str(&input_json).map_err(harness_error)?;
    let verdict = evaluate(&input.suites, &input.policy);
    serde_json::to_string(&verdict).map_err(harness_error)
}

/// 基准统计的 JS 形态。字段名由本 DTO 负责 camelCase，核心 `Stats` 说 Rust。
#[napi(object)]
pub struct BenchStatsJson {
    pub median_ms: f64,
    pub p95_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub rounds: u32,
}

impl From<Stats> for BenchStatsJson {
    fn from(stats: Stats) -> Self {
        Self { median_ms: stats.median_ms, p95_ms: stats.p95_ms, min_ms: stats.min_ms, max_ms: stats.max_ms, rounds: stats.rounds }
    }
}

/// 对一组毫秒样本求 median/p95/极值（nearest-rank，与 TS 既有实现逐字节一致）。
#[napi]
pub fn harnessBenchSummary(samples_ms: Vec<f64>) -> BenchStatsJson {
    summarize(&samples_ms).into()
}

/// 单次操作的归一毫秒（median / ops）。`ops` 为 0 时返回 NaN。
#[napi]
pub fn harnessBenchPerOp(stats: BenchStatsJson, ops: u32) -> f64 {
    per_op_ms(
        &Stats { median_ms: stats.median_ms, p95_ms: stats.p95_ms, min_ms: stats.min_ms, max_ms: stats.max_ms, rounds: stats.rounds },
        u64::from(ops),
    )
}

/// 把基准报告行渲染为分组柱图 SVG。
///
/// `rows_json` 是 `Vec<BenchRow>` 的 serde 形态（`workload` / `unit` /
/// `ours` / `reference` / `reference_engine`，`Stats` 用 `median_ms` 等
/// snake_case 键）；`metric` 取 `"median"` 或 `"p95"`。写文件的时机与路径
/// 由调用方决定，本函数只返回文本。
#[napi]
pub fn harnessRenderBenchChart(rows_json: String, metric: String, title: String) -> napi::Result<String> {
    let rows: Vec<BenchRow> = serde_json::from_str(&rows_json).map_err(harness_error)?;
    let metric = match metric.as_str() {
        "median" => BenchMetric::Median,
        "p95" => BenchMetric::P95,
        other => return Err(harness_error(format!("unknown bench chart metric `{other}`, expected `median` or `p95`"))),
    };
    bench_chart_svg(&rows, metric, &title).map_err(harness_error)
}

/// 用调用方声明的语法生成一条复现信封。
///
/// `grammar_json` 是 `Grammar` 的 serde 形态（`version` / `start` / `rules` /
/// `pools`，`Symbol` 用 `{"literal":..}`、`{"slot":{"pool":..}}`、`{"rule":..}`、
/// `{"typed":..}`）；`plan_json` 是 `FuzzPlan`（`seed` / `depth` / `count`）。
/// 返回 `FuzzInput` 的 JSON，不含任何期望值。
#[napi]
pub fn harnessFuzzGenerate(grammar_json: String, plan_json: String) -> napi::Result<String> {
    let grammar: Grammar = serde_json::from_str(&grammar_json).map_err(harness_error)?;
    let plan: FuzzPlan = serde_json::from_str(&plan_json).map_err(harness_error)?;
    let input = generate(&grammar, &plan).map_err(harness_error)?;
    serde_json::to_string(&input).map_err(harness_error)
}

/// 按复现信封重放语句序列，返回 `Vec<String>` 的 JSON。
#[napi]
pub fn harnessFuzzRender(grammar_json: String, input_json: String) -> napi::Result<String> {
    let grammar: Grammar = serde_json::from_str(&grammar_json).map_err(harness_error)?;
    let input: FuzzInput = serde_json::from_str(&input_json).map_err(harness_error)?;
    let statements = render(&grammar, &input).map_err(harness_error)?;
    serde_json::to_string(&statements).map_err(harness_error)
}

/// 以失败输入初始化收缩状态机，返回 `ShrinkSession` 的 JSON。
#[napi]
pub fn harnessFuzzShrinkStart(grammar_json: String, input_json: String) -> napi::Result<String> {
    let grammar: Grammar = serde_json::from_str(&grammar_json).map_err(harness_error)?;
    let input: FuzzInput = serde_json::from_str(&input_json).map_err(harness_error)?;
    let session = shrink_start(&grammar, &input).map_err(harness_error)?;
    serde_json::to_string(&session).map_err(harness_error)
}

/// 产出下一个收缩候选。
///
/// 返回 `{"session": <更新后的 ShrinkSession>, "candidate": [<FuzzInput>, [语句文本]] | null}`；
/// `candidate` 为 `null` 表示队列耗尽。调用方对候选文本执行失败谓词后，
/// 用 `harnessFuzzShrinkReport` 回报结果；谓词本身永远在调用方。
#[napi]
pub fn harnessFuzzShrinkNext(grammar_json: String, session_json: String) -> napi::Result<String> {
    let grammar: Grammar = serde_json::from_str(&grammar_json).map_err(harness_error)?;
    let mut session: ShrinkSession = serde_json::from_str(&session_json).map_err(harness_error)?;
    let candidate = shrink_next(&grammar, &mut session).map_err(harness_error)?;
    let envelope = serde_json::json!({ "session": session, "candidate": candidate });
    serde_json::to_string(&envelope).map_err(harness_error)
}

/// 回报当前候选是否仍失败（`true` 接受为新的最小 base），返回更新后的 `ShrinkSession` JSON。
#[napi]
pub fn harnessFuzzShrinkReport(session_json: String, failing: bool) -> napi::Result<String> {
    let mut session: ShrinkSession = serde_json::from_str(&session_json).map_err(harness_error)?;
    shrink_report(&mut session, failing);
    serde_json::to_string(&session).map_err(harness_error)
}
