#![allow(non_snake_case)]

use std::ptr;

use database::harness::chart::{BenchMetric, bench_chart_svg};
use database::harness::{
    Baseline, BaselineIdentity, BenchRow, Comparison, CompareMode, DifferenceObservation, Digest, FuzzInput, FuzzPlan, Grammar, KnownDifference,
    Observed, ReportEnvelope, ShrinkSession, Stats, check_baseline, classify, compare, generate, per_op_ms, render, render_json, shrink_next,
    shrink_report, shrink_start, summarize,
};
use napi::{
    bindgen_prelude::{BigInt, Buffer, FromNapiValue, ToNapiValue, TypeName, Unknown, ValueType},
    sys,
};
use napi_derive::napi;
use sqlite::{
    RecordLimits, RecordValue, SchemaObjectKind, TableLimits, TextEncoding, decode_library_version, decode_record,
    read_named_table, read_schema, validate_database,
};

/// Optional resource bounds for each schema or table scan.
#[napi(object)]
pub struct SqliteReadLimits {
    pub max_pages: Option<u32>,
    pub max_rows: Option<u32>,
    pub max_payload_bytes: Option<u32>,
    pub max_total_payload_bytes: Option<u32>,
}

impl SqliteReadLimits {
    fn resolve(limits: Option<Self>) -> TableLimits {
        let default = TableLimits::default();
        match limits {
            None => default,
            Some(limits) => TableLimits {
                max_pages: limits.max_pages.map_or(default.max_pages, |v| v as usize),
                max_rows: limits.max_rows.map_or(default.max_rows, |v| v as usize),
                max_payload_bytes: limits.max_payload_bytes.map_or(default.max_payload_bytes, |v| v as usize),
                max_total_payload_bytes: limits.max_total_payload_bytes.map_or(default.max_total_payload_bytes, |v| v as usize),
            },
        }
    }
}

/// The five SQLite schema columns, with SQL retained as opaque source.
#[napi(object)]
pub struct SqliteSchemaObject {
    pub kind: String,
    pub name: String,
    pub table_name: String,
    pub root_page: Option<u32>,
    pub sql: Option<String>,
}

/// An undecoded SQLite table record with lossless rowid and binary payload.
#[napi(object)]
pub struct SqliteTableRow {
    pub rowid: BigInt,
    pub payload: Buffer,
}

fn encode_encoding(name: Option<&str>) -> napi::Result<TextEncoding> {
    match name {
        None | Some("utf8") | Some("utf-8") | Some("UTF-8") => Ok(TextEncoding::Utf8),
        Some("utf16le") | Some("utf-16le") | Some("UTF-16LE") => Ok(TextEncoding::Utf16Le),
        Some("utf16be") | Some("utf-16be") | Some("UTF-16BE") => Ok(TextEncoding::Utf16Be),
        Some(other) => Err(napi::Error::from_reason(format!(
            "unsupported SQLite text encoding {other}; expected utf8, utf16le, or utf16be"
        ))),
    }
}

fn detect_encoding(bytes: &[u8]) -> napi::Result<TextEncoding> {
    if bytes.len() < 64 {
        return Err(napi::Error::from_reason("sqlite snapshot has no text encoding"));
    }
    match u32::from_be_bytes(bytes[56..60].try_into().unwrap()) {
        1 => Ok(TextEncoding::Utf8),
        2 => Ok(TextEncoding::Utf16Le),
        3 => Ok(TextEncoding::Utf16Be),
        _ => Err(napi::Error::from_reason("sqlite snapshot has unknown text encoding")),
    }
}

fn resolve_encoding_name(bytes: &[u8]) -> napi::Result<&'static str> {
    if bytes.len() < 64 {
        return Ok("utf8");
    }
    Ok(match u32::from_be_bytes(bytes[56..60].try_into().unwrap()) {
        1 => "utf8",
        2 => "utf16le",
        3 => "utf16be",
        _ => return Err(napi::Error::from_reason("sqlite snapshot has unknown text encoding")),
    })
}

/// 行对象上的两个属性键，每次调用只创建一次。
struct RowKeys {
    rowid: sys::napi_value,
    columns: sys::napi_value,
}

unsafe fn js_string(env: sys::napi_env, text: &[u8]) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_string_utf8(env, text.as_ptr().cast(), text.len() as isize, &mut value) })?;
    Ok(value)
}

impl RowKeys {
    unsafe fn new(env: sys::napi_env) -> napi::Result<Self> {
        unsafe { Ok(Self { rowid: js_string(env, b"rowid")?, columns: js_string(env, b"columns")? }) }
    }
}

unsafe fn create_object(env: sys::napi_env) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_object(env, &mut value) })?;
    Ok(value)
}

unsafe fn create_array(env: sys::napi_env, length: usize) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_array_with_length(env, length, &mut value) })?;
    Ok(value)
}

unsafe fn create_integer(env: sys::napi_env, integer: i64) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_bigint_int64(env, integer, &mut value) })?;
    Ok(value)
}

unsafe fn create_real(env: sys::napi_env, real: f64) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_double(env, real, &mut value) })?;
    Ok(value)
}

