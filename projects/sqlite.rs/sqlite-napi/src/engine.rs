//! `SqliteEngine`：facade `Engine` 的 JSON 信封句柄。
//!
//! 这是过渡原语，供 ORM 适配、harness 与尚未迁移的既有消费者使用：执行结果
//! 以 JSON 形态返回（INTEGER/REAL→`number`、TEXT→`string`、BLOB→`{$blob}`、
//! NULL→`null`），与忠实类型的正式入口 [`crate::connection::SqliteConnection`]
//! 不同。新代码一律用 `SqliteConnection`；本句柄待 TypeORM / Drizzle / Prisma
//! 迁移到新入口后从根包移除。

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use crate::values::{SqlParam, TypedRunResult};

/// 把引擎的结构化拒绝转为纯文本错误（JSON 形态原语沿用旧合同，不携带信封）。
fn engine_error(error: sqlite::SqlError) -> napi::Error {
    napi::Error::from_reason(error.message)
}

fn engine_json(text: String) -> napi::Result<serde_json::Value> {
    serde_json::from_str(&text).map_err(|e| napi::Error::from_reason(format!("sqlite result JSON invalid: {e}")))
}

/// 把 JSON 绑定值转为存储单元格：整数优先、`$blob`/`$i64` 信封、布尔转 0/1。
fn json_to_cell(json: &serde_json::Value) -> napi::Result<sqlite::Cell> {
    Ok(match json {
        serde_json::Value::Null => sqlite::Cell::Null,
        serde_json::Value::Bool(flag) => sqlite::Cell::Integer(i64::from(*flag)),
        serde_json::Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                sqlite::Cell::Integer(integer)
            }
            else if let Some(real) = number.as_f64() {
                sqlite::Cell::Real(real)
            }
            else {
                return Err(napi::Error::from_reason("sqlite parameter number out of range"));
            }
        }
        serde_json::Value::String(text) => sqlite::Cell::Text(text.clone()),
        serde_json::Value::Object(object) => {
            if let Some(hex) = object.get("$blob").and_then(serde_json::Value::as_str) {
                if hex.len() % 2 != 0 {
                    return Err(napi::Error::from_reason("sqlite blob hex must have even length"));
                }
                let mut bytes = Vec::with_capacity(hex.len() / 2);
                for index in 0..hex.len() / 2 {
                    let byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                        .map_err(|_| napi::Error::from_reason("sqlite blob hex is not valid"))?;
                    bytes.push(byte);
                }
                sqlite::Cell::Blob(bytes)
            }
            else if let Some(integer) = object.get("$i64").and_then(serde_json::Value::as_str) {
                let value = integer
                    .parse::<i64>()
                    .map_err(|_| napi::Error::from_reason("sqlite $i64 value must be a decimal string"))?;
                sqlite::Cell::Integer(value)
            }
            else {
                return Err(napi::Error::from_reason("sqlite parameter object must carry `$blob` or `$i64`"));
            }
        }
        serde_json::Value::Array(_) => {
            return Err(napi::Error::from_reason("sqlite parameter must not be an array"));
        }
    })
}

/// JSON 信封形态的内存 SQL 引擎；正式产品入口请用 `SqliteConnection`。
#[napi]
pub struct SqliteEngine {
    engine: sqlite::Engine,
}

#[napi]
impl SqliteEngine {
    /// Creates a blank in-memory database image with the given page size (default 4096).
    #[napi(factory)]
    pub fn create(page_size: Option<u32>) -> napi::Result<Self> {
        sqlite::Engine::new(page_size).map(|engine| Self { engine }).map_err(engine_error)
    }

    /// Executes a semicolon-separated script and returns every result in order.
    #[napi]
    pub fn exec(&mut self, sql: String) -> napi::Result<serde_json::Value> {
        let results = self.engine.execute(&sql).map_err(engine_error)?;
        engine_json(sqlite::results_json(&results))
    }

    /// Executes exactly one statement and returns `{statement, affected, columns, rows}`.
    #[napi]
    pub fn execute(&mut self, statement: String) -> napi::Result<serde_json::Value> {
        let result = self.engine.execute_one(&statement).map_err(engine_error)?;
        engine_json(result.to_json())
    }

