//! In-memory execution layer: SQL subset over the pure-Rust format-3 writer.
//!
//! The engine keeps the whole database image in `SqliteWriter::pages()`; it
//! never opens a file and never imports an upstream SQLite engine.

use std::collections::BTreeMap;

use sqlite::{ColumnSpec, RecordLimits, SqliteWriter, TableLimits, TextEncoding, decode_library_version, decode_record};

use crate::error::SqlError;
use crate::json_string;
use crate::sql::{Literal, SelectItems, Statement, parse};

/// One cell surfaced to the host.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    /// SQL `NULL`.
    Null,
    /// Signed integer.
    Integer(i64),
    /// Binary64 value.
    Real(f64),
    /// UTF-8 text.
    Text(String),
    /// Blob bytes.
    Blob(Vec<u8>),
}

/// Result of one executed statement.
#[derive(Clone, Debug, PartialEq)]
pub struct ExecResult {
    /// Lowercase statement name (`create-table`, `insert`, `select`).
    pub statement: &'static str,
    /// Column labels in result order.
    pub columns: Vec<String>,
    /// Result rows; empty for DDL and inserts.
    pub rows: Vec<Vec<Cell>>,
    /// Rows created by an insert, or 1 for DDL.
    pub affected: usize,
}

impl ExecResult {
    /// Serializes one result as the documented JSON envelope.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"statement\":");
        out.push_str(&json_string(self.statement));
        out.push_str(",\"affected\":");
        out.push_str(&self.affected.to_string());
        out.push_str(",\"columns\":[");
        for (index, column) in self.columns.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&json_string(column));
        }
        out.push_str("],\"rows\":[");
        for (row_index, row) in self.rows.iter().enumerate() {
            if row_index > 0 {
                out.push(',');
            }
            out.push('[');
            for (cell_index, cell) in row.iter().enumerate() {
                if cell_index > 0 {
                    out.push(',');
                }
                out.push_str(&cell_json(cell));
            }
            out.push(']');
        }
        out.push_str("]}");
        out
    }
}

struct TableDef {
    columns: Vec<ColumnSpec>,
    rowid_alias: Option<usize>,
}

/// In-memory SQLite format-3 database with a minimal SQL surface.
pub struct Engine {
    writer: SqliteWriter,
    tables: BTreeMap<String, TableDef>,
}

impl Engine {
    /// Creates a blank in-memory database image.
    pub fn new(page_size: Option<u32>) -> Result<Self, SqlError> {
        let page_size = page_size.unwrap_or(4096) as usize;
        let writer = SqliteWriter::create(page_size).map_err(|error| SqlError::new("storage", error.to_string()))?;
        Ok(Self { writer, tables: BTreeMap::new() })
    }

    /// Executes exactly one statement.
    pub fn execute_one(&mut self, statement: &str) -> Result<ExecResult, SqlError> {
        let statements = parse(statement)?;
        match statements.len() {
            1 => {
                let only = statements.into_iter().next().expect("length checked");
                self.run_statement(only)
            }
            0 => Err(SqlError::new("empty-statement", "expected exactly one statement but found 0")),
            count => Err(SqlError::new("multiple-statements", format!("expected exactly one statement but found {count}"))),
        }
    }

