//! 标准 harness 能力绑定：harness 判定、基准统计、图表与 fuzz 状态机。
//!
//! 这些是与产品 SQL 入口并列的正式能力，编译进同一个 `.node`，由 `sqlite-harness`
//! 包按模块导出取用；不为这个边界另造 addon，也不降为 dev-dependency。

use std::{collections::BTreeMap, ffi::CString, ptr};

use database::harness::{
    Baseline, BaselineIdentity, BenchProblem, BenchRow, Cell, CompareMode, Comparison, Diff, DifferenceClass,
    DifferenceObservation, Digest, ErrorShape, FuzzInput, FuzzPlan, GatePolicy, Grammar, KnownDifference, Observed,
    ObservedBody, ReportEnvelope, ShrinkSession, Stats, SuiteReport, TruthProvenance, UnavailableEvidence,
    chart::{BenchMetric, bench_chart_svg},
    check_baseline, classify, compare, evaluate, generate, per_op_ms, render, render_json, shrink_next, shrink_report,
    shrink_start, summarize,
};
use napi::{
    bindgen_prelude::{BigInt, Buffer, FromNapiValue, ToNapiValue, Unknown, ValueType},
    sys,
};
use napi_derive::napi;

use crate::values::{create_integer, create_null, create_object, create_real, js_string, set_property};

fn harness_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

fn bench_error(error: BenchProblem) -> napi::Error {
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

// ---- 观测比对与归类：类型化直传线型 ----
//
// `Cell` 的 `i64` 与 `Vec<u8>` 以原生 `bigint` 与 `Buffer`/`Uint8Array` 跨 ABI，
// 不再经过 JSON 文本：`JSON.stringify` 会把超过 2^53 的 `i64` 静默降为双精度，
// 并把 `Vec<u8>` 展开成数字数组。对象形态与上游 serde 外部标签形态逐字段对齐
// （`"null"`、`{"int":..}`、`{"blob":..}`），TS 作者面直接传结构化对象。

/// 读取对象上的具名属性；属性缺失时得到 `undefined` 值而非错误。
unsafe fn wire_property(env: sys::napi_env, object: sys::napi_value, name: &str) -> napi::Result<sys::napi_value> {
    let key = CString::new(name).map_err(harness_error)?;
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_get_named_property(env, object, key.as_ptr(), &mut value) })?;
    Ok(value)
}

unsafe fn wire_type(env: sys::napi_env, value: sys::napi_value) -> napi::Result<ValueType> {
    unsafe { Unknown::from_napi_value(env, value)?.get_type() }
}

/// 必需字符串属性。
unsafe fn wire_string(env: sys::napi_env, object: sys::napi_value, name: &str) -> napi::Result<String> {
    let raw = unsafe { wire_property(env, object, name)? };
    match unsafe { wire_type(env, raw)? } {
        ValueType::String => unsafe { String::from_napi_value(env, raw) },
        kind => Err(napi::Error::from_reason(format!("harness wire: `{name}` must be a string, got {kind:?}"))),
    }
}

/// 可选字符串属性：`null` 与 `undefined` 都是缺失。
unsafe fn wire_optional_string(env: sys::napi_env, object: sys::napi_value, name: &str) -> napi::Result<Option<String>> {
    let raw = unsafe { wire_property(env, object, name)? };
    match unsafe { wire_type(env, raw)? } {
        ValueType::Null | ValueType::Undefined => Ok(None),
        ValueType::String => Ok(Some(unsafe { String::from_napi_value(env, raw)? })),
        kind => Err(napi::Error::from_reason(format!("harness wire: `{name}` must be a string or null, got {kind:?}"))),
    }
}

/// 必需布尔属性。
unsafe fn wire_bool(env: sys::napi_env, object: sys::napi_value, name: &str) -> napi::Result<bool> {
    let raw = unsafe { wire_property(env, object, name)? };
    match unsafe { wire_type(env, raw)? } {
        ValueType::Boolean => unsafe { bool::from_napi_value(env, raw) },
        kind => Err(napi::Error::from_reason(format!("harness wire: `{name}` must be a boolean, got {kind:?}"))),
    }
}

