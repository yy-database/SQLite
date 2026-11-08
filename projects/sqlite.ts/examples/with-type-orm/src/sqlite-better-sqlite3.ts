import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  createEngine,
  createEngineFromSnapshot,
  type ExecResult,
  type ExecValue,
  type NativeEngine,
} from "../../../packages/sqlite/src/index.ts";

export type SqliteBetterSqlite3Options = {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: ((message?: unknown, ...args: unknown[]) => void) | null;
  nativeBinding?: string | null;
};

export type RunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type BoundParams = unknown[];

/** Minimal better-sqlite3-compatible Database over `@yydb/sqlite` `createEngine`. */
export class Database {
  readonly name: string;
  #engine: NativeEngine;
  #closed = false;
  #safeIntegers = false;
  #memory: boolean;

  constructor(filename = ":memory:", _options: SqliteBetterSqlite3Options = {}) {
    this.name = filename;
    this.#memory = filename === ":memory:" || filename === "";
    if (this.#memory) {
      this.#engine = createEngine(4096);
      return;
    }
    if (existsSync(filename)) {
      this.#engine = createEngineFromSnapshot(readFileSync(filename));
      return;
    }
    if (_options.fileMustExist) {
      throw new Error(`sqlite database file does not exist: ${filename}`);
    }
    this.#engine = createEngine(4096);
  }

  get engine(): NativeEngine {
    return this.#engine;
  }

  prepare(sql: string): Statement {
    this.#assertOpen();
    return new Statement(this, sql);
  }

  exec(sql: string): this {
    this.#assertOpen();
    this.#engine.exec(sql);
    this.#persist();
    return this;
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    this.#assertOpen();
    const sql = source.trim().toLowerCase().startsWith("pragma")
      ? source
      : `pragma ${source}`;
    const results = this.#engine.exec(sql);
    const result = lastResult(results);
    if (options?.simple) {
      return result.rows[0]?.[0] ?? null;
    }
    return result.rows.map((row) => rowToObject(result.columns, row));
  }

  transaction<T>(fn: (arg?: unknown) => T): TransactionFn<T> {
    const run =
      (behavior: "deferred" | "immediate" | "exclusive") =>
      (arg?: unknown): T => {
        this.exec(`begin ${behavior}`);
        try {
          const value = fn(arg);
          this.exec("commit");
          return value;
        } catch (error) {
          try {
            this.exec("rollback");
          } catch {
            // keep original error
          }
          throw error;
        }
      };
    const deferred = run("deferred");
    (deferred as TransactionFn<T>).deferred = deferred;
    (deferred as TransactionFn<T>).immediate = run("immediate");
    (deferred as TransactionFn<T>).exclusive = run("exclusive");
    return deferred as TransactionFn<T>;
  }

  defaultSafeIntegers(toggle = true): this {
    this.#safeIntegers = toggle;
    return this;
  }

  close(): void {
    if (this.#closed) return;
    this.#persist();
    this.#closed = true;
  }

  /** @internal */
  _execute(sql: string, params: BoundParams): ExecResult {
    this.#assertOpen();
    const batch =
      params.length === 0
        ? this.#engine.exec(sql)
        : this.#engine.executeWithParameters(sql, params);
    const result = lastResult(batch);
    this.#persist();
    return result;
  }

  /** @internal */
  _lastInsertRowid(): number | bigint {
    const value = this.#engine.lastInsertRowid();
    return this.#safeIntegers ? BigInt(value) : value;
  }

  #persist(): void {
    if (this.#memory || this.#closed) return;
    writeFileSync(this.name, this.#engine.snapshot());
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("database connection is closed");
  }
}

export type TransactionFn<T> = ((arg?: unknown) => T) & {
  deferred: (arg?: unknown) => T;
  immediate: (arg?: unknown) => T;
  exclusive: (arg?: unknown) => T;
};

export class Statement {
  readonly reader: boolean;
  #db: Database;
  #sql: string;
  #bound: BoundParams = [];
  #raw = false;
  #columns: Array<{ name: string; type: string | null }> | null = null;

  constructor(db: Database, sql: string) {
    this.#db = db;
    this.#sql = sql;
    this.reader = isReaderSql(sql);
  }

  bind(...params: BoundParams): this {
    this.#bound = flattenParams(params);
    return this;
  }

  raw(toggle = true): this {
    this.#raw = toggle;
    return this;
  }

  columns(): Array<{ name: string; type: string | null }> {
    if (this.#columns) return this.#columns;
    if (!this.reader) {
      this.#columns = [];
      return this.#columns;
    }
    // Probe once with bound params so SELECT/PRAGMA column metadata is available.
    const result = this.#db._execute(this.#sql, this.#bound);
    this.#columns = result.columns.map((name) => ({ name, type: null }));
    return this.#columns;
  }

  run(...params: BoundParams): RunResult {
    const result = this.#db._execute(this.#sql, pickParams(this.#bound, params));
    return {
      changes: result.affected,
      lastInsertRowid: this.#db._lastInsertRowid(),
    };
  }

  get(...params: BoundParams): unknown {
    const result = this.#db._execute(this.#sql, pickParams(this.#bound, params));
    this.#columns = result.columns.map((name) => ({ name, type: null }));
    const row = result.rows[0];
    if (!row) return undefined;
    return this.#raw ? [...row] : rowToObject(result.columns, row);
  }

  all(...params: BoundParams): unknown[] {
    const result = this.#db._execute(this.#sql, pickParams(this.#bound, params));
    this.#columns = result.columns.map((name) => ({ name, type: null }));
    if (this.#raw) return result.rows.map((row) => [...row]);
    return result.rows.map((row) => rowToObject(result.columns, row));
  }
}

export default Database;

function pickParams(bound: BoundParams, params: BoundParams): BoundParams {
  const flat = flattenParams(params);
  return flat.length > 0 ? flat : bound;
}

function flattenParams(params: BoundParams): BoundParams {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0] as BoundParams;
  }
  return params;
}

function lastResult(batch: ExecResult[]): ExecResult {
  if (batch.length === 0) {
    return { statement: "pragma", affected: 0, columns: [], rows: [] };
  }
  return batch[batch.length - 1]!;
}

function rowToObject(columns: string[], row: ExecValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index += 1) {
    out[columns[index]!] = unwrap(row[index]);
  }
  return out;
}

function unwrap(value: ExecValue | undefined): unknown {
  if (value && typeof value === "object" && "$blob" in value) {
    return Buffer.from(value.$blob, "hex");
  }
  return value ?? null;
}

function isReaderSql(sql: string): boolean {
  const trimmed = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, "").replace(/^\s*--[^\n]*\n/g, "").trimStart();
  const head = trimmed.slice(0, 12).toLowerCase();
  if (head.startsWith("select") || head.startsWith("with") || head.startsWith("values") || head.startsWith("pragma")) {
    // Assignment pragmas (`pragma foreign_keys = ON`) are writers.
    if (head.startsWith("pragma") && /pragma\s+\w+\s*=/.test(trimmed.toLowerCase())) {
      return false;
    }
    return true;
  }
  if (head.startsWith("explain")) return true;
  return false;
}
