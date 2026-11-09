//! `SqliteStatement`：facade `Prepared` 的 JS 句柄包装。
//!
//! 语句对象持有真实预编译句柄（解析一次的 AST 与权威槽位表），执行时不再
//! 重新词法。槽位、读写分类、参数个数都来自 Rust；TS 层只做 JS 形状检查。

use napi_derive::napi;
use sqlite::{Prepared, SqlError};

use crate::connection::SharedHandle;
use crate::error::sql_error;
use crate::values::{SqlParam, TypedRunResult};

/// 一个权威参数槽位：零基索引与书写原文。
#[napi(object)]
pub struct SqliteSlot {
    pub index: u32,
    pub text: String,
}

/// 解析一次的语句。`raw`/`pluck` 视图在 TS 侧共享本句柄的忙状态与生命周期。
#[napi]
pub struct SqliteStatement {
    inner: SharedHandle,
    prepared: Option<Prepared>,
}

impl SqliteStatement {
    pub(crate) fn new(inner: SharedHandle, prepared: Prepared) -> Self {
        Self { inner, prepared: Some(prepared) }
    }

    fn prepared(&self) -> Result<&Prepared, napi::Error> {
        self.prepared.as_ref().ok_or_else(|| sql_error(SqlError::new("statement-finalized", "statement handle is finalized")))
    }
}

#[napi]
impl SqliteStatement {
    /// 执行语句，绑定零基位置参数。缺失参数与只读拒绝由 Rust 权威判定。
    #[napi]
    pub fn run(&self, parameters: Option<Vec<SqlParam>>) -> napi::Result<TypedRunResult> {
        let prepared = self.prepared()?;
        let cells = parameters.unwrap_or_default().into_iter().map(SqlParam::into_cell).collect::<Vec<_>>();
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.closed {
            return Err(sql_error(SqlError::new("db-closed", "database connection is closed")));
        }
        let result = guard.connection.run(prepared, &cells).map_err(sql_error)?;
        let last_insert_rowid = guard.connection.last_insert_rowid();
        Ok(TypedRunResult { result, last_insert_rowid })
    }

    /// 提交的 SQL 原文。
    #[napi]
    pub fn sql(&self) -> napi::Result<String> {
        Ok(self.prepared()?.sql().to_string())
    }

    /// 语句种类名（`insert`、`select` 等），与执行结果报告同源。
    #[napi]
    pub fn statementName(&self) -> napi::Result<String> {
        Ok(self.prepared()?.statement_name().to_string())
    }

    /// 权威参数槽位表。
    #[napi]
    pub fn slots(&self) -> napi::Result<Vec<SqliteSlot>> {
        Ok(self
            .prepared()?
            .slots()
            .iter()
            .map(|(index, text)| SqliteSlot { index: *index as u32, text: text.clone() })
            .collect())
    }

    /// 绑定所需的最小参数个数。
    #[napi]
    pub fn parameterCount(&self) -> napi::Result<u32> {
        Ok(self.prepared()?.parameter_count() as u32)
    }

    /// 语句是否会改变存储的数据库镜像（Rust 按 AST 判定）。
    #[napi]
    pub fn isWrite(&self) -> napi::Result<bool> {
        Ok(self.prepared()?.is_write())
    }

    /// 结果列标签。引擎在执行时才计算结果头，预编译期如实返回 `null`。
    /// TODO(oak-sql): 引擎长出 describe 步骤后返回真实表头。
    #[napi]
    pub fn columns(&self) -> napi::Result<Option<Vec<String>>> {
        Ok(self.prepared()?.columns())
    }

    /// 释放预编译句柄。
    #[napi]
    pub fn finalize(&mut self) {
        self.prepared = None;
    }
}