/// 必需计数属性：JS `number`，必须是非负整数。
unsafe fn wire_count(env: sys::napi_env, object: sys::napi_value, name: &str) -> napi::Result<usize> {
    let raw = unsafe { wire_property(env, object, name)? };
    match unsafe { wire_type(env, raw)? } {
        ValueType::Number => {
            let value = unsafe { f64::from_napi_value(env, raw)? };
            if value.fract() != 0.0 || value < 0.0 {
                return Err(napi::Error::from_reason(format!(
                    "harness wire: `{name}` must be a non-negative integer, got {value}"
                )));
            }
            Ok(value as usize)
        }
        kind => Err(napi::Error::from_reason(format!("harness wire: `{name}` must be a number, got {kind:?}"))),
    }
}

/// 必需摘要属性：64 位小写十六进制的 `Digest`。
unsafe fn wire_digest(env: sys::napi_env, object: sys::napi_value, name: &str) -> napi::Result<Digest> {
    let text = unsafe { wire_string(env, object, name)? };
    Digest::parse(&text).map_err(harness_error)
}

/// 在对象上写入具名属性。
unsafe fn set_field(env: sys::napi_env, object: sys::napi_value, key: &str, value: sys::napi_value) -> napi::Result<()> {
    unsafe { set_property(env, object, js_string(env, key.as_bytes())?, value) }
}

unsafe fn set_field_string(env: sys::napi_env, object: sys::napi_value, key: &str, value: &str) -> napi::Result<()> {
    unsafe { set_field(env, object, key, js_string(env, value.as_bytes())?) }
}

unsafe fn set_field_optional_string(
    env: sys::napi_env,
    object: sys::napi_value,
    key: &str,
    value: Option<&str>,
) -> napi::Result<()> {
    let raw = match value {
        Some(text) => unsafe { js_string(env, text.as_bytes())? },
        None => unsafe { create_null(env)? },
    };
    unsafe { set_field(env, object, key, raw) }
}

unsafe fn set_field_bool(env: sys::napi_env, object: sys::napi_value, key: &str, value: bool) -> napi::Result<()> {
    let raw = unsafe { <bool as ToNapiValue>::to_napi_value(env, value)? };
    unsafe { set_field(env, object, key, raw) }
}

unsafe fn set_field_count(env: sys::napi_env, object: sys::napi_value, key: &str, value: usize) -> napi::Result<()> {
    let raw = unsafe { <f64 as ToNapiValue>::to_napi_value(env, value as f64)? };
    unsafe { set_field(env, object, key, raw) }
}

/// 单个单元格：serde 外部标签形态原样跨 ABI。
pub struct CellWire(pub Cell);

impl FromNapiValue for CellWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        match unsafe { wire_type(env, value)? } {
            ValueType::String => {
                let text = unsafe { String::from_napi_value(env, value)? };
                if text == "null" {
                    return Ok(Self(Cell::Null));
                }
                Err(napi::Error::from_reason(format!("harness cell: a bare string cell must be `null`, got `{text}`")))
            }
            ValueType::Object => {
                let raw_bool = unsafe { wire_property(env, value, "bool")? };
                if unsafe { wire_type(env, raw_bool)? } != ValueType::Undefined {
                    return Ok(Self(Cell::Bool(unsafe { bool::from_napi_value(env, raw_bool)? })));
                }
                let raw_int = unsafe { wire_property(env, value, "int")? };
                match unsafe { wire_type(env, raw_int)? } {
                    ValueType::Undefined => {}
                    ValueType::BigInt => {
                        // `get_i64` 第二项为真才表示无损，超界直接拒绝，不静默截断。
                        let (integer, lossless) = unsafe { BigInt::from_napi_value(env, raw_int)? }.get_i64();
                        if !lossless {
                            return Err(napi::Error::from_reason("harness cell: `int` exceeds the signed 64-bit range"));
                        }
                        return Ok(Self(Cell::Int(integer)));
                    }
                    kind => {
                        return Err(napi::Error::from_reason(format!("harness cell: `int` must be a bigint, got {kind:?}")));
                    }
                }
                let raw_float = unsafe { wire_property(env, value, "float")? };
                match unsafe { wire_type(env, raw_float)? } {
                    ValueType::Undefined => {}
                    ValueType::Number => return Ok(Self(Cell::Float(unsafe { f64::from_napi_value(env, raw_float)? }))),
                    kind => {
                        return Err(napi::Error::from_reason(format!("harness cell: `float` must be a number, got {kind:?}")));
                    }
                }
                let raw_text = unsafe { wire_property(env, value, "text")? };
                match unsafe { wire_type(env, raw_text)? } {
                    ValueType::Undefined => {}
                    ValueType::String => return Ok(Self(Cell::Text(unsafe { String::from_napi_value(env, raw_text)? }))),
                    kind => {
                        return Err(napi::Error::from_reason(format!("harness cell: `text` must be a string, got {kind:?}")));
                    }
                }
                let raw_blob = unsafe { wire_property(env, value, "blob")? };
                match unsafe { wire_type(env, raw_blob)? } {
                    ValueType::Undefined => {}
                    ValueType::Object => {
                        return Ok(Self(Cell::Blob(unsafe { Buffer::from_napi_value(env, raw_blob)? }.to_vec())));
                    }
                    kind => {
                        return Err(napi::Error::from_reason(format!(
                            "harness cell: `blob` must be a Buffer or Uint8Array, got {kind:?}"
                        )));
                    }
                }
                Err(napi::Error::from_reason(
                    "harness cell: tagged object must carry exactly one of `bool`, `int`, `float`, `text`, `blob`",
                ))
            }
            kind => Err(napi::Error::from_reason(format!("harness cell must be `\"null\"` or a tagged object, got {kind:?}"))),
        }
    }
}

