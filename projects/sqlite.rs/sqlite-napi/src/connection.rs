//! `SqliteConnection`：facade `Connection` 的 JS 句柄包装。
//!
//! 绑定层只做句柄生命周期、值转换与错误转换；文件访问、只读判定、参数槽位、
//! 读写分类、提交边界落盘与备份全部由 `sqlite::Connection` 权威承担。
//! 语句与游标不复制任何数据库语义。

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use napi::bindgen_prelude::{BigInt, Buffer};
use napi_derive::napi;
use sqlite::{Connection, ConnectionOptions, JournalMode, SqlError};

use crate::{
    error::sql_error,
    statement::SqliteStatement,
    values::{SqlParam, TypedRunResult},
};

/// 连接与关闭标志一起放在共享状态里：语句句柄持有 `Arc`，
/// 连接关闭后任何语句的原生调用都会被拒绝，而不是悬空。
pub(crate) struct Shared {
    pub(crate) connection: Connection,
    pub(crate) closed: bool,
}

pub(crate) type SharedHandle = Arc<Mutex<Shared>>;

/// 打开连接的 JS 侧选项。字段形状校验属于 TS 层；这里只映射已校验的值。
#[napi(object)]
pub struct SqliteConnectionOptions {
    pub filename: Option<String>,
    pub data: Option<Buffer>,
    pub read_only: Option<bool>,
    pub create: Option<bool>,
    pub page_size: Option<u32>,
    pub synchronous: Option<bool>,
    /// 提交时如何发布镜像：`preserve` / `delete` / `truncate`。
    pub journal_mode: Option<String>,
    /// 写连接等待跨进程写锁的毫秒数；`None` 与 `0` 都表示只尝试一次。
    pub busy_timeout_ms: Option<u32>,
}

/// 字符串到 facade `JournalMode` 的映射：合法值交给 facade 解析，
/// `wal` 保持明确的 `unsupported`，其余未知值以 `option-invalid` 拒绝。
fn parse_journal_mode(name: Option<String>) -> Result<JournalMode, SqlError> {
    let Some(name) = name
    else {
        return Ok(JournalMode::Preserve);
    };
    match JournalMode::parse(&name) {
        Ok(mode) => Ok(mode),
        Err(_) if name.trim().eq_ignore_ascii_case("wal") => {
            Err(SqlError::new("unsupported", "journalMode `wal` is not supported (use preserve|delete|truncate)"))
        }
        Err(_) => Err(SqlError::new(
            "option-invalid",
            format!("journalMode `{}` is not recognized (use preserve|delete|truncate)", name.trim()),
        )),
    }
}

/// 一个真实连接：解析、执行、事务、文件发布与备份都发生在 Rust。
#[napi]
pub struct SqliteConnection {
    pub(crate) inner: SharedHandle,
}

impl SqliteConnection {
    fn locked(&self) -> Result<std::sync::MutexGuard<'_, Shared>, napi::Error> {
        let guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.closed {
            return Err(sql_error(SqlError::new("db-closed", "database connection is closed")));
        }
        Ok(guard)
    }
}

#[napi]
impl SqliteConnection {
    /// 打开连接：文件、字节镜像或纯内存。新建的文件库立即落一致镜像。
    #[napi(factory)]
    pub fn open(options: Option<SqliteConnectionOptions>) -> napi::Result<Self> {
        let options = options.unwrap_or(SqliteConnectionOptions {
            filename: None,
            data: None,
            read_only: None,
            create: None,
            page_size: None,
            synchronous: None,
            journal_mode: None,
            busy_timeout_ms: None,
        });
        let facade = ConnectionOptions {
            filename: options.filename.map(PathBuf::from),
            data: options.data.map(|buffer| buffer.to_vec()),
            read_only: options.read_only.unwrap_or(false),
            create: options.create.unwrap_or(true),
            page_size: options.page_size,
            synchronous: options.synchronous.unwrap_or(true),
            journal_mode: parse_journal_mode(options.journal_mode).map_err(sql_error)?,
            busy_timeout_ms: u64::from(options.busy_timeout_ms.unwrap_or(0)),
        };
        let connection = Connection::open(facade).map_err(sql_error)?;
        Ok(Self { inner: Arc::new(Mutex::new(Shared { connection, closed: false })) })
    }

