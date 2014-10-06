//! PyO3 bindings for SQLite format-3 snapshots.
//!
//! Every method delegates to the same pure-Rust `sqlite` facade used by the
//! Node-API and WebAssembly bindings; this crate only translates Python values.

#![deny(missing_docs)]

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyBytes, PyDict, PyList};
use sqlite::{
    ColumnSpec, RecordLimits, RecordValue, SchemaObjectKind, SqliteDatabase as Database, SqliteWriter as Writer, TableLimits, TableRow,
    TextEncoding, UpdateValue, WriteValue, decode_library_version, decode_record, validate_database,
};

fn runtime_error(error: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(error.to_string())
}

fn encoding_name(bytes: &[u8]) -> PyResult<&'static str> {
    if bytes.len() < 60 {
        return Err(PyRuntimeError::new_err("sqlite snapshot header is too short"));
    }
    match u32::from_be_bytes(bytes[56..60].try_into().unwrap()) {
        1 => Ok("utf-8"),
        2 => Ok("utf-16le"),
        3 => Ok("utf-16be"),
        _ => Err(PyRuntimeError::new_err("sqlite snapshot has an unknown text encoding")),
    }
}

fn encode_encoding(name: Option<&str>) -> PyResult<TextEncoding> {
    match name {
        None | Some("utf8") | Some("utf-8") | Some("UTF-8") => Ok(TextEncoding::Utf8),
        Some("utf16le") | Some("utf-16le") | Some("UTF-16LE") => Ok(TextEncoding::Utf16Le),
        Some("utf16be") | Some("utf-16be") | Some("UTF-16BE") => Ok(TextEncoding::Utf16Be),
        Some(other) => Err(PyRuntimeError::new_err(format!(
            "unsupported SQLite text encoding {other}; expected utf8, utf16le, or utf16be"
        ))),
    }
}

fn cell_to_py(py: Python<'_>, value: &RecordValue<'_>) -> PyResult<Py<PyAny>> {
    let cell = PyDict::new(py);
    match value {
        RecordValue::Null => {
            cell.set_item("kind", "null")?;
        }
        RecordValue::Integer(integer) => {
            cell.set_item("kind", "integer")?;
            cell.set_item("value", i64::from(*integer))?;
        }
        RecordValue::Real(real) => {
            cell.set_item("kind", "real")?;
            cell.set_item("value", *real)?;
        }
        RecordValue::Text(text) => {
            cell.set_item("kind", "text")?;
            cell.set_item("value", text.clone())?;
        }
        RecordValue::Blob(blob) => {
            cell.set_item("kind", "blob")?;
            cell.set_item("value", PyBytes::new(py, blob))?;
        }
    }
    Ok(cell.into_any().unbind())
}

fn cells_to_py<'py>(py: Python<'py>, payload: &[u8], encoding: TextEncoding) -> PyResult<Bound<'py, PyList>> {
    let limits = RecordLimits { max_columns: 1024, max_payload_bytes: 16 * 1024 * 1024 };
    let values = decode_record(payload, encoding, limits).map_err(runtime_error)?;
    let list = PyList::empty(py);
    for value in &values {
        list.append(cell_to_py(py, value)?)?;
    }
    Ok(list)
}

fn limit_from(max_rows: Option<usize>) -> TableLimits {
    let defaults = TableLimits::default();
    match max_rows {
        Some(max_rows) => TableLimits { max_rows, ..defaults },
        None => defaults,
    }
}

fn rows_to_py<'py>(py: Python<'py>, rows: Vec<TableRow>, encoding: TextEncoding) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for row in rows {
        let item = PyDict::new(py);
        item.set_item("rowid", row.rowid)?;
        item.set_item("columns", cells_to_py(py, &row.payload, encoding)?)?;
        list.append(item)?;
    }
    Ok(list)
}

fn schema_kind(kind: SchemaObjectKind) -> &'static str {
    match kind {
        SchemaObjectKind::Table => "table",
        SchemaObjectKind::Index => "index",
        SchemaObjectKind::View => "view",
        SchemaObjectKind::Trigger => "trigger",
    }
}

