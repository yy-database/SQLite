//! 检视与格式-3 工具面：`SqliteSnapshot`、`SqliteDatabase`、`SqliteWriter`
//! 与 `decodeRecord`。
//!
//! 这些是只读检视与快照构建的产品原语，不属于正式 SQL 连接入口；TS 侧经
//! `inspect` 子路径或开发工具加载，主包不公开。

use napi::{
    bindgen_prelude::{BigInt, Buffer, ToNapiValue},
    sys,
};
use napi_derive::napi;
use sqlite::{
    Collation, RecordLimits, RecordValue, SchemaObjectKind, TableLimits, TextEncoding, decode_library_version, decode_record,
    read_named_table, read_schema, validate_database,
};

use crate::{
    error::storage_error,
    values::{RowKeys, create_array, create_integer, create_object, set_element, set_property, set_value},
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

impl napi::bindgen_prelude::TypeName for DecodedRows {
    fn type_name() -> &'static str {
        "Array<DecodedRow>"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl ToNapiValue for DecodedRows {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let keys = RowKeys::new(env)?;
            let rows = create_array(env, val.rows.len())?;
            for (row_index, row) in val.rows.iter().enumerate() {
                let values = decode_record(&row.payload, val.encoding, val.limits).map_err(storage_error)?;
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

impl napi::bindgen_prelude::TypeName for DecodedValueRows {
    fn type_name() -> &'static str {
        "Array<Array<DecodedValue>>"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl ToNapiValue for DecodedValueRows {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let rows = create_array(env, val.payloads.len())?;
            for (row_index, payload) in val.payloads.iter().enumerate() {
                let values = decode_record(payload, val.encoding, val.limits).map_err(storage_error)?;
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

impl napi::bindgen_prelude::TypeName for DecodedIndexRows {
    fn type_name() -> &'static str {
        "Array<DecodedRow>"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl ToNapiValue for DecodedIndexRows {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let keys = RowKeys::new(env)?;
            let rows = create_array(env, val.payloads.len())?;
            for (row_index, payload) in val.payloads.iter().enumerate() {
                let mut values = decode_record(payload, val.encoding, val.limits).map_err(storage_error)?;
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

impl napi::bindgen_prelude::TypeName for DecodedValues {
    fn type_name() -> &'static str {
        "Array<DecodedValue>"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

impl ToNapiValue for DecodedValues {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let values = decode_record(&val.payload, val.encoding, val.limits).map_err(storage_error)?;
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
        validate_database(&bytes).map_err(storage_error)?;
        let mut snapshot = Vec::new();
        snapshot.try_reserve_exact(bytes.len()).map_err(|_| napi::Error::from_reason("sqlite snapshot allocation failed"))?;
        snapshot.extend_from_slice(&bytes);
        Ok(Self { bytes: snapshot })
    }

    /// Returns typed schema objects without parsing their SQL definitions.
    #[napi]
    pub fn schema(&self, limits: Option<SqliteReadLimits>) -> napi::Result<Vec<SqliteSchemaObject>> {
        read_schema(&self.bytes, SqliteReadLimits::resolve(limits))
            .map(|objects| objects.into_iter().map(to_schema_object).collect())
            .map_err(storage_error)
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
            .map_err(storage_error)
    }

    /// Reads decoded typed records from an ordinary rowid table.
    #[napi]
    pub fn tableDecoded(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows = read_named_table(&self.bytes, &name, resolved).map_err(storage_error)?;
        DecodedRows::new(&self.bytes, rows, resolved)
    }

    /// SQLite library version stamped in the snapshot header.
    #[napi]
    pub fn sqliteVersion(&self) -> napi::Result<String> {
        decode_library_version(&self.bytes).map_err(storage_error)
    }

    /// Returns the decoded text encoding label (`utf8`, `utf16le`, or `utf16be`).
    #[napi]
    pub fn encoding(&self) -> napi::Result<String> {
        resolve_encoding_name(&self.bytes).map(|s| s.to_owned())
    }

    /// Health probe that re-validates the main-file format.
    #[napi]
    pub fn ping(&self) -> napi::Result<i32> {
        validate_database(&self.bytes).map_err(storage_error)?;
        Ok(1)
    }

    /// Returns a view over the raw main-file bytes.
    #[napi]
    pub fn pages(&self) -> napi::Result<Buffer> {
        Ok(self.bytes.clone().into())
    }
}

fn to_schema_object(object: sqlite::SchemaObject) -> SqliteSchemaObject {
    SqliteSchemaObject {
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
    }
}

/// A file-backed or in-memory SQLite snapshot handle (main-file only, no WAL recovery).
///
/// Read-only inspection surface. SQL execution is intentionally absent —
/// host applications that need SELECT/INSERT use `SqliteConnection` instead.
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
        let inner = sqlite::SqliteDatabase::open_in_memory().map_err(storage_error)?;
        Ok(Self { inner, path: None })
    }

    /// Opens or creates a file-backed SQLite snapshot, replaying `-wal` or a hot `-journal` in memory.
    #[napi(factory)]
    pub fn open(path: String) -> napi::Result<Self> {
        let path_buf = std::path::PathBuf::from(&path);
        let inner = sqlite::SqliteDatabase::open(&path_buf).map_err(storage_error)?;
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
        self.inner.ping().map_err(storage_error)
    }

    /// SQLite library version stamped in the snapshot header.
    #[napi]
    pub fn sqliteVersion(&self) -> napi::Result<String> {
        self.inner.sqlite_version().map_err(storage_error)
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
            .map(|objects| objects.into_iter().map(to_schema_object).collect())
            .map_err(storage_error)
    }

    /// Reads decoded typed records from an ordinary rowid table.
    #[napi]
    pub fn table(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows = self.inner.table(&name, resolved).map_err(storage_error)?;
        DecodedRows::new(self.inner.pages(), rows, resolved)
    }

    /// Reads one decoded row by its rowid; `null` when the rowid is absent.
    #[napi]
    pub fn rowByRowid(&self, name: String, rowid: i64, limits: Option<SqliteReadLimits>) -> napi::Result<Option<DecodedRows>> {
        let resolved = SqliteReadLimits::resolve(limits);
        let row = self.inner.row_by_rowid(&name, rowid).map_err(storage_error)?;
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
        let rows = self.inner.table_range(&name, lower, upper, resolved).map_err(storage_error)?;
        DecodedRows::new(self.inner.pages(), rows, resolved)
    }

    /// Reads decoded typed records from a WITHOUT ROWID table in primary-key order.
    #[napi]
    pub fn tableWithoutRowid(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedValueRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let payloads = self.inner.table_without_rowid(&name, resolved).map_err(storage_error)?;
        DecodedValueRows::new(self.inner.pages(), payloads, resolved)
    }

    /// Reads decoded typed entries from a secondary index in key order.
    #[napi]
    pub fn index(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedIndexRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let payloads = self.inner.index(&name, resolved).map_err(storage_error)?;
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
            .map_err(storage_error)
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
        let writer = sqlite::SqliteWriter::create(page_size).map_err(storage_error)?;
        Ok(Self { writer })
    }

    /// Loads an existing SQLite main file for further mutation.
    #[napi(factory)]
    pub fn open(path: String) -> napi::Result<Self> {
        let writer = sqlite::SqliteWriter::open(&path).map_err(storage_error)?;
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
                        Collation::parse(&name)
                            .ok_or_else(|| napi::Error::from_reason(format!("no such collation sequence: {name}")))?,
                    ),
                    None => None,
                },
            });
        }
        self.writer.create_table(&name, &specs).map_err(storage_error)
    }

    /// Creates an index over one or more columns.
    #[napi]
    pub fn createIndex(&mut self, name: String, table: String, columns: Vec<String>, unique: Option<bool>) -> napi::Result<()> {
        self.writer.create_index(&name, &table, &columns, unique.unwrap_or(false)).map_err(storage_error)
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
        self.writer.insert(&table, &slots).map_err(storage_error)
    }

    /// Deletes one row by rowid; returns whether a row was removed.
    #[napi]
    pub fn delete(&mut self, table: String, rowid: i64) -> napi::Result<bool> {
        self.writer.delete(&table, rowid).map_err(storage_error)
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
        self.writer.update(&table, rowid, &slots).map_err(storage_error)
    }

    /// Starts an in-memory transaction.
    #[napi]
    pub fn begin(&mut self) -> napi::Result<()> {
        self.writer.begin().map_err(storage_error)
    }

    /// Commits the open transaction.
    #[napi]
    pub fn commit(&mut self) -> napi::Result<()> {
        self.writer.commit().map_err(storage_error)
    }

    /// Rolls the image back to the state before `begin`.
    #[napi]
    pub fn rollback(&mut self) -> napi::Result<()> {
        self.writer.rollback().map_err(storage_error)
    }

    /// Bumps the change counter and writes the image to `path`.
    #[napi]
    pub fn save(&mut self, path: String) -> napi::Result<()> {
        self.writer.save(&path).map_err(storage_error)
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
            .map(|objects| objects.into_iter().map(to_schema_object).collect())
            .map_err(storage_error)
    }

    /// Reads one table's decoded rows back through the crate's own reader.
    #[napi]
    pub fn tableDecoded(&self, name: String, limits: Option<SqliteReadLimits>) -> napi::Result<DecodedRows> {
        let resolved = SqliteReadLimits::resolve(limits);
        let rows = self.writer.table_rows(&name, resolved).map_err(storage_error)?;
        DecodedRows::new(self.writer.pages(), rows, resolved)
    }
}
