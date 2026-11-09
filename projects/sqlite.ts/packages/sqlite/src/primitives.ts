// 过渡原语面：JSON 引擎 + format-3 writer/reader/snapshot + 原生加载器。
//
// 正式产品入口是 `index.ts` 的 `new SQLite()`（忠实类型）。本面以旧的 JSON 信封
// 形态保留 `createEngine` / `executeSql` / `bindings` / `Native*` 等原语，仅为尚未
// 迁移的 ORM 适配（TypeORM / Drizzle / Prisma）、harness 与 examples 暂留；待这些
// 消费者迁到新入口后，本面连同根包导出一并移除。新代码请用 `SQLite` 与
// `@yydb/sqlite/inspect`，不要依赖这里。

import { addon } from "./native/binding.ts";
import { loadNative, nativeBindingPath, platformKey, type PlatformKey } from "./native/load.ts";

import type {
  DecodedRow,
  DecodedValue,
  ExecOutcome,
  ExecResult,
  ExecValue,
  NativeDatabase,
  NativeEngine,
  NativeEngineConstructor,
  NativeSnapshot,
  NativeWriter,
  RawRow,
  ReadLimits,
  SchemaObject,
} from "./native/binding.ts";

export { loadNative, nativeBindingPath, platformKey };
export type { PlatformKey };

export type {
  DecodedRow,
  DecodedValue,
  ExecOutcome,
  ExecResult,
  ExecValue,
  NativeDatabase,
  NativeEngine,
  NativeEngineConstructor,
  NativeSnapshot,
  NativeWriter,
  RawRow,
  ReadLimits,
  SchemaObject,
};

/** A column definition for `NativeWriter.createTable` (JSON form). */
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

/** 进程内唯一的加载结果；旧消费者经此访问 `SqliteEngine` 等原语。 */
export const bindings = addon;

/** Convert a JS value into the writer's JSON slot form (`undefined`→omit, bytes→`$blob`). */
export function writeValue(value: unknown): unknown {
  if (value === undefined) {
    return { $omit: true };
  }
  if (value instanceof Uint8Array) {
    return { $blob: Buffer.from(value).toString("hex") };
  }
  return value;
}

/** Serialize a slot array into the JSON text `NativeWriter.insert` / `update` expects. */
export function writeSlots(values: unknown[]): string {
  return JSON.stringify(values.map(writeValue));
}

export function createWriter(pageSize?: number): NativeWriter {
  return addon.SqliteWriter.create(pageSize);
}

export function openWriter(path: string): NativeWriter {
  return addon.SqliteWriter.open(path);
}

export function openDatabase(path: string): NativeDatabase {
  return addon.SqliteDatabase.open(path);
}

export function openSnapshot(bytes: Buffer, maxSnapshotBytes?: number): NativeSnapshot {
  return new addon.SqliteSnapshot(bytes, maxSnapshotBytes);
}

export function decodeRecord(payload: Buffer, encoding?: string): DecodedValue[] {
  return addon.decodeRecord(payload, encoding);
}

/** Creates an in-memory JSON SQL engine over the pure-Rust format-3 writer. */
export function createEngine(pageSize?: number): NativeEngine {
  return addon.SqliteEngine.create(pageSize);
}

/** Reopens a main-file image and rebuilds its schema catalog. */
export function createEngineFromSnapshot(bytes: Buffer): NativeEngine {
  return addon.SqliteEngine.fromSnapshot(bytes);
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
