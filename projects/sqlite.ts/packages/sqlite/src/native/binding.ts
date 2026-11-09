// 加载结果与实际 N-API 构建的声明接合。
//
// 这里的接口逐字对应 `sqlite-napi` 导出的类与函数，不做任何 `as unknown as`
// 的能力假定：声明的方法在 addon 里真实存在，缺失的能力（如预编译期表头）
// 以 `null` 如实呈现。

import { loadNative } from "./load.ts";

/** 打开连接的原生选项，字段已由 TS 层校验过形状。 */
export interface NativeConnectionOptions {
  filename?: string;
  data?: Uint8Array;
  readOnly?: boolean;
  create?: boolean;
  pageSize?: number;
  synchronous?: boolean;
}

/** 权威参数槽位：零基索引与书写原文。 */
export interface NativeSlot {
  index: number;
  text: string;
}

/** 结果单元格：INTEGER `bigint`、REAL `number`、TEXT `string`、BLOB `Buffer`、NULL `null`。 */
export type NativeCell = null | bigint | number | string | Buffer;

export interface NativeRunResult {
  statement: string;
  affected: bigint;
  lastInsertRowid: bigint;
  columns: string[];
  rows: NativeCell[][];
}

export interface NativeStatement {
  run(parameters?: unknown[]): NativeRunResult;
  sql(): string;
  statementName(): string;
  slots(): NativeSlot[];
  parameterCount(): number;
  isWrite(): boolean;
  /** 引擎在执行时才计算结果头，预编译期返回 `null`。 */
  columns(): string[] | null;
  finalize(): void;
}

export interface NativeConnection {
  prepare(sql: string): NativeStatement;
  exec(script: string, parameters?: unknown[]): NativeRunResult[];
  /** 脚本内每条语句的种类名，来自 Rust 解析器。 */
  statementKinds(sql: string): string[];
  snapshot(): Buffer;
  backup(path: string): void;
  close(): void;
  inTransaction(): boolean;
  lastInsertRowid(): bigint;
  pageSize(): number;
  sqliteVersion(): string;
  readOnly(): boolean;
  filename(): string | null;
  setSynchronous(on: boolean): void;
}

// ---- 过渡 JSON 引擎原语（供 ORM 适配与尚未迁移的消费者使用，主包待迁移后移除） ----

/** One executed cell in the JSON envelope: native scalars, blobs tagged as `{ $blob }`. */
export type ExecValue = null | number | string | { $blob: string };

/** Result of one SQL statement in the JSON engine envelope. */
export interface ExecResult {
  statement: string;
  affected: number;
  columns: string[];
  rows: ExecValue[][];
}

/** Structured rejection raised by the fail-closed JSON engine. */
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

// ---- 检视与格式-3 工具面（经 `inspect` 子路径消费，主包不公开） ----

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

export interface NativeSnapshot {
  schema(limits?: ReadLimits): SchemaObject[];
  table(name: string, limits?: ReadLimits): RawRow[];
  tableDecoded(name: string, limits?: ReadLimits): DecodedRow[];
  sqliteVersion(): string;
  encoding(): string;
  ping(): number;
  pages(): Buffer;
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
  schema(limits?: ReadLimits): SchemaObject[];
  tableDecoded(name: string, limits?: ReadLimits): DecodedRow[];
}

/** addon 的真实导出面。 */
export interface NativeAddon {
  SqliteConnection: { open(options?: NativeConnectionOptions): NativeConnection };
  SqliteDatabase: { open(path: string): NativeDatabase; openInMemory(): NativeDatabase };
  SqliteSnapshot: new (bytes: Buffer, maxSnapshotBytes?: number) => NativeSnapshot;
  SqliteWriter: { create(pageSize?: number): NativeWriter; open(path: string): NativeWriter };
  SqliteEngine: NativeEngineConstructor;
  decodeRecord(payload: Buffer, encoding?: string): DecodedValue[];
}

/** 进程内唯一的加载结果。 */
export const addon: NativeAddon = loadNative();
