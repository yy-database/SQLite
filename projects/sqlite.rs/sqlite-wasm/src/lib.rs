//! In-memory SQLite format-3 database for WebAssembly.
//!
//! The crate owns no file I/O: it keeps the whole format-3 image in memory and
//! wraps the shared execution core of the `sqlite` facade, which runs a fail-closed
//! SQL subset over the pure-Rust writer. The raw page image is exported for an
//! external engine to verify. See the readme for the build command and host
//! contract.

#![deny(missing_docs)]

pub use sqlite::{Cell, Engine, ExecResult, results_json};

use sqlite::SqlError;
use wasm_bindgen::prelude::*;

fn js_error(error: SqlError) -> JsError {
    JsError::new(&error.message)
}

/// An in-memory format-3 database exposed to JavaScript.
#[wasm_bindgen]
pub struct MemoryDatabase {
    engine: Engine,
}

#[wasm_bindgen]
impl MemoryDatabase {
    /// Opens a blank in-memory database image with the given page size (default 4096).
    #[wasm_bindgen(constructor)]
    pub fn new(page_size: Option<u32>) -> Result<MemoryDatabase, JsError> {
        Engine::new(page_size).map(|engine| Self { engine }).map_err(js_error)
    }

    /// Executes one or more statements and returns a JSON array of results.
    ///
    /// Each element is `{"statement","affected","columns","rows"}`. Integers
    /// stay JSON numbers, text stays JSON strings and blobs become
    /// `{"$blob":"<hex>"}`.
    pub fn exec(&mut self, sql: &str) -> Result<String, JsError> {
        let results = self.engine.execute(sql).map_err(js_error)?;
        Ok(results_json(&results))
    }

    /// Executes exactly one statement and returns one JSON result object.
    pub fn execute(&mut self, statement: &str) -> Result<String, JsError> {
        self.engine.execute_one(statement).map(|result| result.to_json()).map_err(js_error)
    }

    /// Executes a list of statements in order and returns a JSON array.
    #[wasm_bindgen(js_name = executeBatch)]
    pub fn execute_batch(&mut self, statements: Vec<String>) -> Result<String, JsError> {
        let results = self.engine.execute_batch(&statements).map_err(js_error)?;
        Ok(results_json(&results))
    }

    /// Executes one statement without throwing.
    ///
    /// Returns `{"ok":true,"result":{...}}` or `{"ok":false,"error":{...}}`
    /// where the error carries `code`, `message`, `statement`, `clause` and
    /// `position`.
    #[wasm_bindgen(js_name = tryExecute)]
    pub fn try_execute(&mut self, statement: &str) -> String {
        match self.engine.execute_one(statement) {
            Ok(result) => format!("{{\"ok\":true,\"result\":{}}}", result.to_json()),
            Err(error) => format!("{{\"ok\":false,\"error\":{}}}", error.to_json()),
        }
    }

    /// Raw main-file image, ready to be written as a `.sqlite3` file.
    pub fn snapshot(&self) -> Vec<u8> {
        self.engine.snapshot().to_vec()
    }

    /// Configured page size.
    #[wasm_bindgen(js_name = pageSize)]
    pub fn page_size(&self) -> u32 {
        self.engine.page_size()
    }

    /// Format-3 library version stamped in the image header.
    #[wasm_bindgen(js_name = sqliteVersion)]
    pub fn sqlite_version(&self) -> Result<String, JsError> {
        self.engine.sqlite_version().map_err(js_error)
    }

    /// Re-validates the header of the current image.
    pub fn ping(&self) -> Result<(), JsError> {
        sqlite::validate_database(self.engine.snapshot()).map(|_| ()).map_err(|error| JsError::new(&error.to_string()))
    }
}
