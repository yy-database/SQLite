// 正式产品入口：`new SQLite(options?)` 是一个已经打开、可直接使用的连接。
//
// 本文件只做作者体验与 JS 控制流：选项形状校验、行投影编排、事务闭包、
// addon 桥接。SQL 怎么解释、参数有几个槽位、语句是否写入、提交边界在哪、
// 文件何时落盘，全部读取原生的权威信息（见 `native/binding.ts`）。
// 需要上游链路才能成立的选项（`journalMode`、`limits`、UDF）在被显式请求时
// 抛 `unsupported`，而不是在 TS 里记一个字段假装实现；`busyTimeoutMs` 已由
// 上游跨进程写锁承担，这里只把毫秒数透传给原生。

import { fileURLToPath } from "node:url";

import { SQLiteError, toSQLiteError } from "../errors.ts";
import { addon, type NativeConnection, type NativeRunResult } from "../native/binding.ts";
import { ROW_SET_STATEMENTS, Statement, type ExecutionGuard, type StatementHandle } from "../statement/statement.ts";
import type { SQLiteParams, SQLiteRow, SQLiteRunResult, SQLiteValue } from "../values.ts";
import { normalizeOptions, type SQLiteOptions } from "./options.ts";
import { checkTransactionMode, runTransaction, type TransactionBridge, type TransactionScope } from "./transaction.ts";

export type { SQLiteOptions };

const TRANSACTION_CONTROL_NAMES = new Set(["begin", "commit", "rollback", "savepoint", "release", "rollback-to"]);

let savepointCounter = 0;

/** 把绑定值转成 `PRAGMA name = value` 的字面量文本。 */
function pragmaLiteral(value: SQLiteValue | boolean): string {
  if (value === null) return "NULL";
  if (typeof value === "bigint") return `${value}`;
  if (typeof value === "number") return `${value}`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `x'${Buffer.from(value).toString("hex")}'`;
}

export class SQLite {
  readonly #connection: NativeConnection;
  readonly #readOnly: boolean;
  #managedScopes = 0;
  #closed = false;

  constructor(options: SQLiteOptions = {}) {
    const normalized = normalizeOptions(options);
    try {
      this.#connection = addon.SqliteConnection.open(normalized.native);
    } catch (error) {
      throw toSQLiteError(error);
    }
    this.#readOnly = normalized.readOnly;
    if (!this.#readOnly) {
      this.#exec(`PRAGMA foreign_keys = ${normalized.foreignKeys ? "ON" : "OFF"}`);
    }
  }

  // --- 连接属性 -------------------------------------------------------------