    /// 解析一次 SQL，返回持有真实 prepared 句柄的语句对象。
    #[napi]
    pub fn prepare(&self, sql: String) -> napi::Result<SqliteStatement> {
        let guard = self.locked()?;
        let prepared = guard.connection.prepare(&sql).map_err(sql_error)?;
        Ok(SqliteStatement::new(self.inner.clone(), prepared))
    }

    /// 执行分号分隔的脚本；逐条语句应用只读拒绝与提交边界。
    #[napi]
    pub fn exec(&self, script: String, parameters: Option<Vec<SqlParam>>) -> napi::Result<Vec<TypedRunResult>> {
        let cells = parameters.unwrap_or_default().into_iter().map(SqlParam::into_cell).collect::<Vec<_>>();
        let mut guard = self.locked()?;
        let results = guard.connection.execute(&script, &cells).map_err(sql_error)?;
        let last_insert_rowid = guard.connection.last_insert_rowid();
        Ok(results.into_iter().map(|result| TypedRunResult { result, last_insert_rowid }).collect())
    }

    /// 脚本内每条语句的种类名（来自 Rust 解析器），供 TS 层判断事务控制语句。
    #[napi]
    pub fn statementKinds(&self, sql: String) -> napi::Result<Vec<String>> {
        Ok(sqlite::parse(&sql).map_err(sql_error)?.iter().map(|statement| statement.name().to_string()).collect())
    }

    /// 当前数据库镜像。
    #[napi]
    pub fn snapshot(&self) -> napi::Result<Buffer> {
        let mut guard = self.locked()?;
        let image = guard.connection.snapshot().map_err(sql_error)?;
        Ok(image.to_vec().into())
    }

    /// 真正的备份：把当前镜像完整写入目标文件。
    #[napi]
    pub fn backup(&self, path: String) -> napi::Result<()> {
        let mut guard = self.locked()?;
        guard.connection.backup(&PathBuf::from(path)).map_err(sql_error)
    }

    /// 关闭连接：已提交未落盘的改动先落盘；未结束的事务不落盘。
    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.closed {
            return Ok(());
        }
        let result = guard.connection.close().map_err(sql_error);
        guard.closed = true;
        result
    }

    /// 引擎权威的事务状态，不在 JS 里镜像布尔值。
    #[napi]
    pub fn inTransaction(&self) -> napi::Result<bool> {
        Ok(self.locked()?.connection.in_transaction())
    }

    /// `sqlite3_last_insert_rowid()`，以 `bigint` 呈现。
    #[napi]
    pub fn lastInsertRowid(&self) -> napi::Result<BigInt> {
        Ok(BigInt::from(self.locked()?.connection.last_insert_rowid()))
    }

    /// 页大小。
    #[napi]
    pub fn pageSize(&self) -> napi::Result<u32> {
        Ok(self.locked()?.connection.page_size())
    }

    /// 镜像头里的 format-3 库版本。
    #[napi]
    pub fn sqliteVersion(&self) -> napi::Result<String> {
        let guard = self.locked()?;
        guard.connection.sqlite_version().map_err(sql_error)
    }

    /// 连接是否只读（Rust 权威值）。
    #[napi]
    pub fn readOnly(&self) -> bool {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).connection.is_read_only()
    }

    /// 文件路径；纯内存连接返回 `null`。
    #[napi]
    pub fn filename(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .connection
            .filename()
            .map(|path| path.display().to_string())
    }

    /// `PRAGMA synchronous` 透传。
    #[napi]
    pub fn setSynchronous(&self, on: bool) -> napi::Result<()> {
        self.locked()?.connection.set_synchronous(on);
        Ok(())
    }
}