fn schema_to_py<'py>(py: Python<'py>, objects: Vec<sqlite::SchemaObject>) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    for object in objects {
        let item = PyDict::new(py);
        item.set_item("kind", schema_kind(object.kind))?;
        item.set_item("name", object.name)?;
        item.set_item("tableName", object.table_name)?;
        item.set_item("rootPage", object.root_page)?;
        item.set_item("sql", object.sql)?;
        list.append(item)?;
    }
    Ok(list)
}

fn write_value(item: &Bound<'_, PyAny>) -> PyResult<WriteValue> {
    if item.is_none() {
        return Ok(WriteValue::Null);
    }
    if let Ok(boolean) = item.cast::<pyo3::types::PyBool>() {
        return Ok(WriteValue::Integer(i64::from(boolean.is_true())));
    }
    if let Ok(integer) = item.extract::<i64>() {
        return Ok(WriteValue::Integer(integer));
    }
    if let Ok(real) = item.extract::<f64>() {
        return Ok(WriteValue::Real(real));
    }
    if let Ok(text) = item.extract::<String>() {
        return Ok(WriteValue::Text(text));
    }
    if let Ok(bytes) = item.extract::<Vec<u8>>() {
        return Ok(WriteValue::Blob(bytes));
    }
    Err(PyRuntimeError::new_err("sqlite values must be None, bool, int, float, str, or bytes"))
}

fn column_specs(columns: &Bound<'_, PyAny>) -> PyResult<Vec<ColumnSpec>> {
    let mut specs = Vec::new();
    for item in columns.try_iter()? {
        let item = item?;
        let column = item.cast::<PyDict>().map_err(|_| PyRuntimeError::new_err("each column must be a dict"))?;
        let name: String = column.get_item("name")?.ok_or_else(|| PyRuntimeError::new_err("column is missing `name`"))?.extract()?;
        let declared_type: String = match column.get_item("declaredType")? {
            Some(value) if !value.is_none() => value.extract()?,
            _ => "BLOB".to_string(),
        };
        let not_null = match column.get_item("notNull")? {
            Some(value) if !value.is_none() => value.extract()?,
            _ => false,
        };
        let primary_key = match column.get_item("primaryKey")? {
            Some(value) if !value.is_none() => value.extract()?,
            _ => false,
        };
        let unique = match column.get_item("unique")? {
            Some(value) if !value.is_none() => value.extract()?,
            _ => false,
        };
        let autoincrement = match column.get_item("autoincrement")? {
            Some(value) if !value.is_none() => value.extract()?,
            _ => false,
        };
        let default_value = match column.get_item("defaultValue")? {
            Some(value) if !value.is_none() => Some(write_value(&value)?),
            _ => None,
        };
        specs.push(ColumnSpec { name, declared_type, not_null, default_value, primary_key, unique, autoincrement });
    }
    Ok(specs)
}

fn slots_from(values: &Bound<'_, PyAny>) -> PyResult<Vec<Option<WriteValue>>> {
    let mut slots = Vec::new();
    for item in values.try_iter()? {
        let item = item?;
        slots.push(if item.is_none() { None } else { Some(write_value(&item)?) });
    }
    Ok(slots)
}

/// A SQLite main-file snapshot opened from disk or created blank in memory.
#[pyclass]
pub struct SqliteDatabase {
    inner: Database,
}

#[pymethods]
impl SqliteDatabase {
    /// Opens a blank in-memory database.
    #[staticmethod]
    fn open_in_memory() -> PyResult<Self> {
        Database::open_in_memory().map(|inner| Self { inner }).map_err(runtime_error)
    }

    /// Reads an existing main file, replaying a `-wal` or hot `-journal` sidecar in memory.
    #[staticmethod]
    fn open(path: &str) -> PyResult<Self> {
        Database::open(path).map(|inner| Self { inner }).map_err(runtime_error)
    }

    /// Source path, or `None` for an in-memory image.
    fn path(&self) -> Option<String> {
        self.inner.path().map(|path| path.to_string_lossy().into_owned())
    }

    /// Page size in bytes.
    fn page_size(&self) -> usize {
        self.inner.page_size()
    }

