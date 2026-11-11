// better-sqlite3 兼容的 Database/Statement 模拟，构建在 `@yydb/sqlite` 正式入口
// `new SQLite()` 之上。忠实类型映射（INTEGER→bigint）在这里按 better-sqlite3 的
// 默认模式转回 number；`defaultSafeIntegers(true)` 时保持 bigint。收窄是模拟层
// 职责（better-sqlite3 自身就是这么做的），不是引擎改判。
//
// `timeout`（busy handler）与 `verbose` 不在本引擎能力内，保持忽略；
// `fileMustExist` 映射到 `create: false`，`readonly` 映射到 `readOnly: true`。

import {
  SQLite,
  type SQLiteParams,
  type SQLiteRow,
  type SQLiteValue,
  type Statement as CoreStatement,
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

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;

/** Minimal better-sqlite3-compatible Database over the `@yydb/sqlite` `SQLite` entry. */
export class Database {
  readonly name: string;
  #db: SQLite;
  #safeIntegers = false;

  constructor(filename = ":memory:", options: SqliteBetterSqlite3Options = {}) {
    this.name = filename;
    const memory = filename === ":memory:" || filename === "";
    if (memory) {
      this.#db = new SQLite({ readOnly: options.readonly ?? false });
      return;
    }
    this.#db = new SQLite({
      filename,
      readOnly: options.readonly ?? false,
      create: !options.fileMustExist,
    });
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const sql = source.trim().toLowerCase().startsWith("pragma")
      ? source
      : `pragma ${source}`;
    const statement = this.#db.prepare(sql);
    const rows = statement.all();
    if (options?.simple) {
      const first = rows[0];
      if (!first) return null;
      return first[statement.columns()[0]!] ?? null;
    }
    return rows.map((row) => this._projectRow(row));
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
    this.#db.close();
  }

  /** @internal 惰性预编译：错误在执行点抛出，与 better-sqlite3 的 query 包装一致。 */
  _prepareCore(sql: string): CoreStatement {
    return this.#db.prepare(sql);
  }

  /** @internal INTEGER→number 收窄；超出安全范围时如实抛错，与 better-sqlite3 同形。 */
  _project(value: SQLiteValue): unknown {
    if (typeof value !== "bigint") return value;
    if (this.#safeIntegers) return value;
    if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
      throw new Error(
        `SQLite integer ${value} didn't fit in a safe JavaScript number; call defaultSafeIntegers() to read BigInt instead`,
      );
    }
    return Number(value);
  }

  /** @internal */
  _projectRow(row: SQLiteRow): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = this._project(value);
    }
    return out;
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
  #statement: CoreStatement | null = null;
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
    const statement = this.#core();
    statement.all(toParams(this.#bound));
    this.#columns = statement.columns().map((name) => ({ name, type: null }));
    return this.#columns;
  }

  run(...params: BoundParams): RunResult {
    const result = this.#core().run(toParams(pickParams(this.#bound, params)));
    return {
      changes: Number(result.changes),
      // 输入恒为 INTEGER rowid，投影结果必为 number|bigint。
      lastInsertRowid: this.#db._project(result.lastInsertRowid) as number | bigint,
    };
  }

  get(...params: BoundParams): unknown {
    const statement = this.#core();
    const view = this.#raw ? statement.raw() : statement;
    const row = view.get(toParams(pickParams(this.#bound, params)));
    this.#columns = statement.columns().map((name) => ({ name, type: null }));
    if (row === undefined) return undefined;
    if (this.#raw) return (row as unknown as SQLiteValue[]).map((value) => this.#db._project(value));
    return this.#db._projectRow(row as SQLiteRow);
  }

  all(...params: BoundParams): unknown[] {
    const statement = this.#core();
    const view = this.#raw ? statement.raw() : statement;
    const rows = view.all(toParams(pickParams(this.#bound, params)));
    this.#columns = statement.columns().map((name) => ({ name, type: null }));
    if (this.#raw) {
      return (rows as unknown as SQLiteValue[][]).map((row) => row.map((value) => this.#db._project(value)));
    }
    return (rows as SQLiteRow[]).map((row) => this.#db._projectRow(row));
  }

  #core(): CoreStatement {
    if (this.#statement === null) this.#statement = this.#db._prepareCore(this.#sql);
    return this.#statement;
  }
}

export default Database;

// 参数容器透传：可绑定性由正式入口按 SQLite 存储类别诚实判定，
// 不可绑定的值（undefined/boolean/Date）在这里抛错，与 better-sqlite3 同形。
function toParams(params: BoundParams): SQLiteParams {
  return params as unknown as SQLiteParams;
}

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