impl ToNapiValue for CellWire {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            match val.0 {
                Cell::Null => js_string(env, b"null"),
                Cell::Bool(inner) => tagged_cell(env, "bool", <bool as ToNapiValue>::to_napi_value(env, inner)?),
                Cell::Int(inner) => tagged_cell(env, "int", create_integer(env, inner)?),
                Cell::Float(inner) => tagged_cell(env, "float", create_real(env, inner)?),
                Cell::Text(inner) => tagged_cell(env, "text", js_string(env, inner.as_bytes())?),
                Cell::Blob(inner) => {
                    tagged_cell(env, "blob", <Buffer as ToNapiValue>::to_napi_value(env, Buffer::from(inner))?)
                }
            }
        }
    }
}

unsafe fn tagged_cell(env: sys::napi_env, key: &str, value: sys::napi_value) -> napi::Result<sys::napi_value> {
    let object = unsafe { create_object(env)? };
    unsafe { set_field(env, object, key, value)? };
    Ok(object)
}

/// 期望值来源：内部标签 `{kind, id, version|digest}`。
pub struct ProvenanceWire(pub TruthProvenance);

impl FromNapiValue for ProvenanceWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        let kind = unsafe { wire_string(env, value, "kind")? };
        let id = unsafe { wire_string(env, value, "id")? };
        let provenance = match kind.as_str() {
            "external_engine" => {
                TruthProvenance::ExternalEngine { id, version: unsafe { wire_string(env, value, "version")? } }
            }
            "official_corpus" => TruthProvenance::OfficialCorpus { id, digest: unsafe { wire_digest(env, value, "digest")? } },
            "frozen_baseline" => TruthProvenance::FrozenBaseline { id, digest: unsafe { wire_digest(env, value, "digest")? } },
            other => return Err(napi::Error::from_reason(format!("harness provenance: unknown kind `{other}`"))),
        };
        Ok(Self(provenance))
    }
}

/// 观测载荷：内部标签 `{kind, rows|bytes|fields|code+reason}`。
pub struct BodyWire(pub ObservedBody);

impl FromNapiValue for BodyWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        let kind = unsafe { wire_string(env, value, "kind")? };
        let body = match kind.as_str() {
            "rows" => {
                let raw = unsafe { wire_property(env, value, "rows")? };
                let rows = unsafe { Vec::<Vec<CellWire>>::from_napi_value(env, raw)? }
                    .into_iter()
                    .map(|row| row.into_iter().map(|cell| cell.0).collect())
                    .collect();
                ObservedBody::Rows { rows }
            }
            "wire" => {
                let raw = unsafe { wire_property(env, value, "bytes")? };
                ObservedBody::Wire { bytes: unsafe { Buffer::from_napi_value(env, raw)? }.to_vec() }
            }
            "error" => {
                let raw = unsafe { wire_property(env, value, "fields")? };
                ObservedBody::Error(ErrorShape { fields: unsafe { BTreeMap::<String, String>::from_napi_value(env, raw)? } })
            }
            "unavailable" => ObservedBody::Unavailable {
                code: unsafe { wire_string(env, value, "code")? },
                reason: unsafe { wire_string(env, value, "reason")? },
            },
            other => return Err(napi::Error::from_reason(format!("harness observed body: unknown kind `{other}`"))),
        };
        Ok(Self(body))
    }
}