unsafe fn set_property(
    env: sys::napi_env,
    object: sys::napi_value,
    key: sys::napi_value,
    value: sys::napi_value,
) -> napi::Result<()> {
    napi::check_status!(unsafe { sys::napi_set_property(env, object, key, value) })
}

unsafe fn set_element(env: sys::napi_env, array: sys::napi_value, index: usize, value: sys::napi_value) -> napi::Result<()> {
    napi::check_status!(unsafe { sys::napi_set_element(env, array, index as u32, value) })
}

unsafe fn create_null(env: sys::napi_env) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_get_null(env, &mut value) })?;
    Ok(value)
}

/// 把一个解码值写进数组：整数用 bigint、实数用 number、文本用 string、blob 用 Buffer、NULL 用 null。
///
/// 存储类别由 JS 类型本身表达，不再为每个单元格创建带 `kind` 的对象。
unsafe fn set_value(env: sys::napi_env, array: sys::napi_value, index: usize, value: RecordValue<'_>) -> napi::Result<()> {
    unsafe {
        let js = match value {
            RecordValue::Null => create_null(env)?,
            RecordValue::Integer(integer) => create_integer(env, integer)?,
            RecordValue::Real(real) => create_real(env, real)?,
            RecordValue::Text(text) => js_string(env, text.as_bytes())?,
            RecordValue::Blob(blob) => <Buffer as ToNapiValue>::to_napi_value(env, Buffer::from(blob.to_vec()))?,
        };
        set_element(env, array, index, js)
    }
}

/// 绑定层统一的记录解码上限：列数固定 1024，载荷上限至少 1 MiB。
fn record_limits(limits: TableLimits) -> RecordLimits {
    RecordLimits { max_columns: 1024, max_payload_bytes: limits.max_payload_bytes.max(1_048_576) }
}

/// 一次普通表扫描的结果，直接写入公开的 `DecodedRow[]` 形状。
///
/// `rowid`/`columns` 两个键每次调用只创建一次，整数用原生 `i64` bigint 构造。
pub struct DecodedRows {
    rows: Vec<sqlite::TableRow>,
    encoding: TextEncoding,
    limits: RecordLimits,
}

impl DecodedRows {
    fn new(bytes: &[u8], rows: Vec<sqlite::TableRow>, limits: TableLimits) -> napi::Result<Self> {
        Ok(Self { rows, encoding: detect_encoding(bytes)?, limits: record_limits(limits) })
    }
}

impl TypeName for DecodedRows {
    fn type_name() -> &'static str {
        "Array<DecodedRow>"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ToNapiValue for DecodedRows {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let keys = RowKeys::new(env)?;
            let rows = create_array(env, val.rows.len())?;
            for (row_index, row) in val.rows.iter().enumerate() {
                let values = decode_record(&row.payload, val.encoding, val.limits)
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
                let row_object = create_object(env)?;
                set_property(env, row_object, keys.rowid, create_integer(env, i64::from(row.rowid))?)?;
                let columns = create_array(env, values.len())?;
                for (slot, value) in values.into_iter().enumerate() {
                    set_value(env, columns, slot, value)?;
                }
                set_property(env, row_object, keys.columns, columns)?;
                set_element(env, rows, row_index, row_object)?;
            }
            Ok(rows)
        }
    }
}

/// WITHOUT ROWID 表的一次扫描结果，直接写入 `DecodedValue[][]`。
pub struct DecodedValueRows {
    payloads: Vec<Vec<u8>>,
    encoding: TextEncoding,
    limits: RecordLimits,
}

impl DecodedValueRows {
    fn new(bytes: &[u8], payloads: Vec<Vec<u8>>, limits: TableLimits) -> napi::Result<Self> {
        Ok(Self { payloads, encoding: detect_encoding(bytes)?, limits: record_limits(limits) })
    }
}

impl TypeName for DecodedValueRows {
    fn type_name() -> &'static str {
        "Array<Array<DecodedValue>>"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ToNapiValue for DecodedValueRows {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let rows = create_array(env, val.payloads.len())?;
            for (row_index, payload) in val.payloads.iter().enumerate() {
                let values = decode_record(payload, val.encoding, val.limits)
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
                let columns = create_array(env, values.len())?;
                for (slot, value) in values.into_iter().enumerate() {
                    set_value(env, columns, slot, value)?;
                }
                set_element(env, rows, row_index, columns)?;
            }
            Ok(rows)
        }
    }
}

/// 索引项扫描结果，直接写入 `DecodedRow[]`，rowid 取记录的最后一段。
pub struct DecodedIndexRows {
    payloads: Vec<Vec<u8>>,
    encoding: TextEncoding,
    limits: RecordLimits,
}

impl DecodedIndexRows {
    fn new(bytes: &[u8], payloads: Vec<Vec<u8>>, limits: TableLimits) -> napi::Result<Self> {
        Ok(Self { payloads, encoding: detect_encoding(bytes)?, limits: record_limits(limits) })
    }
}

