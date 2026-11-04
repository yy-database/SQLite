//! In-memory SQLite format-3 database for WebAssembly.
//!
//! The crate owns no file I/O: it keeps the whole format-3 image in memory,
//! executes a small fail-closed SQL subset over the pure-Rust writer from the
//! `sqlite` facade, and exports the raw page image for an external engine to
//! verify. See the readme for the build command and host contract.

#![deny(missing_docs)]

mod engine;
mod sql;

pub use engine::{Cell, Engine, ExecResult, results_json};

use wasm_bindgen::prelude::*;

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
        Engine::new(page_size).map(|engine| Self { engine }).map_err(|error| JsError::new(&error))
    }

    /// Executes one or more statements and returns a JSON array of results.
    ///
    /// Each element is `{"statement","affected","columns","rows"}`. Integers
    /// stay JSON numbers, text stays JSON strings and blobs become
    /// `{"$blob":"<hex>"}`.
    pub fn exec(&mut self, sql: &str) -> Result<String, JsError> {
        let results = self.engine.execute(sql).map_err(|error| JsError::new(&error))?;
        Ok(results_json(&results))
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
        self.engine.sqlite_version().map_err(|error| JsError::new(&error))
    }

    /// Re-validates the header of the current image.
    pub fn ping(&self) -> Result<(), JsError> {
        sqlite::validate_database(self.engine.snapshot()).map(|_| ()).map_err(|error| JsError::new(&error.to_string()))
    }
}
