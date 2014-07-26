import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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

export interface RecordValue {
  kind: "null" | "integer" | "real" | "text" | "blob";
  valueInteger?: bigint;
  valueReal?: number;
  valueText?: string;
  valueBlob?: Buffer;
}

export interface DecodedRow {
  rowid: bigint;
  columns: RecordValue[];
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
  tableRaw(name: string, limits?: ReadLimits): RawRow[];
  tableWithoutRowid(name: string, limits?: ReadLimits): RecordValue[][];
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
  decodeRecord(payload: Buffer, encoding?: string): RecordValue[];
}

export const nativePath =
  process.env.SQLITE_NATIVE ??
  fileURLToPath(new URL("../../sqlite.rs/sqlite-napi/sqlite.node", import.meta.url));

export const bindings: NativeBindings = require(nativePath);

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