impl TypeName for DecodedIndexRows {
    fn type_name() -> &'static str {
        "Array<DecodedRow>"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ToNapiValue for DecodedIndexRows {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let keys = RowKeys::new(env)?;
            let rows = create_array(env, val.payloads.len())?;
            for (row_index, payload) in val.payloads.iter().enumerate() {
                let mut values = decode_record(payload, val.encoding, val.limits)
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
                let trailing =
                    values.pop().ok_or_else(|| napi::Error::from_reason("sqlite index record has no rowid column"))?;
                let rowid = match trailing {
                    RecordValue::Integer(rowid) => rowid,
                    _ => return Err(napi::Error::from_reason("sqlite index record rowid is not an integer")),
                };
                let row_object = create_object(env)?;
                set_property(env, row_object, keys.rowid, create_integer(env, rowid)?)?;
                let columns = create_array(env, values.len())?;
                for (slot, value) in values.into_iter().enumerate() {
                    set_value(env, columns, slot, value)?;
                }
                set_property(env, row_object, keys.columns, columns)?;
                set_element(env, rows, row_index, row_object)?;
            }
            Ok(rows)
        }
    }
}

/// 单条记录的解码结果，直接写入 `DecodedValue[]`。
pub struct DecodedValues {
    payload: Vec<u8>,
    encoding: TextEncoding,
    limits: RecordLimits,
}

impl DecodedValues {
    fn new(payload: Vec<u8>, encoding: TextEncoding, limits: RecordLimits) -> Self {
        Self { payload, encoding, limits }
    }
}

impl TypeName for DecodedValues {
    fn type_name() -> &'static str {
        "Array<DecodedValue>"
    }

    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ToNapiValue for DecodedValues {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let values = decode_record(&val.payload, val.encoding, val.limits)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            let array = create_array(env, values.len())?;
            for (slot, value) in values.into_iter().enumerate() {
                set_value(env, array, slot, value)?;
            }
            Ok(array)
        }
    }
}

/// Owned, read-only main-file bytes, independent of the YYDB engine runtime.
#[napi]
pub struct SqliteSnapshot {
    bytes: Vec<u8>,
}

#[napi]
impl SqliteSnapshot {
    /// Copies a validated snapshot, bounded to 256 MiB unless overridden.
    #[napi(constructor)]
    pub fn new(bytes: Buffer, max_snapshot_bytes: Option<u32>) -> napi::Result<Self> {
        let maximum = max_snapshot_bytes.unwrap_or(256 * 1024 * 1024) as usize;
        if bytes.len() > maximum {
            return Err(napi::Error::from_reason("sqlite snapshot byte limit exceeded"));
        }
        validate_database(&bytes).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut snapshot = Vec::new();
        snapshot.try_reserve_exact(bytes.len()).map_err(|_| napi::Error::from_reason("sqlite snapshot allocation failed"))?;
        snapshot.extend_from_slice(&bytes);
        Ok(Self { bytes: snapshot })
    }