  get filename(): string | null {
    this.#assertOpen();
    return this.#connection.filename();
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  /** 原生权威值，不在 TS 里镜像布尔。 */
  get readOnly(): boolean {
    return this.#readOnly;
  }

  /** 真实引擎状态，不在 TS 里镜像布尔值。 */
  get inTransaction(): boolean {
    this.#assertOpen();
    return this.#connection.inTransaction();
  }

  get sqliteVersion(): string {
    this.#assertOpen();
    return this.#connection.sqliteVersion();
  }

  // --- 语句面 ---------------------------------------------------------------

  prepare<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams>(sql: string): Statement<Row, Params> {
    this.#assertOpen();
    let native;
    try {
      native = this.#connection.prepare(sql);
    } catch (error) {
      throw toSQLiteError(error);
    }
    const guard: ExecutionGuard = (statementName) => this.#assertUsable(statementName);
    const described = native.columns();
    const rowSet = described !== null || ROW_SET_STATEMENTS.has(native.statementName());
    const shared: StatementHandle = { native, guard, state: { activeCursor: false, closed: false, columns: null, described, rowSet } };
    return new Statement<Row, Params>(shared);
  }

  run(sql: string, params?: SQLiteParams): SQLiteRunResult {
    return this.prepare(sql).run(params);
  }

  get<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Row | undefined {
    return this.prepare<Row>(sql).get(params) as Row | undefined;
  }

  all<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Row[] {
    return this.prepare<Row>(sql).all(params) as Row[];
  }

  iterate<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Generator<Row, void, unknown> {
    return this.prepare<Row>(sql).iterate(params) as Generator<Row, void, unknown>;
  }

  /** 执行脚本，返回 `void`，不隐含事务；整批原子执行请放进 `transaction()`。 */
  exec(script: string): void {
    this.#assertOpen();
    this.#assertOwnership(script);
    this.#exec(script);
  }

  // --- 事务 -----------------------------------------------------------------

  /**
   * 立即执行并返回回调结果。回调成功提交、抛错回滚；提交因延迟约束失败
   * 同样回滚并传播失败。嵌套使用 savepoint，内层失败可由外层捕获后继续。
   * 禁止异步回调：返回值若是 Promise 会被拒绝（提交时机不可控）。
   */
  transaction<T>(callback: (tx: TransactionScope) => T, options?: { mode?: "deferred" }): T {
    this.#assertOpen();
    checkTransactionMode(options);
    this.#managedScopes += 1;
    const bridge: TransactionBridge = {
      prepare: <Row, Params extends SQLiteParams>(sql: string) => this.prepare<Row, Params>(sql),
      exec: (script: string) => this.exec(script),
      transaction: <R>(inner: (tx: TransactionScope) => R) => this.transaction(inner),
      inTransaction: () => this.#connection.inTransaction(),
      execControl: (sql: string) => {
        this.#exec(sql);
      },
    };
    try {
      return runTransaction(bridge, callback, `__sqlite_tx_${(savepointCounter += 1)}`);
    } finally {
      this.#managedScopes -= 1;
    }
  }

  // --- 运维 -----------------------------------------------------------------

  pragma(name: string, options?: { scalar?: boolean; value?: SQLiteValue | boolean }): unknown {
    this.#assertOpen();
    if (!/^[\w]+$/.test(name)) throw new SQLiteError("option-invalid", `invalid pragma name ${JSON.stringify(name)}`);
    const set = options?.value !== undefined;
    const sql = set ? `PRAGMA ${name} = ${pragmaLiteral(options.value!)}` : `PRAGMA ${name}`;
    const rows = this.#exec(sql)[0]!;
    if (options?.scalar) return rows.rows[0]?.[0] ?? undefined;
    return rows.rows.map((row) => Object.fromEntries(rows.columns.map((label, index) => [label, row[index] ?? null])));
  }

  /** 一致镜像导出；与 `backup()` 的合同不同。 */
  serialize(): Uint8Array {
    this.#assertOpen();
    try {
      return new Uint8Array(this.#connection.snapshot());
    } catch (error) {
      throw toSQLiteError(error);
    }
  }

  /** 正式备份：由存储层把当前镜像完整写入目标文件，不在 TS 写临时文件再改名。 */
  backup(path: string | URL): void {
    this.#assertOpen();
    if (this.#connection.inTransaction()) {
      throw new SQLiteError("backup-in-transaction", "backup must run outside a transaction to capture a consistent image");
    }
    const target = typeof path === "string" ? path : fileURLToPath(path);
    try {
      this.#connection.backup(target);
    } catch (error) {
      throw toSQLiteError(error);
    }
  }

  // --- UDF：等待上游回调链路 -------------------------------------------------

  function(): never {
    throw new SQLiteError("unsupported", "JS UDF registration needs the upstream host-function chain (database.udf is a Send+Sync contract, not a JS callback bridge)");
  }

  aggregate(): never {
    throw new SQLiteError("unsupported", "JS aggregate callbacks need the upstream host-function chain");
  }

  window(): never {
    throw new SQLiteError("unsupported", "JS window callbacks need the upstream host-function chain");
  }

  // --- 生命周期 -------------------------------------------------------------

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#connection.close();
    } catch (error) {
      throw toSQLiteError(error);
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // --- 内部 -----------------------------------------------------------------

  /** 执行前守卫：连接可用 + 受管事务所有权。只读与写判定由原生权威拒绝。 */
  #assertUsable(statementName: string): void {
    this.#assertOpen();
    if (this.#managedScopes > 0 && TRANSACTION_CONTROL_NAMES.has(statementName)) {
      throw new SQLiteError("transaction-ownership", "managed transactions own BEGIN/COMMIT/ROLLBACK; do not issue them by hand inside transaction()");
    }
  }

  #assertOwnership(script: string): void {
    if (this.#managedScopes === 0) return;
    if (this.#touchesControl(script)) {
      throw new SQLiteError("transaction-ownership", "managed transactions own BEGIN/COMMIT/ROLLBACK; do not issue them by hand inside transaction()");
    }
  }

  #touchesControl(sql: string): boolean {
    let kinds: string[];
    try {
      kinds = this.#connection.statementKinds(sql);
    } catch {
      // 解析失败的脚本会在执行时抛出原始错误，这里不抢先判定。
      return false;
    }
    return kinds.some((kind) => TRANSACTION_CONTROL_NAMES.has(kind));
  }

  #exec(sql: string): NativeRunResult[] {
    try {
      return this.#connection.exec(sql);
    } catch (error) {
      throw toSQLiteError(error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new SQLiteError("db-closed", "database is closed");
  }
}