    /// Raw page image.
    fn pages<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        PyBytes::new(py, self.inner.pages())
    }

    /// Header validation; returns the page size.
    fn ping(&self) -> PyResult<i32> {
        self.inner.ping().map_err(runtime_error)
    }

    /// Format-3 library version stamped in the header.
    fn sqlite_version(&self) -> PyResult<String> {
        self.inner.sqlite_version().map_err(runtime_error)
    }

    /// Text encoding declared by the header: `utf-8`, `utf-16le`, or `utf-16be`.
    fn encoding(&self) -> PyResult<String> {
        encoding_name(self.inner.pages()).map(|name| name.to_string())
    }

    /// Schema objects (`kind`, `name`, `tableName`, `rootPage`, `sql`).
    #[pyo3(signature = (max_rows=None))]
    fn schema<'py>(&self, py: Python<'py>, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let objects = self.inner.schema(limit_from(max_rows)).map_err(runtime_error)?;
        schema_to_py(py, objects)
    }

    /// Decoded rows of a rowid table or simple view.
    #[pyo3(signature = (name, max_rows=None))]
    fn table<'py>(&self, py: Python<'py>, name: &str, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let encoding = encode_encoding(Some(encoding_name(self.inner.pages())?))?;
        let rows = self.inner.table(name, limit_from(max_rows)).map_err(runtime_error)?;
        rows_to_py(py, rows, encoding)
    }

    /// Raw rows of a rowid table: `{rowid, payload}` with an undecoded record.
    #[pyo3(signature = (name, max_rows=None))]
    fn table_raw<'py>(&self, py: Python<'py>, name: &str, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let rows = sqlite::read_named_table(self.inner.pages(), name, limit_from(max_rows)).map_err(runtime_error)?;
        let list = PyList::empty(py);
        for row in rows {
            let item = PyDict::new(py);
            item.set_item("rowid", row.rowid)?;
            item.set_item("payload", PyBytes::new(py, &row.payload))?;
            list.append(item)?;
        }
        Ok(list)
    }

    /// Decoded rows of a `WITHOUT ROWID` table.
    #[pyo3(signature = (name, max_rows=None))]
    fn table_without_rowid<'py>(&self, py: Python<'py>, name: &str, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let encoding = encode_encoding(Some(encoding_name(self.inner.pages())?))?;
        let payloads = self.inner.table_without_rowid(name, limit_from(max_rows)).map_err(runtime_error)?;
        let list = PyList::empty(py);
        for payload in payloads {
            list.append(cells_to_py(py, &payload, encoding)?)?;
        }
        Ok(list)
    }

    /// Decoded index entries (indexed columns followed by the rowid).
    #[pyo3(signature = (name, max_rows=None))]
    fn index<'py>(&self, py: Python<'py>, name: &str, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let encoding = encode_encoding(Some(encoding_name(self.inner.pages())?))?;
        let payloads = self.inner.index(name, limit_from(max_rows)).map_err(runtime_error)?;
        let list = PyList::empty(py);
        for payload in payloads {
            list.append(cells_to_py(py, &payload, encoding)?)?;
        }
        Ok(list)
    }
}

/// A writable SQLite snapshot builder.
#[pyclass]
pub struct SqliteWriter {
    inner: Writer,
}

#[pymethods]
impl SqliteWriter {
    /// Creates a fresh image; `page_size` defaults to 4096.
    #[staticmethod]
    #[pyo3(signature = (page_size=None))]
    fn create(page_size: Option<usize>) -> PyResult<Self> {
        Writer::create(page_size.unwrap_or(4096)).map(|inner| Self { inner }).map_err(runtime_error)
    }

    /// Loads an existing main file for mutation.
    #[staticmethod]
    fn open(path: &str) -> PyResult<Self> {
        Writer::open(path).map(|inner| Self { inner }).map_err(runtime_error)
    }

    /// Page size in bytes.
    fn page_size(&self) -> usize {
        self.inner.page_size()
    }