    /// Returns typed schema objects without parsing their SQL definitions.
    #[napi]
    pub fn schema(&self, limits: Option<SqliteReadLimits>) -> napi::Result<Vec<SqliteSchemaObject>> {
        read_schema(&self.bytes, SqliteReadLimits::resolve(limits))
            .map(|objects| {
                objects
                    .into_iter()
                    .map(|object| SqliteSchemaObject {
                        kind: match object.kind {
                            SchemaObjectKind::Table => "table",
                            SchemaObjectKind::Index => "index",
                            SchemaObjectKind::View => "view",
                            SchemaObjectKind::Trigger => "trigger",
                        }
                        .into(),
                        name: object.name,
                        table_name: object.table_name,
                        root_page: object.root_page,
                        sql: object.sql,
                    })
                    .collect()
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Reads raw records from an ordinary rowid table.
    #[napi]
    pub fn table(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<Vec<SqliteTableRow>> {
        read_named_table(&self.bytes, &name, SqliteReadLimits::resolve(limits))
            .map(|rows| {
                rows.into_iter()
                    .map(|row| SqliteTableRow { rowid: BigInt::from(i64::from(row.rowid)), payload: row.payload.into() })
                    .collect()
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Reads decoded typed records from an ordinary rowid table.
    #[napi]
    pub fn tableDecoded(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows = read_named_table(&self.bytes, &name, resolved).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        DecodedRows::new(&self.bytes, rows, resolved)
    }

    /// SQLite library version stamped in the snapshot header.
    #[napi]
    pub fn sqliteVersion(&self) -> napi::Result<String> {
        decode_library_version(&self.bytes).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Returns the decoded text encoding label (`utf8`, `utf16le`, or `utf16be`).
    #[napi]
    pub fn encoding(&self) -> napi::Result<String> {
        resolve_encoding_name(&self.bytes).map(|s| s.to_owned())
    }

    /// Health probe that re-validates the main-file format.
    #[napi]
    pub fn ping(&self) -> napi::Result<i32> {
        validate_database(&self.bytes).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(1)
    }

    /// Returns a view over the raw main-file bytes.
    #[napi]
    pub fn pages(&self) -> napi::Result<Buffer> {
        Ok(self.bytes.clone().into())
    }
}

/// A file-backed or in-memory SQLite snapshot handle (main-file only, no WAL recovery).
///
/// Read-only inspection surface. SQL execution is intentionally absent —
/// host applications that need SELECT/INSERT use the YYDB engine instead.
/// The binding owns the facade handle so the reader's schema cache survives
/// across calls; it only maps types and errors.
#[napi]
pub struct SqliteDatabase {
    inner: sqlite::SqliteDatabase,
    path: Option<std::path::PathBuf>,
}

#[napi]
impl SqliteDatabase {
    /// Opens a blank in-memory SQLite format-3 snapshot.
    #[napi(factory)]
    pub fn openInMemory() -> napi::Result<Self> {
        let inner = sqlite::SqliteDatabase::open_in_memory().map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self { inner, path: None })
    }

    /// Opens or creates a file-backed SQLite snapshot, replaying `-wal` or a hot `-journal` in memory.
    #[napi(factory)]
    pub fn open(path: String) -> napi::Result<Self> {
        let path_buf = std::path::PathBuf::from(&path);
        let inner = sqlite::SqliteDatabase::open(&path_buf).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self { inner, path: Some(path_buf) })
    }

    /// File path when file-backed, otherwise `null`.
    #[napi]
    pub fn path(&self) -> Option<String> {
        self.path.as_ref().map(|p| p.display().to_string())
    }

    /// Health probe that re-validates the main-file format.
    #[napi]
    pub fn ping(&self) -> napi::Result<i32> {
        self.inner.ping().map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// SQLite library version stamped in the snapshot header.
    #[napi]
    pub fn sqliteVersion(&self) -> napi::Result<String> {
        self.inner.sqlite_version().map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Returns the decoded text encoding label.
    #[napi]
    pub fn encoding(&self) -> napi::Result<String> {
        resolve_encoding_name(self.inner.pages()).map(|s| s.to_owned())
    }

    /// Returns typed schema objects.
    #[napi]
    pub fn schema(&self, limits: Option<SqliteReadLimits>) -> napi::Result<Vec<SqliteSchemaObject>> {
        self.inner
            .schema(SqliteReadLimits::resolve(limits))
            .map(|objects| {
                objects
                    .into_iter()
                    .map(|object| SqliteSchemaObject {
                        kind: match object.kind {
                            SchemaObjectKind::Table => "table",
                            SchemaObjectKind::Index => "index",
                            SchemaObjectKind::View => "view",
                            SchemaObjectKind::Trigger => "trigger",
                        }
                        .into(),
                        name: object.name,
                        table_name: object.table_name,
                        root_page: object.root_page,
                        sql: object.sql,
                    })
                    .collect()
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Reads decoded typed records from an ordinary rowid table.
    #[napi]
    pub fn table(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows = self.inner.table(&name, resolved).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        DecodedRows::new(self.inner.pages(), rows, resolved)
    }

    /// Reads one decoded row by its rowid; `null` when the rowid is absent.
    #[napi]
    pub fn rowByRowid(&self, name: String, rowid: i64, limits: Option<SqliteReadLimits>) -> napi::Result<Option<DecodedRows>> {
        let resolved = SqliteReadLimits::resolve(limits);
        let row = self.inner.row_by_rowid(&name, rowid).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        match row {
            Some(row) => DecodedRows::new(self.inner.pages(), vec![row], resolved).map(Some),
            None => Ok(None),
        }
    }

    /// Reads decoded typed records whose rowid lies in the inclusive range
    /// `[lower, upper]`, in rowid order.
    #[napi]
    pub fn range(&self, name: String, lower: i64, upper: i64, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows =
            self.inner.table_range(&name, lower, upper, resolved).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        DecodedRows::new(self.inner.pages(), rows, resolved)
    }

    /// Reads decoded typed records from a WITHOUT ROWID table in primary-key order.
    #[napi]
    pub fn tableWithoutRowid(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedValueRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let payloads = self.inner.table_without_rowid(&name, resolved).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        DecodedValueRows::new(self.inner.pages(), payloads, resolved)
    }

    /// Reads decoded typed entries from a secondary index in key order.
    #[napi]
    pub fn index(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedIndexRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let payloads = self.inner.index(&name, resolved).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        DecodedIndexRows::new(self.inner.pages(), payloads, resolved)
    }

    /// Reads raw records (undecoded payload) from an ordinary rowid table.
    #[napi]
    pub fn tableRaw(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<Vec<SqliteTableRow>> {
        self.inner
            .table(&name, SqliteReadLimits::resolve(limits))
            .map(|rows| {
                rows.into_iter()
                    .map(|row| SqliteTableRow { rowid: BigInt::from(i64::from(row.rowid)), payload: row.payload.into() })
                    .collect()
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Returns a view over the raw main-file bytes.
    #[napi]
    pub fn pages(&self) -> napi::Result<Buffer> {
        Ok(self.inner.pages().to_vec().into())
    }
}

/// Decodes one SQLite record payload into typed storage-class values.
#[napi]
pub fn decodeRecord(payload: Buffer, encoding: Option<String>) -> napi::Result<DecodedValues> {
    let encoding = encode_encoding(encoding.as_deref())?;
    let limits = RecordLimits { max_columns: 1024, max_payload_bytes: payload.len().max(1_048_576) };
    Ok(DecodedValues::new(payload.to_vec(), encoding, limits))
}

/// One column definition for [`SqliteWriter::createTable`] (JSON form).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriterColumnJson {
    name: String,
    #[serde(default)]
    declared_type: Option<String>,
    #[serde(default)]
    not_null: Option<bool>,
    #[serde(default)]
    default_value: Option<serde_json::Value>,
    #[serde(default)]
    default_text: Option<String>,
    #[serde(default)]
    primary_key: Option<bool>,
    #[serde(default)]
    unique: Option<bool>,
    #[serde(default)]
    autoincrement: Option<bool>,
    /// 列级 `COLLATE`，取值为 `BINARY` / `NOCASE` / `RTRIM`。
    #[serde(default)]
    collate: Option<String>,
}

/// One decoded `valuesJson` element: an omitted column or a bound write value.
enum InsertSlot {
    Omit,
    Value(sqlite::WriteValue),
}

fn blob_from_hex(hex: &str) -> Result<sqlite::WriteValue, String> {
    if hex.len() % 2 != 0 {
        return Err("sqlite blob hex must have even length".to_string());
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for index in 0..hex.len() / 2 {
        let byte =
            u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| "sqlite blob hex is not valid".to_string())?;
        bytes.push(byte);
    }
    Ok(sqlite::WriteValue::Blob(bytes))
}

struct InsertSlotVisitor;

impl<'de> serde::de::Visitor<'de> for InsertSlotVisitor {
    type Value = InsertSlot;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a sqlite write value")
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(sqlite::WriteValue::Null))
    }

    fn visit_bool<E: serde::de::Error>(self, flag: bool) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(sqlite::WriteValue::Integer(i64::from(flag))))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(sqlite::WriteValue::Integer(value)))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(match i64::try_from(value) {
            Ok(integer) => sqlite::WriteValue::Integer(integer),
            Err(_) => sqlite::WriteValue::Real(value as f64),
        }))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(sqlite::WriteValue::Real(value)))
    }

    fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(sqlite::WriteValue::Text(text.to_string())))
    }

    fn visit_string<E: serde::de::Error>(self, text: String) -> Result<InsertSlot, E> {
        Ok(InsertSlot::Value(sqlite::WriteValue::Text(text)))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<InsertSlot, A::Error> {
        let mut omit = false;
        let mut blob = None;
        let mut integer = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "$omit" => omit = map.next_value::<bool>()?,
                "$blob" => blob = Some(map.next_value::<String>()?),
                "$i64" => integer = Some(map.next_value::<String>()?),
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        if omit {
            return Ok(InsertSlot::Omit);
        }
        if let Some(hex) = blob {
            return blob_from_hex(&hex).map(InsertSlot::Value).map_err(serde::de::Error::custom);
        }
        if let Some(text) = integer {
            return text
                .parse::<i64>()
                .map(|value| InsertSlot::Value(sqlite::WriteValue::Integer(value)))
                .map_err(|_| serde::de::Error::custom("sqlite $i64 value must be a decimal string"));
        }
        Err(serde::de::Error::custom("sqlite write value object must carry `$blob` or `$i64`"))
    }
}

impl<'de> serde::Deserialize<'de> for InsertSlot {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(InsertSlotVisitor)
    }
}

/// Converts one JSON value into a write value. Kept for `update`, whose
/// `{"set": ...}` wrapper needs the intermediate JSON node.
fn json_to_write_value(json: &serde_json::Value) -> napi::Result<sqlite::WriteValue> {
    Ok(match json {
        serde_json::Value::Null => sqlite::WriteValue::Null,
        serde_json::Value::Bool(flag) => sqlite::WriteValue::Integer(i64::from(*flag)),
        serde_json::Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                sqlite::WriteValue::Integer(integer)
            }
            else if let Some(real) = number.as_f64() {
                sqlite::WriteValue::Real(real)
            }
            else {
                return Err(napi::Error::from_reason("sqlite write value number out of range"));
            }
        }
        serde_json::Value::String(text) => sqlite::WriteValue::Text(text.clone()),
        serde_json::Value::Object(object) => {
            if let Some(hex) = object.get("$blob").and_then(serde_json::Value::as_str) {
                blob_from_hex(hex).map_err(napi::Error::from_reason)?
            }
            else if let Some(integer) = object.get("$i64").and_then(serde_json::Value::as_str) {
                let value = integer
                    .parse::<i64>()
                    .map_err(|_| napi::Error::from_reason("sqlite $i64 value must be a decimal string"))?;
                sqlite::WriteValue::Integer(value)
            }
            else {
                return Err(napi::Error::from_reason("sqlite write value object must carry `$blob` or `$i64`"));
            }
        }
        serde_json::Value::Array(_) => return Err(napi::Error::from_reason("sqlite write value must not be an array")),
    })
}

/// Converts one JSON value into a bound parameter cell. `$blob` and `$i64`
/// carry values JSON numbers cannot represent exactly.
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

/// Writes SQLite format-3 database files that upstream SQLite implementations
/// open directly. The writer keeps the image in memory until [`save`](SqliteWriter::save).
#[napi]
pub struct SqliteWriter {
    writer: sqlite::SqliteWriter,
}

#[napi]
impl SqliteWriter {
    /// Creates a fresh database image with the given page size (default 4096).
    #[napi(factory)]
    pub fn create(page_size: Option<u32>) -> napi::Result<Self> {
        let page_size = page_size.unwrap_or(4096) as usize;
        let writer = sqlite::SqliteWriter::create(page_size).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self { writer })
    }

    /// Loads an existing SQLite main file for further mutation.
    #[napi(factory)]
    pub fn open(path: String) -> napi::Result<Self> {
        let writer = sqlite::SqliteWriter::open(&path).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self { writer })
    }

    /// Creates a table; `columnsJson` is `[{name, declaredType, notNull,
    /// defaultValue, primaryKey, unique, autoincrement}]` with SQLite
    /// semantics.
    #[napi]
    pub fn createTable(&mut self, name: String, columns_json: String) -> napi::Result<()> {
        let columns: Vec<WriterColumnJson> = serde_json::from_str(&columns_json)
            .map_err(|e| napi::Error::from_reason(format!("sqlite columns JSON invalid: {e}")))?;
        let mut specs = Vec::with_capacity(columns.len());
        for column in columns {
            specs.push(sqlite::ColumnSpec {
                name: column.name,
                declared_type: column.declared_type.unwrap_or_else(|| "BLOB".to_string()),
                not_null: column.not_null.unwrap_or(false),
                default_value: match column.default_value {
                    Some(json) => Some(json_to_write_value(&json)?),
                    None => None,
                },
                default_text: column.default_text,
                primary_key: column.primary_key.unwrap_or(false),
                unique: column.unique.unwrap_or(false),
                autoincrement: column.autoincrement.unwrap_or(false),
                collate: match column.collate {
                    Some(name) => Some(
                        sqlite::Collation::parse(&name)
                            .ok_or_else(|| napi::Error::from_reason(format!("no such collation sequence: {name}")))?,
                    ),
                    None => None,
                },
            });
        }
        self.writer.create_table(&name, &specs).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Creates an index over one or more columns.
    #[napi]
    pub fn createIndex(&mut self, name: String, table: String, columns: Vec<String>, unique: Option<bool>) -> napi::Result<()> {
        self.writer
            .create_index(&name, &table, &columns, unique.unwrap_or(false))
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Inserts one row. `valuesJson` is a JSON array; `null` is an explicit
    /// NULL and `{"$omit":true}` applies the column default. Returns the rowid.
    #[napi]
    pub fn insert(&mut self, table: String, values_json: String) -> napi::Result<i64> {
        let values: Vec<InsertSlot> = serde_json::from_str(&values_json)
            .map_err(|e| napi::Error::from_reason(format!("sqlite values JSON invalid: {e}")))?;
        let mut slots = Vec::with_capacity(values.len());
        for value in values {
            match value {
                InsertSlot::Omit => slots.push(None),
                InsertSlot::Value(value) => slots.push(Some(value)),
            }
        }
        self.writer.insert(&table, &slots).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Deletes one row by rowid; returns whether a row was removed.
    #[napi]
    pub fn delete(&mut self, table: String, rowid: i64) -> napi::Result<bool> {
        self.writer.delete(&table, rowid).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Updates one row by rowid. `slotsJson` is a JSON array where each slot
    /// is `{"keep":true}` or `{"set":<value>}`. Returns whether a row changed.
    #[napi]
    pub fn update(&mut self, table: String, rowid: i64, slots_json: String) -> napi::Result<bool> {
        let values: Vec<serde_json::Value> = serde_json::from_str(&slots_json)
            .map_err(|e| napi::Error::from_reason(format!("sqlite slots JSON invalid: {e}")))?;
        let mut slots = Vec::with_capacity(values.len());
        for value in values {
            let object = value.as_object().ok_or_else(|| napi::Error::from_reason("sqlite update slot must be an object"))?;
            if object.get("keep").and_then(serde_json::Value::as_bool).unwrap_or(false) {
                slots.push(sqlite::UpdateValue::Keep);
                continue;
            }
            match object.get("set") {
                Some(inner) => slots.push(sqlite::UpdateValue::Set(json_to_write_value(inner)?)),
                None => return Err(napi::Error::from_reason("sqlite update slot needs `keep` or `set`")),
            }
        }
        self.writer.update(&table, rowid, &slots).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Starts an in-memory transaction.
    #[napi]
    pub fn begin(&mut self) -> napi::Result<()> {
        self.writer.begin().map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Commits the open transaction.
    #[napi]
    pub fn commit(&mut self) -> napi::Result<()> {
        self.writer.commit().map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Rolls the image back to the state before `begin`.
    #[napi]
    pub fn rollback(&mut self) -> napi::Result<()> {
        self.writer.rollback().map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Bumps the change counter and writes the image to `path`.
    #[napi]
    pub fn save(&mut self, path: String) -> napi::Result<()> {
        self.writer.save(&path).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// When `on`, `save` syncs the file to disk after writing (upstream
    /// `PRAGMA synchronous=FULL`); the default `off` leaves durability to the
    /// operating system cache (`synchronous=OFF`).
    #[napi]
    pub fn setSynchronous(&mut self, on: bool) {
        self.writer.set_synchronous(on);
    }

    /// Returns the raw file image.
    #[napi]
    pub fn pages(&self) -> Buffer {
        self.writer.pages().to_vec().into()
    }

    /// Page size of this database image.
    #[napi]
    pub fn pageSize(&self) -> u32 {
        self.writer.page_size() as u32
    }

    /// Reads schema objects back through the crate's own reader.
    #[napi]
    pub fn schema(&self, limits: Option<SqliteReadLimits>) -> napi::Result<Vec<SqliteSchemaObject>> {
        self.writer
            .schema_objects(SqliteReadLimits::resolve(limits))
            .map(|objects| {
                objects
                    .into_iter()
                    .map(|object| SqliteSchemaObject {
                        kind: match object.kind {
                            SchemaObjectKind::Table => "table",
                            SchemaObjectKind::Index => "index",
                            SchemaObjectKind::View => "view",
                            SchemaObjectKind::Trigger => "trigger",
                        }
                        .into(),
                        name: object.name,
                        table_name: object.table_name,
                        root_page: object.root_page,
                        sql: object.sql,
                    })
                    .collect()
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Reads one table's decoded rows back through the crate's own reader.
    #[napi]
    pub fn tableDecoded(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows = self.writer.table_rows(&name, resolved).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        DecodedRows::new(self.writer.pages(), rows, resolved)
    }
}

fn engine_error(error: sqlite::SqlError) -> napi::Error {
    napi::Error::from_reason(error.message)
}

fn engine_json(text: String) -> napi::Result<serde_json::Value> {
    serde_json::from_str(&text).map_err(|e| napi::Error::from_reason(format!("sqlite result JSON invalid: {e}")))
}

/// 忠实类型化的绑定参数：TS 层已完成形状校验（`undefined`、Date、嵌套对象
/// 都在进入这里之前被拒绝），本层只做无损映射：`bigint`→INTEGER、
/// `number`→REAL、`string`→TEXT、`Buffer`/`Uint8Array`→BLOB、`null`→NULL、
/// `boolean`→INTEGER 0/1。不做任何按大小或按精度的自动改判。
pub struct SqlParam(sqlite::Cell);

impl SqlParam {
    fn into_cell(self) -> sqlite::Cell {
        self.0
    }
}

impl FromNapiValue for SqlParam {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        let unknown = Unknown::from_napi_value(env, value)?;
        let cell = match unknown.get_type()? {
            ValueType::Null => sqlite::Cell::Null,
            ValueType::Undefined => {
                return Err(napi::Error::from_reason("sqlite parameter must not be undefined; SQL NULL is explicit"));
            }
            ValueType::Boolean => sqlite::Cell::Integer(i64::from(bool::from_napi_value(env, value)?)),
            ValueType::Number => sqlite::Cell::Real(f64::from_napi_value(env, value)?),
            ValueType::String => sqlite::Cell::Text(String::from_napi_value(env, value)?),
            ValueType::BigInt => {
                // `get_i64` 返回 (value, lossless)，第二项为真才表示无损。
                let (integer, lossless) = BigInt::from_napi_value(env, value)?.get_i64();
                if !lossless {
                    return Err(napi::Error::from_reason("sqlite INTEGER parameter exceeds signed 64-bit range"));
                }
                sqlite::Cell::Integer(integer)
            }
            ValueType::Object => sqlite::Cell::Blob(Buffer::from_napi_value(env, value)?.to_vec()),
            kind => return Err(napi::Error::from_reason(format!("sqlite parameter has unsupported JS type {kind:?}"))),
        };
        Ok(Self(cell))
    }
}

/// 单语句执行的原生结果：`{statement, affected, lastInsertRowid, columns, rows}`，
/// 其中 INTEGER 以 `bigint` 呈现、BLOB 以 `Buffer` 呈现，不经过 JSON 信封。
pub struct TypedRunResult {
    result: sqlite::ExecResult,
    last_insert_rowid: i64,
}

impl ToNapiValue for TypedRunResult {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        let object = create_object(env)?;

        let key_statement = js_string(env, b"statement")?;
        let statement = js_string(env, val.result.statement.as_bytes())?;
        set_property(env, object, key_statement, statement)?;

        let key_affected = js_string(env, b"affected")?;
        let mut affected = ptr::null_mut();
        napi::check_status!(unsafe {
            sys::napi_create_uint32(env, val.result.affected.min(u32::MAX as usize) as u32, &mut affected)
        })?;
        set_property(env, object, key_affected, affected)?;

        let key_rowid = js_string(env, b"lastInsertRowid")?;
        let rowid = create_integer(env, val.last_insert_rowid)?;
        set_property(env, object, key_rowid, rowid)?;

        let key_columns = js_string(env, b"columns")?;
        let columns = create_array(env, val.result.columns.len())?;
        for (index, name) in val.result.columns.iter().enumerate() {
            set_element(env, columns, index, js_string(env, name.as_bytes())?)?;
        }
        set_property(env, object, key_columns, columns)?;

        let key_rows = js_string(env, b"rows")?;
        let rows = create_array(env, val.result.rows.len())?;
        for (row_index, row) in val.result.rows.iter().enumerate() {
            let array = create_array(env, row.len())?;
            for (column_index, cell) in row.iter().enumerate() {
                let js = match cell {
                    sqlite::Cell::Null => create_null(env)?,
                    sqlite::Cell::Integer(value) => create_integer(env, *value)?,
                    sqlite::Cell::Real(value) => create_real(env, *value)?,
                    sqlite::Cell::Text(text) => js_string(env, text.as_bytes())?,
                    sqlite::Cell::Blob(bytes) => <Buffer as ToNapiValue>::to_napi_value(env, Buffer::from(bytes.as_slice()))?,
                };
                set_element(env, array, column_index, js)?;
            }
            set_element(env, rows, row_index, array)?;
        }
        set_property(env, object, key_rows, rows)?;
        Ok(object)
    }
}

/// In-memory SQLite format-3 database with a fail-closed SQL subset.
///
/// The engine keeps the whole image in memory and runs every accepted statement
/// through the pure-Rust writer, so `snapshot()` yields a real `.sqlite3` file.
/// Unsupported statements are rejected with a structured error carrying
/// `code`, `statement`, `clause` and `position`; `tryExecute` returns that error
/// instead of throwing.
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
    /// returns the result with native JS values: INTEGER stays `bigint`,
    /// REAL is `number`, TEXT is `string`, BLOB is a `Buffer`, NULL is `null`.
    /// No JSON envelope, no size-based coercion — the TS layer owns validation
    /// (single statement, arity, `undefined`).
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
    pub fn snapshot(&self) -> Buffer {
        self.engine.snapshot().to_vec().into()
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
    pub fn ping(&self) -> napi::Result<i32> {
        validate_database(self.engine.snapshot()).map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(1)
    }
}

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
    per_op_ms(&Stats { median_ms: stats.median_ms, p95_ms: stats.p95_ms, min_ms: stats.min_ms, max_ms: stats.max_ms, rounds: stats.rounds }, u64::from(ops))
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

#[cfg(test)]
mod tests {
    use sqlite::sql::{Cell, Engine};

    // The Rust-side smoke test proves the workspace compiles and one
    // create/insert/select round trip returns the row it wrote. The published
    // host contract is judged by the `sqlite.ts` and `sqlite.py` suites.
    #[test]
    fn opens_and_round_trips_one_row() {
        let mut engine = Engine::new(None).expect("open");
        let results = engine
            .execute(
                "create table smoke (id integer primary key, label text not null); \
                 insert into smoke (label) values ('alpha'); \
                 select * from smoke;",
            )
            .expect("execute");
        assert_eq!(results.len(), 3);
        assert_eq!(results[2].rows, vec![vec![Cell::Integer(1), Cell::Text("alpha".to_string())]]);
    }

    #[test]
    fn rejections_carry_a_code_and_position() {
        let mut engine = Engine::new(None).expect("open");
        engine.execute("create table t (id integer primary key, label text)").expect("create");
        engine.execute("insert into t values (1, 'a'), (2, 'b'), (3, 'a')").expect("seed");
        // `GROUP BY` is supported; the grouped rows match SQLite 3.49.1.
        let grouped = engine.execute_one("select label, count(*) from t group by label order by label").expect("group by");
        assert_eq!(
            grouped.rows,
            vec![vec![Cell::Text("a".to_string()), Cell::Integer(2)], vec![Cell::Text("b".to_string()), Cell::Integer(1)],]
        );
        let unknown = engine.execute_one("insert into missing values (1)").expect_err("unknown table");
        assert_eq!(unknown.code, "unknown-table");
        assert_eq!(unknown.statement, Some("insert"));
    }

    #[test]
    fn where_and_order_by_follow_sqlite_ordering() {
        let mut engine = Engine::new(None).expect("open");
        engine
            .execute(
                "create table t (id integer primary key, label text, score real); \
                 insert into t (label, score) values ('b', 1.5), ('a', null), ('c', 2.0), (null, 0.0);",
            )
            .expect("seed");
        // `NULL` sorts below every number, so `DESC` puts it last.
        let ordered = engine.execute_one("select label from t order by score desc").expect("order");
        assert_eq!(
            ordered.rows,
            vec![
                vec![Cell::Text("c".to_string())],
                vec![Cell::Text("b".to_string())],
                vec![Cell::Null],
                vec![Cell::Text("a".to_string())],
            ]
        );
        let filtered = engine.execute_one("select label from t where score >= 1.5 order by id").expect("filter");
        assert_eq!(filtered.rows, vec![vec![Cell::Text("b".to_string())], vec![Cell::Text("c".to_string())]]);
        let counted = engine.execute_one("select count(*) from t where score is not null").expect("count");
        assert_eq!(counted.rows, vec![vec![Cell::Integer(3)]]);
        let unknown = engine.execute_one("select * from t where missing = 1").expect_err("unknown column");
        assert_eq!(unknown.code, "unknown-column");
    }
}
