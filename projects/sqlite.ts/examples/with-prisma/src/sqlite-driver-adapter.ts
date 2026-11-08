import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ColumnType,
  type ConnectionInfo,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlMigrationAwareDriverAdapterFactory,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
  type TransactionOptions,
} from "@prisma/driver-adapter-utils";

import {
  createEngine,
  type ExecResult,
  type ExecValue,
  type NativeEngine,
} from "../../../packages/sqlite/src/index.ts";

const ADAPTER_NAME = "@yydb/sqlite-prisma-driver-adapter";

/** Prisma `SqlDriverAdapter` backed by `@yydb/sqlite` `createEngine`. */
export class SqliteDriverAdapter implements SqlDriverAdapter {
  readonly provider = "sqlite" as const;
  readonly adapterName = ADAPTER_NAME;
  #engine: NativeEngine;
  #closed = false;

  constructor(engine: NativeEngine) {
    this.#engine = engine;
  }

  getConnectionInfo(): ConnectionInfo {
    return {
      maxBindValues: 999,
      supportsRelationJoins: false,
    };
  }

  async queryRaw(params: SqlQuery): Promise<SqlResultSet> {
    this.#assertOpen();
    try {
      const result = lastResult(this.#engine.executeWithParameters(params.sql, params.args));
      return toResultSet(result);
    } catch (error) {
      throw mapError(error);
    }
  }

  async executeRaw(params: SqlQuery): Promise<number> {
    this.#assertOpen();
    try {
      const result = lastResult(this.#engine.executeWithParameters(params.sql, params.args));
      return result.affected;
    } catch (error) {
      throw mapError(error);
    }
  }

  async executeScript(script: string): Promise<void> {
    this.#assertOpen();
    try {
      this.#engine.exec(script);
    } catch (error) {
      throw mapError(error);
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    this.#assertOpen();
    if (isolationLevel && isolationLevel !== "SERIALIZABLE") {
      throw new DriverAdapterError({
        kind: "InvalidIsolationLevel",
        level: isolationLevel,
      });
    }
    try {
      this.#engine.execute("begin");
    } catch (error) {
      throw mapError(error);
    }
    const options: TransactionOptions = { usePhantomQuery: false };
    return new SqliteTransaction(this.#engine, options);
  }

  async dispose(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DriverAdapterError({ kind: "ConnectionClosed" });
    }
  }
}

class SqliteTransaction implements Transaction {
  readonly provider = "sqlite" as const;
  readonly adapterName = ADAPTER_NAME;
  readonly options: TransactionOptions;
  #engine: NativeEngine;
  #done = false;

  constructor(engine: NativeEngine, options: TransactionOptions) {
    this.#engine = engine;
    this.options = options;
  }

  async queryRaw(params: SqlQuery): Promise<SqlResultSet> {
    this.#assertOpen();
    try {
      return toResultSet(lastResult(this.#engine.executeWithParameters(params.sql, params.args)));
    } catch (error) {
      throw mapError(error);
    }
  }

  async executeRaw(params: SqlQuery): Promise<number> {
    this.#assertOpen();
    try {
      return lastResult(this.#engine.executeWithParameters(params.sql, params.args)).affected;
    } catch (error) {
      throw mapError(error);
    }
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    try {
      this.#engine.execute("commit");
      this.#done = true;
    } catch (error) {
      throw mapError(error);
    }
  }

  async rollback(): Promise<void> {
    this.#assertOpen();
    try {
      this.#engine.execute("rollback");
      this.#done = true;
    } catch (error) {
      throw mapError(error);
    }
  }

  #assertOpen(): void {
    if (this.#done) {
      throw new DriverAdapterError({
        kind: "TransactionAlreadyClosed",
        cause: "transaction already finished",
      });
    }
  }
}

/** Factory matching Prisma's `SqlMigrationAwareDriverAdapterFactory` shape. */
export class SqliteDriverAdapterFactory implements SqlMigrationAwareDriverAdapterFactory {
  readonly provider = "sqlite" as const;
  readonly adapterName = ADAPTER_NAME;
  #pageSize: number;

  constructor(pageSize = 4096) {
    this.#pageSize = pageSize;
  }

  async connect(): Promise<SqlDriverAdapter> {
    return new SqliteDriverAdapter(createEngine(this.#pageSize));
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    return new SqliteDriverAdapter(createEngine(this.#pageSize));
  }
}

function lastResult(batch: ExecResult[]): ExecResult {
  if (batch.length === 0) {
    return { statement: "pragma", affected: 0, columns: [], rows: [] };
  }
  return batch[batch.length - 1]!;
}

function toResultSet(result: ExecResult): SqlResultSet {
  const rows = result.rows.map((row) => row.map(unwrap));
  const columnTypes = result.columns.map((_, index) => inferColumnType(rows, index));
  return {
    columnNames: [...result.columns],
    columnTypes,
    rows,
    lastInsertId:
      result.statement === "insert" && result.rows[0]?.[0] != null
        ? String(result.rows[0][0])
        : undefined,
  };
}

function unwrap(value: ExecValue): unknown {
  if (value && typeof value === "object" && "$blob" in value) {
    return Buffer.from(value.$blob, "hex");
  }
  return value;
}

function inferColumnType(rows: unknown[][], index: number): ColumnType {
  for (const row of rows) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    if (typeof value === "bigint") return ColumnTypeEnum.Int64;
    if (typeof value === "number") {
      return Number.isInteger(value) ? ColumnTypeEnum.Int32 : ColumnTypeEnum.Double;
    }
    if (typeof value === "boolean") return ColumnTypeEnum.Boolean;
    if (typeof value === "string") return ColumnTypeEnum.Text;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return ColumnTypeEnum.Bytes;
  }
  return ColumnTypeEnum.Text;
}

function mapError(error: unknown): DriverAdapterError {
  if (error instanceof DriverAdapterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DriverAdapterError({
    kind: "sqlite",
    extendedCode: 1,
    message,
  });
}