    /// Executes a list of statements in order and stops at the first rejection.
    pub fn execute_batch(&mut self, statements: &[String]) -> Result<Vec<ExecResult>, SqlError> {
        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            results.push(self.execute_one(statement)?);
        }
        Ok(results)
    }

    /// Executes a semicolon-separated script and returns the results in order.
    pub fn execute(&mut self, sql: &str) -> Result<Vec<ExecResult>, SqlError> {
        let statements = parse(sql)?;
        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            results.push(self.run_statement(statement)?);
        }
        Ok(results)
    }

    /// Current database image, suitable for writing to a `.sqlite3` file.
    ///
    /// Index trees are materialized only by `SqliteWriter::save`, which needs a
    /// filesystem; the wasm build therefore exports table pages only. Creating
    /// an index in this engine is rejected instead of exporting a half-built
    /// image.
    pub fn snapshot(&self) -> &[u8] {
        self.writer.pages()
    }

    /// Configured page size.
    pub fn page_size(&self) -> u32 {
        self.writer.page_size() as u32
    }

    /// Format-3 library version stamped in the image header.
    pub fn sqlite_version(&self) -> Result<String, SqlError> {
        decode_library_version(self.writer.pages()).map_err(|error| SqlError::new("storage", error.to_string()))
    }

    fn run_statement(&mut self, statement: Statement) -> Result<ExecResult, SqlError> {
        match statement {
            Statement::CreateTable { name, if_not_exists, columns } => {
                let key = name.to_ascii_lowercase();
                if self.tables.contains_key(&key) {
                    if if_not_exists {
                        return Ok(ExecResult { statement: "create-table", columns: Vec::new(), rows: Vec::new(), affected: 0 });
                    }
                    return Err(SqlError::new("table-exists", format!("table `{name}` already exists")).in_statement("create-table"));
                }
                self.writer
                    .create_table(&name, &columns)
                    .map_err(|error| SqlError::new("storage", error.to_string()).in_statement("create-table"))?;
                let rowid_alias = columns.iter().position(|column| column.primary_key && column.declared_type.eq_ignore_ascii_case("INTEGER"));
                self.tables.insert(key, TableDef { columns, rowid_alias });
                Ok(ExecResult { statement: "create-table", columns: Vec::new(), rows: Vec::new(), affected: 1 })
            }
            Statement::Insert { table, columns, rows } => {
                let key = table.to_ascii_lowercase();
                let def = self
                    .tables
                    .get(&key)
                    .ok_or_else(|| SqlError::new("unknown-table", format!("unknown table `{table}`")).in_statement("insert"))?;
                let mut slots_by_row = Vec::with_capacity(rows.len());
                for values in &rows {
                    slots_by_row.push(self_contained_arity(def, &table, columns.as_deref(), values)?);
                }
                let rowids = Self::insert_rows(&mut self.writer, &table, &slots_by_row)?;
                let rows = rowids.into_iter().map(|rowid| vec![Cell::Integer(rowid)]).collect();
                Ok(ExecResult { statement: "insert", columns: vec!["rowid".to_string()], rows, affected: slots_by_row.len() })
            }
            Statement::Select { table, items, limit } => self.select(&table, items, limit),
        }
    }

    fn insert_rows(writer: &mut SqliteWriter, table: &str, rows: &[Vec<Option<sqlite::WriteValue>>]) -> Result<Vec<i64>, SqlError> {
        let mut rowids = Vec::with_capacity(rows.len());
        for slots in rows {
            rowids.push(writer.insert(table, slots).map_err(|error| SqlError::new("storage", error.to_string()).in_statement("insert"))?);
        }
        Ok(rowids)
    }

    fn select(&self, table: &str, items: SelectItems, limit: Option<usize>) -> Result<ExecResult, SqlError> {
        let key = table.to_ascii_lowercase();
        let def = self
            .tables
            .get(&key)
            .ok_or_else(|| SqlError::new("unknown-table", format!("unknown table `{table}`")).in_statement("select"))?;
        let records = self
            .writer
            .table_rows(table, TableLimits::default())
            .map_err(|error| SqlError::new("storage", error.to_string()).in_statement("select"))?;
        match items {
            SelectItems::CountAll => Ok(ExecResult {
                statement: "select",
                columns: vec!["count(*)".to_string()],
                rows: vec![vec![Cell::Integer(records.len() as i64)]],
                affected: 0,
            }),
            SelectItems::Star => {
                let columns = def.columns.iter().map(|column| column.name.clone()).collect();
                let rows = records
                    .iter()
                    .take(limit.unwrap_or(usize::MAX))
                    .map(|row| decode_row(&row.payload, def, row.rowid))
                    .collect::<Result<_, _>>()?;
                Ok(ExecResult { statement: "select", columns, rows, affected: 0 })
            }
            SelectItems::Named(names) => {
                let indices = names
                    .iter()
                    .map(|name| {
                        def.columns.iter().position(|column| column.name.eq_ignore_ascii_case(name)).ok_or_else(|| {
                            SqlError::new("unknown-column", format!("unknown column `{name}` in table `{table}`")).in_statement("select")
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let rows = records
                    .iter()
                    .take(limit.unwrap_or(usize::MAX))
                    .map(|row| {
                        let values = decode_row(&row.payload, def, row.rowid)?;
                        Ok(indices.iter().map(|index| values[*index].clone()).collect())
                    })
                    .collect::<Result<Vec<Vec<Cell>>, SqlError>>()?;
                Ok(ExecResult { statement: "select", columns: names, rows, affected: 0 })
            }
        }
    }
}

fn self_contained_arity(
    def: &TableDef,
    table: &str,
    columns: Option<&[String]>,
    values: &[Literal],
) -> Result<Vec<Option<sqlite::WriteValue>>, SqlError> {
    let mut slots = vec![None; def.columns.len()];
    match columns {
        Some(names) => {
            if names.len() != values.len() {
                return Err(SqlError::new(
                    "arity-mismatch",
                    format!("insert into `{table}` has {} columns but {} values", names.len(), values.len()),
                )
                .in_statement("insert"));
            }
            let mut seen = Vec::new();
            for (name, value) in names.iter().zip(values) {
                let index = def.columns.iter().position(|column| column.name.eq_ignore_ascii_case(name)).ok_or_else(|| {
                    SqlError::new("unknown-column", format!("unknown column `{name}` in table `{table}`")).in_statement("insert")
                })?;
                if seen.contains(&index) {
                    return Err(SqlError::new("duplicate-column", format!("column `{name}` is listed twice in the insert")).in_statement("insert"));
                }
                seen.push(index);
                slots[index] = Some(value.to_write_value());
            }
        }
        None => {
            if values.len() != def.columns.len() {
                return Err(SqlError::new(
                    "arity-mismatch",
                    format!("insert into `{table}` expects {} values but received {}", def.columns.len(), values.len()),
                )
                .in_statement("insert"));
            }
            for (index, value) in values.iter().enumerate() {
                slots[index] = Some(value.to_write_value());
            }
        }
    }
    Ok(slots)
}

fn decode_row(payload: &[u8], def: &TableDef, rowid: i64) -> Result<Vec<Cell>, SqlError> {
    let limits = RecordLimits { max_columns: 1024, max_payload_bytes: 16 * 1024 * 1024 };
    let values = decode_record(payload, TextEncoding::Utf8, limits)
        .map_err(|error| SqlError::new("storage", error.to_string()).in_statement("select"))?;
    let mut cells = Vec::with_capacity(def.columns.len());
    for index in 0..def.columns.len() {
        let value = values.get(index);
        cells.push(match value {
            Some(sqlite::RecordValue::Null) if Some(index) == def.rowid_alias => Cell::Integer(rowid),
            Some(sqlite::RecordValue::Null) | None => Cell::Null,
            Some(sqlite::RecordValue::Integer(value)) => Cell::Integer(*value),
            Some(sqlite::RecordValue::Real(value)) => Cell::Real(*value),
            Some(sqlite::RecordValue::Text(value)) => Cell::Text(value.clone()),
            Some(sqlite::RecordValue::Blob(value)) => Cell::Blob(value.to_vec()),
        });
    }
    Ok(cells)
}

/// Serializes results as a JSON array for the wasm host.
pub fn results_json(results: &[ExecResult]) -> String {
    let mut out = String::from("[");
    for (index, result) in results.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&result.to_json());
    }
    out.push(']');
    out
}

fn cell_json(cell: &Cell) -> String {
    match cell {
        Cell::Null => "null".to_string(),
        Cell::Integer(value) => value.to_string(),
        Cell::Real(value) => {
            if value.is_finite() {
                value.to_string()
            }
            else {
                "null".to_string()
            }
        }
        Cell::Text(value) => json_string(value),
        Cell::Blob(bytes) => {
            let mut hex = String::with_capacity(bytes.len() * 2 + 12);
            hex.push_str("{\"$blob\":\"");
            for byte in bytes {
                hex.push_str(&format!("{byte:02x}"));
            }
            hex.push_str("\"}");
            hex
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The Rust-side smoke test proves the crate compiles and one
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
        let error = engine.execute_one("select * from t order by id").expect_err("order by is rejected");
        assert_eq!(error.code, "unsupported-clause");
        assert_eq!(error.statement, Some("select"));
        assert_eq!(error.clause.as_deref(), Some("ORDER"));
        assert_eq!(error.position, Some(16));
        let unknown = engine.execute_one("insert into missing values (1)").expect_err("unknown table");
        assert_eq!(unknown.code, "unknown-table");
        assert_eq!(unknown.statement, Some("insert"));
    }
}
