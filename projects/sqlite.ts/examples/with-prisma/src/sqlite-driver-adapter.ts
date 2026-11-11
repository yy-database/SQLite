// Prisma `SqlDriverAdapter` 实现，构建在 `@yydb/sqlite` 正式入口 `new SQLite()` 之上。
//
// 忠实类型映射（INTEGER→bigint）在适配层按 Prisma 的列类型合同收窄：能落进
// 32 位整数的 INTEGER 报 Int32 并转 number，更大的保持 bigint 报 Int64。
// boolean/Date 不是 SQLite 可绑定值，转换是适配层职责：boolean→0/1 INTEGER，
// Date→ISO 文本（与旧 JSON 信封的序列化结果一致）。

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

import { SQLite, type SQLiteBindValue, type SQLiteValue } from "../../../packages/sqlite/src/index.ts";

const ADAPTER_NAME = "@yydb/sqlite-prisma-driver-adapter";

const MAX_INT32 = 2147483647n;
const MIN_INT32 = -2147483648n;

/** Prisma `SqlDriverAdapter` backed by the `@yydb/sqlite` `SQLite` entry. */
export class SqliteDriverAdapter implements SqlDriverAdapter {
  readonly provider = "sqlite" as const;
  readonly adapterName = ADAPTER_NAME;
  #connection: SQLite;
  #closed = false;

  constructor(connection: SQLite) {
    this.#connection = connection;
  }

  getConnectionInfo(): ConnectionInfo {
    return {
      maxBindValues: 999,
      supportsRelationJoins: false,
    };
  }

  async queryRaw(params: SqlQuery): Promise<SqlResultSet> {
    this.#assertOpen();
    return queryRawOn(this.#connection, params);
  }

  async executeRaw(params: SqlQuery): Promise<number> {
    this.#assertOpen();
    return executeRawOn(this.#connection, params);
  }

  async executeScript(script: string): Promise<void> {
    this.#assertOpen();
    try {
      this.#connection.exec(script);
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
      this.#connection.exec("begin");
    } catch (error) {
      throw mapError(error);
    }
    const options: TransactionOptions = { usePhantomQuery: false };
    return new SqliteTransaction(this.#connection, options);
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
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
  #connection: SQLite;
  #done = false;

  constructor(connection: SQLite, options: TransactionOptions) {
    this.#connection = connection;
    this.options = options;
  }

  async queryRaw(params: SqlQuery): Promise<SqlResultSet> {
    this.#assertOpen();
    return queryRawOn(this.#connection, params);
  }

  async executeRaw(params: SqlQuery): Promise<number> {
    this.#assertOpen();
    return executeRawOn(this.#connection, params);
  }

  async commit(): Promise<void> {
    this.#assertOpen();
    try {
      this.#connection.exec("commit");
      this.#done = true;
    } catch (error) {
      throw mapError(error);
    }
  }

  async rollback(): Promise<void> {
    this.#assertOpen();
    try {
      this.#connection.exec("rollback");
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
    return new SqliteDriverAdapter(new SQLite({ pageSize: this.#pageSize }));
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    return new SqliteDriverAdapter(new SQLite({ pageSize: this.#pageSize }));
  }
}

async function queryRawOn(connection: SQLite, params: SqlQuery): Promise<SqlResultSet> {
  try {
    const statement = connection.prepare(params.sql).raw();
    const rows = statement.all(toBindParams(params.args)).map(toDriverRow);
    return toResultSet(statement.columns(), rows, params.sql);
  } catch (error) {
    throw mapError(error);
  }
}

async function executeRawOn(connection: SQLite, params: SqlQuery): Promise<number> {
  try {
    return Number(connection.run(params.sql, toBindParams(params.args)).changes);
  } catch (error) {
    throw mapError(error);
  }
}

function toBindParams(args: readonly unknown[]): readonly SQLiteBindValue[] {
  return args.map((arg) => {
    if (typeof arg === "boolean") return arg ? 1n : 0n;
    if (arg instanceof Date) return arg.toISOString();
    return arg as SQLiteBindValue;
  });
}

function toDriverRow(row: SQLiteValue[]): unknown[] {
  return row.map((value) => {
    if (typeof value === "bigint" && value >= MIN_INT32 && value <= MAX_INT32) return Number(value);
    return value;
  });
}

function toResultSet(columnNames: string[], rows: unknown[][], sql: string): SqlResultSet {
  return {
    columnNames: [...columnNames],
    columnTypes: columnNames.map((_, index) => inferColumnType(rows, index)),
    rows,
    lastInsertId:
      isInsertSql(sql) && rows[0]?.[0] != null ? String(rows[0][0]) : undefined,
  };
}

function isInsertSql(sql: string): boolean {
  const trimmed = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, "").replace(/^\s*--[^\n]*\n/g, "").trimStart();
  return /^insert\b/i.test(trimmed);
}

function inferColumnType(rows: unknown[][], index: number): ColumnType {
  for (const row of rows) {
    const value = row[index];
    if (value === null || value === undefined) continue;
    if (typeof value === "bigint") return ColumnTypeEnum.Int64;
    if (typeof value === "number") {
      return Number.isInteger(value) ? ColumnTypeEnum.Int32 : ColumnTypeEnum.Double;
    }
    if (typeof value === "string") return ColumnTypeEnum.Text;
    if (value instanceof Uint8Array) return ColumnTypeEnum.Bytes;
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