    /// Current page image, including the change-counter bump that `save` applies.
    fn pages<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        PyBytes::new(py, self.inner.pages())
    }

    /// Writes the image to `path`.
    fn save(&mut self, path: &str) -> PyResult<()> {
        self.inner.save(path).map_err(runtime_error)
    }

    /// Creates a table from `[{"name", "declaredType", "notNull", "defaultValue", "primaryKey", "unique"}]`.
    fn create_table(&mut self, name: &str, columns: &Bound<'_, PyAny>) -> PyResult<()> {
        let specs = column_specs(columns)?;
        self.inner.create_table(name, &specs).map_err(runtime_error)
    }

    /// Creates an index over one or more columns.
    fn create_index(&mut self, name: &str, table: &str, columns: Vec<String>, unique: Option<bool>) -> PyResult<()> {
        self.inner.create_index(name, table, &columns, unique.unwrap_or(false)).map_err(runtime_error)
    }

    /// Inserts one row; `None` slots apply the column default or NULL.
    fn insert(&mut self, table: &str, values: &Bound<'_, PyAny>) -> PyResult<i64> {
        let slots = slots_from(values)?;
        self.inner.insert(table, &slots).map_err(runtime_error)
    }

    /// Deletes one row by rowid.
    fn delete(&mut self, table: &str, rowid: i64) -> PyResult<bool> {
        self.inner.delete(table, rowid).map_err(runtime_error)
    }

    /// Updates one row by rowid.
    ///
    /// Each slot is `{"keep": True}` or `{"set": <value>}`, matching the
    /// `keep`/`set` object form used by the Node-API `update`.
    fn update(&mut self, table: &str, rowid: i64, slots: &Bound<'_, PyAny>) -> PyResult<bool> {
        let mut values = Vec::new();
        for item in slots.try_iter()? {
            let item = item?;
            let slot = item.cast::<PyDict>().map_err(|_| PyRuntimeError::new_err("each update slot must be a dict"))?;
            let keep = match slot.get_item("keep")? {
                Some(value) if !value.is_none() => value.extract::<bool>()?,
                _ => false,
            };
            if keep {
                values.push(UpdateValue::Keep);
                continue;
            }
            match slot.get_item("set")? {
                Some(inner) => values.push(UpdateValue::Set(write_value(&inner)?)),
                None => return Err(PyRuntimeError::new_err("sqlite update slot needs `keep` or `set`")),
            }
        }
        self.inner.update(table, rowid, &values).map_err(runtime_error)
    }

    /// Starts an in-memory transaction.
    fn begin(&mut self) -> PyResult<()> {
        self.inner.begin().map_err(runtime_error)
    }

    /// Commits the open transaction.
    fn commit(&mut self) -> PyResult<()> {
        self.inner.commit().map_err(runtime_error)
    }

    /// Rolls the image back to the state before `begin`.
    fn rollback(&mut self) -> PyResult<()> {
        self.inner.rollback().map_err(runtime_error)
    }

    /// Schema objects read back through the crate's own reader.
    #[pyo3(signature = (max_rows=None))]
    fn schema<'py>(&self, py: Python<'py>, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let objects = self.inner.schema_objects(limit_from(max_rows)).map_err(runtime_error)?;
        schema_to_py(py, objects)
    }

    /// Decoded rows currently held by the writer.
    #[pyo3(signature = (table, max_rows=None))]
    fn table_decoded<'py>(&self, py: Python<'py>, table: &str, max_rows: Option<usize>) -> PyResult<Bound<'py, PyList>> {
        let encoding = encode_encoding(Some(encoding_name(self.inner.pages())?))?;
        let rows = self.inner.table_rows(table, limit_from(max_rows)).map_err(runtime_error)?;
        rows_to_py(py, rows, encoding)
    }
}

fn engine_error(error: sqlite::SqlError) -> PyErr {
    PyRuntimeError::new_err(error.message)
}

fn json_to_py<'py>(py: Python<'py>, text: &str) -> PyResult<Bound<'py, PyAny>> {
    py.import("json")?.call_method1("loads", (text,))
}

/// In-memory SQLite format-3 database with a fail-closed SQL subset.
///
/// Results use the same JSON envelope as the Node-API and WebAssembly hosts:
/// `{"statement","affected","columns","rows"}` with integers, reals and strings
/// as native values and blobs as `{"$blob":"<hex>"}`. Rejected statements raise
/// `RuntimeError`; `try_execute` returns `{"ok": False, "error": {...}}` instead.
#[pyclass]
pub struct SqliteEngine {
    inner: sqlite::Engine,
}