/// 一侧观测值：`{provenance, body}`。
pub struct ObservedWire(pub Observed);

impl FromNapiValue for ObservedWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        if unsafe { wire_type(env, value)? } != ValueType::Object {
            return Err(napi::Error::from_reason("harness observed: expected an object `{provenance, body}`"));
        }
        let raw_provenance = unsafe { wire_property(env, value, "provenance")? };
        let provenance = match unsafe { wire_type(env, raw_provenance)? } {
            ValueType::Null | ValueType::Undefined => None,
            ValueType::Object => Some(unsafe { ProvenanceWire::from_napi_value(env, raw_provenance)? }.0),
            kind => {
                return Err(napi::Error::from_reason(format!(
                    "harness observed: `provenance` must be an object or null, got {kind:?}"
                )));
            }
        };
        let raw_body = unsafe { wire_property(env, value, "body")? };
        if unsafe { wire_type(env, raw_body)? } != ValueType::Object {
            return Err(napi::Error::from_reason("harness observed: `body` must be an object"));
        }
        let body = unsafe { BodyWire::from_napi_value(env, raw_body)? }.0;
        Ok(Self(Observed { provenance, body }))
    }
}

/// 比较模式：`{kind}` 或 `{kind:"structured_fields", fields}`。
pub struct ModeWire(pub CompareMode);

impl FromNapiValue for ModeWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        let kind = unsafe { wire_string(env, value, "kind")? };
        let mode = match kind.as_str() {
            "exact" => CompareMode::Exact,
            "wire_hex" => CompareMode::WireHex,
            "structured_fields" => CompareMode::StructuredFields {
                fields: unsafe { Vec::<String>::from_napi_value(env, wire_property(env, value, "fields")?)? },
            },
            other => return Err(napi::Error::from_reason(format!("harness compare mode: unknown kind `{other}`"))),
        };
        Ok(Self(mode))
    }
}

/// 单条差异：serde 内部标签形态原样跨 ABI，`row_cell` 携带 `CellWire`。
pub struct DiffWire(pub Diff);

impl FromNapiValue for DiffWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        let kind = unsafe { wire_string(env, value, "kind")? };
        let diff = match kind.as_str() {
            "body_kind" => Diff::BodyKind {
                expected: unsafe { wire_string(env, value, "expected")? },
                actual: unsafe { wire_string(env, value, "actual")? },
            },
            "row_count" => Diff::RowCount {
                expected: unsafe { wire_count(env, value, "expected")? },
                actual: unsafe { wire_count(env, value, "actual")? },
            },
            "column_count" => Diff::ColumnCount {
                row: unsafe { wire_count(env, value, "row")? },
                expected: unsafe { wire_count(env, value, "expected")? },
                actual: unsafe { wire_count(env, value, "actual")? },
            },
            "row_cell" => Diff::RowCell {
                row: unsafe { wire_count(env, value, "row")? },
                column: unsafe { wire_count(env, value, "column")? },
                expected: unsafe { CellWire::from_napi_value(env, wire_property(env, value, "expected")?)?.0 },
                actual: unsafe { CellWire::from_napi_value(env, wire_property(env, value, "actual")?)?.0 },
            },
            "wire_length" => Diff::WireLength {
                expected: unsafe { wire_count(env, value, "expected")? },
                actual: unsafe { wire_count(env, value, "actual")? },
            },
            "wire_byte" => Diff::WireByte {
                offset: unsafe { wire_count(env, value, "offset")? },
                expected: unsafe { wire_string(env, value, "expected")? },
                actual: unsafe { wire_string(env, value, "actual")? },
            },
            "error_field" => Diff::ErrorField {
                field: unsafe { wire_string(env, value, "field")? },
                expected: unsafe { wire_optional_string(env, value, "expected")? },
                actual: unsafe { wire_optional_string(env, value, "actual")? },
            },
            "unavailable_code" => Diff::UnavailableCode {
                expected: unsafe { wire_string(env, value, "expected")? },
                actual: unsafe { wire_string(env, value, "actual")? },
            },
            other => return Err(napi::Error::from_reason(format!("harness diff: unknown kind `{other}`"))),
        };
        Ok(Self(diff))
    }
}

