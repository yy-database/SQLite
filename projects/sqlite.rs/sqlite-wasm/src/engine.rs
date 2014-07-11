//! In-memory execution layer: SQL subset over the pure-Rust format-3 writer.
//!
//! The engine keeps the whole database image in `SqliteWriter::pages()`; it
//! never opens a file and never imports an upstream SQLite engine.

use std::collections::BTreeMap;

use sqlite::{ColumnSpec, RecordLimits, SqliteWriter, TableLimits, TextEncoding, decode_library_version, decode_record};

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
    pub fn new(page_size: Option<u32>) -> Result<Self, String> {
        let page_size = page_size.unwrap_or(4096) as usize;
        let writer = SqliteWriter::create(page_size).map_err(|error| error.to_string())?;
        Ok(Self { writer, tables: BTreeMap::new() })
    }

    /// Executes one or more statements and returns their results in order.
    pub fn execute(&mut self, sql: &str) -> Result<Vec<ExecResult>, String> {
        let statements = parse(sql)?;
        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            results.push(self.execute_statement(statement)?);
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
    pub fn sqlite_version(&self) -> Result<String, String> {
        decode_library_version(self.writer.pages()).map_err(|error| error.to_string())
    }

    fn execute_statement(&mut self, statement: Statement) -> Result<ExecResult, String> {
        match statement {
            Statement::CreateTable { name, if_not_exists, columns } => {
                let key = name.to_ascii_lowercase();
                if self.tables.contains_key(&key) {
                    if if_not_exists {
                        return Ok(ExecResult { statement: "create-table", columns: Vec::new(), rows: Vec::new(), affected: 0 });
                    }
                    return Err(format!("table `{name}` already exists"));
                }
                self.writer.create_table(&name, &columns).map_err(|error| error.to_string())?;
                let rowid_alias = columns.iter().position(|column| column.primary_key && column.declared_type.eq_ignore_ascii_case("INTEGER"));
                self.tables.insert(key, TableDef { columns, rowid_alias });
                Ok(ExecResult { statement: "create-table", columns: Vec::new(), rows: Vec::new(), affected: 1 })
            }
            Statement::Insert { table, columns, rows } => {
                let key = table.to_ascii_lowercase();
                let def = self.tables.get(&key).ok_or_else(|| format!("unknown table `{table}`"))?;
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

    fn insert_rows(writer: &mut SqliteWriter, table: &str, rows: &[Vec<Option<sqlite::WriteValue>>]) -> Result<Vec<i64>, String> {
        let mut rowids = Vec::with_capacity(rows.len());
        for slots in rows {
            rowids.push(writer.insert(table, slots).map_err(|error| error.to_string())?);
        }
        Ok(rowids)
    }

    fn select(&self, table: &str, items: SelectItems, limit: Option<usize>) -> Result<ExecResult, String> {
        let key = table.to_ascii_lowercase();
        let def = self.tables.get(&key).ok_or_else(|| format!("unknown table `{table}`"))?;
        let records = self.writer.table_rows(table, TableLimits::default()).map_err(|error| error.to_string())?;
        match items {
            SelectItems::CountAll => {
                Ok(ExecResult { statement: "select", columns: vec!["count(*)".to_string()], rows: vec![vec![Cell::Integer(records.len() as i64)]], affected: 0 })
            }
            SelectItems::Star => {
                let columns = def.columns.iter().map(|column| column.name.clone()).collect();
                let rows = records.iter().take(limit.unwrap_or(usize::MAX)).map(|row| decode_row(&row.payload, def, row.rowid)).collect::<Result<_, _>>()?;
                Ok(ExecResult { statement: "select", columns, rows, affected: 0 })
            }
            SelectItems::Named(names) => {
                let indices = names
                    .iter()
                    .map(|name| {
                        def.columns.iter().position(|column| column.name.eq_ignore_ascii_case(name)).ok_or_else(|| format!("unknown column `{name}` in table `{table}`"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let rows = records
                    .iter()
                    .take(limit.unwrap_or(usize::MAX))
                    .map(|row| {
                        let values = decode_row(&row.payload, def, row.rowid)?;
                        Ok(indices.iter().map(|index| values[*index].clone()).collect())
                    })
                    .collect::<Result<Vec<Vec<Cell>>, String>>()?;
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
) -> Result<Vec<Option<sqlite::WriteValue>>, String> {
    let mut slots = vec![None; def.columns.len()];
    match columns {
        Some(names) => {
            if names.len() != values.len() {
                return Err(format!("insert into `{table}` has {} columns but {} values", names.len(), values.len()));
            }
            let mut seen = Vec::new();
            for (name, value) in names.iter().zip(values) {
                let index = def
                    .columns
                    .iter()
                    .position(|column| column.name.eq_ignore_ascii_case(name))
                    .ok_or_else(|| format!("unknown column `{name}` in table `{table}`"))?;
                if seen.contains(&index) {
                    return Err(format!("column `{name}` is listed twice in the insert"));
                }
                seen.push(index);
                slots[index] = Some(value.to_write_value());
            }
        }
        None => {
            if values.len() != def.columns.len() {
                return Err(format!("insert into `{table}` expects {} values but received {}", def.columns.len(), values.len()));
            }
            for (index, value) in values.iter().enumerate() {
                slots[index] = Some(value.to_write_value());
            }
        }
    }
    Ok(slots)
}

fn decode_row(payload: &[u8], def: &TableDef, rowid: i64) -> Result<Vec<Cell>, String> {
    let limits = RecordLimits { max_columns: 1024, max_payload_bytes: 16 * 1024 * 1024 };
    let values = decode_record(payload, TextEncoding::Utf8, limits).map_err(|error| error.to_string())?;
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

/// Serializes results as JSON for the wasm host.
pub fn results_json(results: &[ExecResult]) -> String {
    let mut out = String::from("[");
    for (index, result) in results.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&format!("{{\"statement\":\"{}\",\"affected\":{},\"columns\":[", result.statement, result.affected));
        for (column_index, column) in result.columns.iter().enumerate() {
            if column_index > 0 {
                out.push(',');
            }
            out.push_str(&json_string(column));
        }
        out.push_str("],\"rows\":[");
        for (row_index, row) in result.rows.iter().enumerate() {
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

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            character if (character as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", character as u32)),
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserts_and_reads_back_through_sql() {
        let mut engine = Engine::new(Some(4096)).expect("open");
        let results = engine
            .execute(
                "create table t (id integer primary key, label text not null); \
                 insert into t (label) values ('alpha'); \
                 select count(*) from t; \
                 select * from t;",
            )
            .expect("execute");
        assert_eq!(results.len(), 4);
        assert_eq!(results[2].rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(results[3].rows, vec![vec![Cell::Integer(1), Cell::Text("alpha".to_string())]]);
    }

    #[test]
    fn rejects_unknown_tables_and_arity_mismatch() {
        let mut engine = Engine::new(None).expect("open");
        let error = engine.execute("insert into missing values (1)").expect_err("reject");
        assert!(error.contains("unknown table"), "{error}");
        engine.execute("create table t (id integer primary key, label text)").expect("create");
        let error = engine.execute("insert into t values (1)").expect_err("reject");
        assert!(error.contains("expects 2 values"), "{error}");
    }

    #[test]
    fn serializes_rows_as_json() {
        let mut engine = Engine::new(None).expect("open");
        engine
            .execute("create table t (id integer primary key, label text); insert into t (label) values ('a')")
            .expect("execute");
        let results = engine.execute("select * from t").expect("select");
        let json = results_json(&results);
        assert_eq!(
            json,
            r#"[{"statement":"select","affected":0,"columns":["id","label"],"rows":[[1,"a"]]}]"#
        );
    }
}
