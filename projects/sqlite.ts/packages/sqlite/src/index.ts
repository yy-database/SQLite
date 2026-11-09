import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

export interface ReadLimits {
  maxPages?: number;
  maxRows?: number;
  maxPayloadBytes?: number;
  maxTotalPayloadBytes?: number;
}

export interface SchemaObject {
  kind: "table" | "index" | "view" | "trigger";
  name: string;
  tableName: string;
  rootPage?: number;
  sql?: string;
}

/**
 * 一个解码后的 SQLite 值，存储类别由 JS 类型本身表达：
 * 整数为 `bigint`、实数为 `number`、文本为 `string`、blob 为 `Buffer`、NULL 为 `null`。
 */
export type DecodedValue = null | bigint | number | string | Buffer;

export interface DecodedRow {
  rowid: bigint;
  columns: DecodedValue[];
}

export interface RawRow {
  rowid: bigint;
  payload: Buffer;
}

export interface ColumnSpec {
  name: string;
  declaredType: string;
  notNull?: boolean;
  defaultValue?: string | null;
  primaryKey?: boolean;
  unique?: boolean;
  /** `PRIMARY KEY AUTOINCREMENT` on an INTEGER rowid alias. */
  autoincrement?: boolean;
  /** 列级排序规则，缺省为 `BINARY`。 */
  collate?: "BINARY" | "NOCASE" | "RTRIM";
}

/** One executed cell: native JSON scalars, with blobs tagged as `{ $blob }`. */
export type ExecValue = null | number | string | { $blob: string };

/** Result of one SQL statement. */
export interface ExecResult {
  statement:
    | "create-table"
    | "create-index"
    | "drop-table"
    | "drop-index"
    | "alter-table"
    | "insert"
    | "update"
    | "delete"
    | "select"
    | "pragma"
    | "begin"
    | "commit"
    | "rollback"
    | "savepoint"
    | "release"
    | "rollback-to"
    | "explain";
  affected: number;
  columns: string[];
  rows: ExecValue[][];
}

/** Structured rejection raised by the fail-closed SQL engine. */
export interface ExecError {
  code: string;
  message: string;
  statement?: string | null;
  clause?: string | null;
  position?: number | null;
}

/** Non-throwing outcome of `tryExecute`. */
export interface ExecOutcome {
  ok: boolean;
  result?: ExecResult;
  error?: ExecError;
}

export interface NativeEngine {
  exec(sql: string): ExecResult[];
  execute(statement: string): ExecResult;
  /** Runs a script with positional `?` parameters bound in order. */
  executeWithParameters(statement: string, parameters: unknown[]): ExecResult[];
  executeBatch(statements: string[]): ExecResult[];
  tryExecute(statement: string): ExecOutcome;
  /** `sqlite3_last_insert_rowid()` for this connection. */
  lastInsertRowid(): number;
  snapshot(): Buffer;
  pageSize(): number;
  sqliteVersion(): string;
  ping(): number;
}

export interface NativeEngineConstructor {
  create(pageSize?: number): NativeEngine;
  /** Reopens a main-file image and rebuilds its schema catalog. */
  fromSnapshot(bytes: Buffer): NativeEngine;
}

export interface NativeWriter {
  createTable(name: string, columnsJson: string): void;
  createIndex(name: string, table: string, columns: string[], unique?: boolean): void;
  insert(table: string, valuesJson: string): number;
  delete(table: string, rowid: number): boolean;
  update(table: string, rowid: number, slotsJson: string): boolean;
  begin(): void;
  commit(): void;
  rollback(): void;
  save(path: string): void;
  /** When `on`, `save` syncs the file to disk (upstream `synchronous=FULL`); default `off`. */
  setSynchronous(on: boolean): void;
  pages(): Buffer;
  pageSize(): number;
  tableDecoded(name: string, limits?: ReadLimits): DecodedRow[];
}

export interface NativeDatabase {
  path(): string | null;
  ping(): number;
  sqliteVersion(): string;
  encoding(): string;
  schema(limits?: ReadLimits): SchemaObject[];
  table(name: string, limits?: ReadLimits): DecodedRow[];
  /** Reads one decoded row by rowid; `null` when the rowid is absent. The array holds at most one row. */
  rowByRowid(name: string, rowid: number, limits?: ReadLimits): DecodedRow[] | null;
  /** Reads decoded rows whose rowid lies in the inclusive range `[lower, upper]`, in rowid order. */
  range(name: string, lower: number, upper: number, limits?: ReadLimits): DecodedRow[];
  tableRaw(name: string, limits?: ReadLimits): RawRow[];
  tableWithoutRowid(name: string, limits?: ReadLimits): DecodedValue[][];
  index(name: string, limits?: ReadLimits): DecodedRow[];
  pages(): Buffer;
}