impl ToNapiValue for DiffWire {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        let object = unsafe { create_object(env)? };
        unsafe {
            match val.0 {
                Diff::BodyKind { expected, actual } => {
                    set_field_string(env, object, "kind", "body_kind")?;
                    set_field_string(env, object, "expected", &expected)?;
                    set_field_string(env, object, "actual", &actual)?;
                }
                Diff::RowCount { expected, actual } => {
                    set_field_string(env, object, "kind", "row_count")?;
                    set_field_count(env, object, "expected", expected)?;
                    set_field_count(env, object, "actual", actual)?;
                }
                Diff::ColumnCount { row, expected, actual } => {
                    set_field_string(env, object, "kind", "column_count")?;
                    set_field_count(env, object, "row", row)?;
                    set_field_count(env, object, "expected", expected)?;
                    set_field_count(env, object, "actual", actual)?;
                }
                Diff::RowCell { row, column, expected, actual } => {
                    set_field_string(env, object, "kind", "row_cell")?;
                    set_field_count(env, object, "row", row)?;
                    set_field_count(env, object, "column", column)?;
                    set_field(env, object, "expected", <CellWire as ToNapiValue>::to_napi_value(env, CellWire(expected))?)?;
                    set_field(env, object, "actual", <CellWire as ToNapiValue>::to_napi_value(env, CellWire(actual))?)?;
                }
                Diff::WireLength { expected, actual } => {
                    set_field_string(env, object, "kind", "wire_length")?;
                    set_field_count(env, object, "expected", expected)?;
                    set_field_count(env, object, "actual", actual)?;
                }
                Diff::WireByte { offset, expected, actual } => {
                    set_field_string(env, object, "kind", "wire_byte")?;
                    set_field_count(env, object, "offset", offset)?;
                    set_field_string(env, object, "expected", &expected)?;
                    set_field_string(env, object, "actual", &actual)?;
                }
                Diff::ErrorField { field, expected, actual } => {
                    set_field_string(env, object, "kind", "error_field")?;
                    set_field_string(env, object, "field", &field)?;
                    set_field_optional_string(env, object, "expected", expected.as_deref())?;
                    set_field_optional_string(env, object, "actual", actual.as_deref())?;
                }
                Diff::UnavailableCode { expected, actual } => {
                    set_field_string(env, object, "kind", "unavailable_code")?;
                    set_field_string(env, object, "expected", &expected)?;
                    set_field_string(env, object, "actual", &actual)?;
                }
            }
        }
        Ok(object)
    }
}

/// 一次比对的完整结果：双向类型化。
pub struct ComparisonWire(pub Comparison);

impl FromNapiValue for ComparisonWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        if unsafe { wire_type(env, value)? } != ValueType::Object {
            return Err(napi::Error::from_reason("harness comparison: expected an object"));
        }
        let raw_unavailable = unsafe { wire_property(env, value, "unavailable")? };
        let unavailable = match unsafe { wire_type(env, raw_unavailable)? } {
            ValueType::Null | ValueType::Undefined => None,
            ValueType::Object => Some(UnavailableEvidence {
                expected: unsafe { wire_optional_string(env, raw_unavailable, "expected")? },
                actual: unsafe { wire_optional_string(env, raw_unavailable, "actual")? },
            }),
            kind => {
                return Err(napi::Error::from_reason(format!(
                    "harness comparison: `unavailable` must be an object or null, got {kind:?}"
                )));
            }
        };
        let comparison = Comparison {
            matched: unsafe { wire_bool(env, value, "matched")? },
            unverified: unsafe { wire_bool(env, value, "unverified")? },
            unavailable,
            signal: unsafe { Vec::<String>::from_napi_value(env, wire_property(env, value, "signal")?)? },
            diffs: unsafe { Vec::<DiffWire>::from_napi_value(env, wire_property(env, value, "diffs")?)? }
                .into_iter()
                .map(|diff| diff.0)
                .collect(),
            truncated: unsafe { wire_bool(env, value, "truncated")? },
        };
        Ok(Self(comparison))
    }
}

impl ToNapiValue for ComparisonWire {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        let object = unsafe { create_object(env)? };
        unsafe {
            set_field_bool(env, object, "matched", val.0.matched)?;
            set_field_bool(env, object, "unverified", val.0.unverified)?;
            let unavailable = match &val.0.unavailable {
                None => create_null(env)?,
                Some(evidence) => {
                    let inner = create_object(env)?;
                    set_field_optional_string(env, inner, "expected", evidence.expected.as_deref())?;
                    set_field_optional_string(env, inner, "actual", evidence.actual.as_deref())?;
                    inner
                }
            };
            set_field(env, object, "unavailable", unavailable)?;
            set_field(env, object, "signal", <Vec<String> as ToNapiValue>::to_napi_value(env, val.0.signal)?)?;
            set_field(
                env,
                object,
                "diffs",
                <Vec<DiffWire> as ToNapiValue>::to_napi_value(env, val.0.diffs.into_iter().map(DiffWire).collect())?,
            )?;
            set_field_bool(env, object, "truncated", val.0.truncated)?;
        }
        Ok(object)
    }
}