    /// Executes a list of statements in order and returns every result.
    #[napi]
    pub fn executeBatch(&mut self, statements: Vec<String>) -> napi::Result<serde_json::Value> {
        let results = self.engine.execute_batch(&statements).map_err(engine_error)?;
        engine_json(sqlite::results_json(&results))
    }

    /// Reopens an existing main-file image and rebuilds its schema catalog.
    #[napi(factory)]
    pub fn fromSnapshot(bytes: Buffer) -> napi::Result<Self> {
        let writer =
            sqlite::SqliteWriter::from_pages(bytes.to_vec()).map_err(|error| napi::Error::from_reason(error.to_string()))?;
        sqlite::Engine::from_writer(writer).map(|engine| Self { engine }).map_err(engine_error)
    }

    /// Executes one statement with positional `?` parameters bound in order.
    #[napi]
    pub fn executeWithParameters(
        &mut self,
        statement: String,
        parameters: Vec<serde_json::Value>,
    ) -> napi::Result<serde_json::Value> {
        let cells = parameters.iter().map(json_to_cell).collect::<napi::Result<Vec<_>>>()?;
        let results = self.engine.execute_with_parameters(&statement, &cells).map_err(engine_error)?;
        engine_json(sqlite::results_json(&results))
    }

    /// Executes exactly one statement with faithfully typed parameters and
    /// returns the result with native JS values: INTEGER stays `bigint`, REAL is
    /// `number`, TEXT is `string`, BLOB is a `Buffer`, NULL is `null`.
    #[napi]
    pub fn runTyped(&mut self, statement: String, parameters: Option<Vec<SqlParam>>) -> napi::Result<TypedRunResult> {
        let cells = parameters.unwrap_or_default().into_iter().map(SqlParam::into_cell).collect::<Vec<_>>();
        let results = self.engine.execute_with_parameters(&statement, &cells).map_err(engine_error)?;
        let result = match results.as_slice() {
            [one] => one.clone(),
            [] => return Err(napi::Error::from_reason("sqlite engine returned no result")),
            _ => return Err(napi::Error::from_reason("sqlite prepared statement must contain exactly one statement")),
        };
        Ok(TypedRunResult { result, last_insert_rowid: self.engine.last_insert_rowid() })
    }

    /// Live transaction state read from the engine, not mirrored in JS.
    #[napi]
    pub fn inTransaction(&self) -> bool {
        self.engine.in_transaction()
    }

    /// `sqlite3_last_insert_rowid()` for this connection.
    #[napi]
    pub fn lastInsertRowid(&self) -> i64 {
        self.engine.last_insert_rowid()
    }

    /// Executes one statement without throwing, returning `{ok, result}` or `{ok, error}`.
    #[napi]
    pub fn tryExecute(&mut self, statement: String) -> serde_json::Value {
        match self.engine.execute_one(&statement) {
            Ok(result) => serde_json::json!({
                "ok": true,
                "result": serde_json::from_str::<serde_json::Value>(&result.to_json()).unwrap_or(serde_json::Value::Null),
            }),
            Err(error) => serde_json::json!({
                "ok": false,
                "error": serde_json::from_str::<serde_json::Value>(&error.to_json()).unwrap_or(serde_json::Value::Null),
            }),
        }
    }

    /// Raw main-file image, ready to be written as a `.sqlite3` file.
    #[napi]
    pub fn snapshot(&mut self) -> napi::Result<Buffer> {
        let image = self.engine.snapshot().map_err(engine_error)?;
        Ok(image.to_vec().into())
    }

    /// Configured page size.
    #[napi]
    pub fn pageSize(&self) -> u32 {
        self.engine.page_size()
    }

    /// Format-3 library version stamped in the image header.
    #[napi]
    pub fn sqliteVersion(&self) -> napi::Result<String> {
        self.engine.sqlite_version().map(|version| version.to_string()).map_err(engine_error)
    }

    /// Health probe that re-validates the current image header.
    #[napi]
    pub fn ping(&mut self) -> napi::Result<i32> {
        let image = self.engine.snapshot().map_err(engine_error)?;
        sqlite::validate_database(image).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(1)
    }
}