export interface NativeWriterConstructor {
  create(pageSize?: number): NativeWriter;
  open(path: string): NativeWriter;
}

export interface NativeDatabaseConstructor {
  open(path: string): NativeDatabase;
  openInMemory(): NativeDatabase;
}

export interface NativeSnapshot {
  schema(limits?: ReadLimits): SchemaObject[];
  table(name: string, limits?: ReadLimits): RawRow[];
  tableDecoded(name: string, limits?: ReadLimits): DecodedRow[];
  sqliteVersion(): string;
  encoding(): string;
  ping(): number;
  pages(): Buffer;
}

export interface NativeSnapshotConstructor {
  new (bytes: Buffer, maxSnapshotBytes?: number): NativeSnapshot;
}

export interface NativeBindings {
  SqliteWriter: NativeWriterConstructor;
  SqliteDatabase: NativeDatabaseConstructor;
  SqliteSnapshot: NativeSnapshotConstructor;
  SqliteEngine: NativeEngineConstructor;
  decodeRecord(payload: Buffer, encoding?: string): DecodedValue[];
}

export type PlatformKey = "win32-x64" | "linux-x64" | "darwin-x64" | "darwin-arm64";

/** Map Node platform and arch to the optionalDependency package suffix. */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

function loadModule(specifier: string): NativeBindings {
  const loaded = require(specifier) as NativeBindings & { default?: NativeBindings };
  return (loaded.default ?? loaded) as NativeBindings;
}

/** Absolute path of the platform package `main` (the `.node` binary). */
export function nativeBindingPath(): string {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    const bindingPath = resolve(fromEnv);
    if (!existsSync(bindingPath)) {
      throw new Error(`SQLITE_NATIVE points to missing binding: ${fromEnv}`);
    }
    return bindingPath;
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  // `package.json#main` owns the `.node` filename — callers never concatenate it.
  return require.resolve(`@yydb/sqlite-${key}`);
}

/** Load the platform binding through the package entry installed for this host. */
export function loadNative(): NativeBindings {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    return loadModule(nativeBindingPath());
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  const pkg = `@yydb/sqlite-${key}`;
  try {
    return loadModule(pkg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite native binding not found. Run pnpm build:napi from the repo root, reinstall @yydb/sqlite with optional dependencies, set SQLITE_NATIVE, or stage ${pkg}. ${message}`,
    );
  }
}

export const bindings: NativeBindings = loadNative();

export function writeValue(value: unknown): unknown {
  if (value === undefined) {
    return { $omit: true };
  }
  if (value instanceof Uint8Array) {
    return { $blob: Buffer.from(value).toString("hex") };
  }
  return value;
}

export function writeSlots(values: unknown[]): string {
  return JSON.stringify(values.map(writeValue));
}

export function createWriter(pageSize?: number): NativeWriter {
  return bindings.SqliteWriter.create(pageSize);
}

export function openWriter(path: string): NativeWriter {
  return bindings.SqliteWriter.open(path);
}

export function openDatabase(path: string): NativeDatabase {
  return bindings.SqliteDatabase.open(path);
}

export function openSnapshot(bytes: Buffer, maxSnapshotBytes?: number): NativeSnapshot {
  return new bindings.SqliteSnapshot(bytes, maxSnapshotBytes);
}

/** Creates an in-memory SQL engine over the pure-Rust format-3 writer. */
export function createEngine(pageSize?: number): NativeEngine {
  return bindings.SqliteEngine.create(pageSize);
}

/** Reopens a main-file image and rebuilds its schema catalog. */
export function createEngineFromSnapshot(bytes: Buffer): NativeEngine {
  return bindings.SqliteEngine.fromSnapshot(bytes);
}

/**
 * Executes one statement and returns `{ statement, affected, columns, rows }`.
 *
 * Rejections throw an `Error` carrying the engine message. Use
 * `NativeEngine.tryExecute` when the caller needs the structured error
 * (`code`, `statement`, `clause`, `position`) instead of an exception.
 */
export function executeSql(engine: NativeEngine, statement: string): ExecResult {
  return engine.execute(statement);
}

// 正式产品入口：`new SQLite(options?)` 是完整闭合的连接对象（查询、预编译
// 语句、事务），类型映射忠实（INTEGER→bigint、BLOB→Uint8Array）。
// 上方的 `bindings`/`Native*` 原语面是内部实现细节，仅为既有消费者暂留，
// 待 TypeORM/Drizzle 迁移到新入口后移除。
export { SQLite, Statement, TransactionScope, SQLiteError } from "./sqlite.ts";
export type {
  SQLiteOptions,
  SQLiteRow,
  SQLiteParams,
  SQLiteBindValue,
  SQLiteValue,
  SQLiteRunResult,
} from "./sqlite.ts";