/// 已知差异台账条目：`{key, signal, reason}`。
pub struct KnownDifferenceWire(pub KnownDifference);

impl FromNapiValue for KnownDifferenceWire {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        Ok(Self(KnownDifference {
            key: unsafe { wire_string(env, value, "key")? },
            signal: unsafe { Vec::<String>::from_napi_value(env, wire_property(env, value, "signal")?)? },
            reason: unsafe { wire_string(env, value, "reason")? },
        }))
    }
}

/// 归类结果：内部标签 `{kind, ...}`。
pub struct ClassWire(pub DifferenceClass);

impl ToNapiValue for ClassWire {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        let object = unsafe { create_object(env)? };
        unsafe {
            match val.0 {
                DifferenceClass::Clean => set_field_string(env, object, "kind", "clean")?,
                DifferenceClass::Unverified => set_field_string(env, object, "kind", "unverified")?,
                DifferenceClass::Unavailable { expected, actual } => {
                    set_field_string(env, object, "kind", "unavailable")?;
                    set_field_optional_string(env, object, "expected", expected.as_deref())?;
                    set_field_optional_string(env, object, "actual", actual.as_deref())?;
                }
                DifferenceClass::Known { key, reason } => {
                    set_field_string(env, object, "kind", "known")?;
                    set_field_string(env, object, "key", &key)?;
                    set_field_string(env, object, "reason", &reason)?;
                }
                DifferenceClass::Unlisted => set_field_string(env, object, "kind", "unlisted")?,
            }
        }
        Ok(object)
    }
}

/// 按指定模式比对两侧观测值，返回结构化 `Comparison`。
///
/// 出入参全部类型化直传：`Cell` 的 `int` 是原生 `bigint`（i64，入站校验
/// 无损），`blob` 与 wire 字节是 `Buffer`/`Uint8Array`（Vec<u8>），对象形态
/// 与上游 serde 标签形态逐字段对齐，不经过 JSON 文本。期望侧缺少
/// `provenance` 时结果带 `unverified`，调用方不得计为通过。
#[napi]
pub fn harnessCompare(expected: ObservedWire, actual: ObservedWire, mode: ModeWire) -> ComparisonWire {
    ComparisonWire(compare(&expected.0, &actual.0, &mode.0))
}

/// 把一次比对结果对照已知差异台账归类，返回结构化 `DifferenceClass`。
///
/// `comparison` 与 `harnessCompare` 的输出同一套类型化形态（`bigint`/`Buffer`
/// 可原样往返）；`known` 是 `{key, signal, reason}` 数组。`case_key` 是当前
/// 用例的稳定身份；缺省或与台账条目不匹配时记未登记。
#[napi]
pub fn harnessClassify(comparison: ComparisonWire, case_key: Option<String>, known: Vec<KnownDifferenceWire>) -> ClassWire {
    let known = known.into_iter().map(|entry| entry.0).collect::<Vec<_>>();
    ClassWire(classify(&comparison.0, case_key.as_deref(), &known))
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
        Self {
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            min_ms: stats.min_ms,
            max_ms: stats.max_ms,
            rounds: stats.rounds,
        }
    }
}

/// 对一组毫秒样本求 median/p95/极值（nearest-rank，与 TS 既有实现逐字节一致）。
#[napi]
pub fn harnessBenchSummary(samples_ms: Vec<f64>) -> napi::Result<BenchStatsJson> {
    summarize(&samples_ms).map(Into::into).map_err(bench_error)
}

/// 单次操作的归一毫秒（median / ops）。`ops` 为 0 时抛错，不返回 NaN。
#[napi]
pub fn harnessBenchPerOp(stats: BenchStatsJson, ops: u32) -> napi::Result<f64> {
    per_op_ms(
        &Stats {
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            min_ms: stats.min_ms,
            max_ms: stats.max_ms,
            rounds: stats.rounds,
        },
        u64::from(ops),
    )
    .map_err(bench_error)
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
