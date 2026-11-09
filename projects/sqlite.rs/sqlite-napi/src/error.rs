//! 结构化错误转换。
//!
//! 引擎的 `SqlError` 带 `code`、`statement`、`clause`、`position`。N-API 只把
//! 这些字段原样序列化进 `reason`（JSON 信封），由 TS 层解析成 `SQLiteError`；
//! 绑定层不吞掉结构、不重新解释语义。非引擎错误（JS 类型转换失败等）保持
//! 纯文本 `reason`。

/// 把引擎的结构化拒绝转为 N-API 错误，`reason` 是 `SqlError` 的 JSON 信封。
pub(crate) fn sql_error(error: sqlite::SqlError) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, error.to_json())
}

/// 把存储层错误转为 N-API 错误。
pub(crate) fn storage_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