#[pymethods]
impl SqliteEngine {
    /// Creates a blank in-memory database image; `page_size` defaults to 4096.
    #[staticmethod]
    #[pyo3(signature = (page_size=None))]
    fn create(page_size: Option<u32>) -> PyResult<Self> {
        sqlite::Engine::new(page_size).map(|inner| Self { inner }).map_err(engine_error)
    }

    /// Executes a semicolon-separated script and returns every result in order.
    #[pyo3(signature = (sql))]
    fn exec<'py>(&mut self, py: Python<'py>, sql: &str) -> PyResult<Bound<'py, PyAny>> {
        let results = self.inner.execute(sql).map_err(engine_error)?;
        json_to_py(py, &sqlite::results_json(&results))
    }

    /// Executes exactly one statement and returns `{statement, affected, columns, rows}`.
    #[pyo3(signature = (statement))]
    fn execute<'py>(&mut self, py: Python<'py>, statement: &str) -> PyResult<Bound<'py, PyAny>> {
        let result = self.inner.execute_one(statement).map_err(engine_error)?;
        json_to_py(py, &result.to_json())
    }

    /// Executes a list of statements in order and returns every result.
    #[pyo3(signature = (statements))]
    fn execute_batch<'py>(&mut self, py: Python<'py>, statements: Vec<String>) -> PyResult<Bound<'py, PyAny>> {
        let results = self.inner.execute_batch(&statements).map_err(engine_error)?;
        json_to_py(py, &sqlite::results_json(&results))
    }

    /// Executes one statement without raising, returning `{ok, result}` or `{ok, error}`.
    #[pyo3(signature = (statement))]
    fn try_execute<'py>(&mut self, py: Python<'py>, statement: &str) -> PyResult<Bound<'py, PyAny>> {
        let text = match self.inner.execute_one(statement) {
            Ok(result) => format!("{{\"ok\":true,\"result\":{}}}", result.to_json()),
            Err(error) => format!("{{\"ok\":false,\"error\":{}}}", error.to_json()),
        };
        json_to_py(py, &text)
    }

    /// Raw main-file image, ready to be written as a `.sqlite3` file.
    fn snapshot<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        PyBytes::new(py, self.inner.snapshot())
    }

    /// Configured page size.
    fn page_size(&self) -> u32 {
        self.inner.page_size()
    }

    /// Format-3 library version stamped in the image header.
    fn sqlite_version(&self) -> PyResult<String> {
        self.inner.sqlite_version().map_err(engine_error)
    }

    /// Health probe that re-validates the current image header.
    fn ping(&self) -> PyResult<i32> {
        validate_database(self.inner.snapshot()).map_err(runtime_error)?;
        Ok(1)
    }
}

/// Decodes one record payload with an explicit or default UTF-8 encoding.
#[pyfunction]
#[pyo3(signature = (payload, encoding=None))]
fn decode_record_cells<'py>(py: Python<'py>, payload: Vec<u8>, encoding: Option<&str>) -> PyResult<Bound<'py, PyList>> {
    cells_to_py(py, &payload, encode_encoding(encoding)?)
}

/// Reads the format-3 library version from a main-file image.
#[pyfunction]
fn library_version(payload: Vec<u8>) -> PyResult<String> {
    decode_library_version(&payload).map_err(runtime_error)
}

/// Validates a main-file image; returns its page size.
#[pyfunction]
fn validate(payload: Vec<u8>) -> PyResult<usize> {
    validate_database(&payload).map_err(runtime_error)
}

#[pymodule]
fn sqlite_format3(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<SqliteDatabase>()?;
    module.add_class::<SqliteWriter>()?;
    module.add_class::<SqliteEngine>()?;
    module.add_function(wrap_pyfunction!(decode_record_cells, module)?)?;
    module.add_function(wrap_pyfunction!(library_version, module)?)?;
    module.add_function(wrap_pyfunction!(validate, module)?)?;
    Ok(())
}
