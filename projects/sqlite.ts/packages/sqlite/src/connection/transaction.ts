// 同步事务闭包与 `TransactionScope` 视图。
//
// 提交时机、savepoint 链路与落盘边界由原生连接权威决定；TS 只负责 JS 控制
// 流：回调同步性、异常回滚与作用域失效。

import { SQLiteError } from "../errors.ts";
import type { SQLiteParams, SQLiteRow, SQLiteRunResult } from "../values.ts";
import type { Statement } from "../statement/statement.ts";

/** `transaction()` 回调收到的作用域视图：不是新连接，出了作用域即失效。 */
export class TransactionScope {
  #bridge: TransactionBridge;
  #active = true;

  /** @internal 由 `SQLite.transaction` 构造。 */
  constructor(bridge: TransactionBridge) {
    this.#bridge = bridge;
  }

  prepare<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams>(sql: string): Statement<Row, Params> {
    this.#assert();
    return this.#bridge.prepare<Row, Params>(sql);
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

  exec(script: string): void {
    this.#assert();
    this.#bridge.exec(script);
  }

  transaction<T>(callback: (tx: TransactionScope) => T): T {
    this.#assert();
    return this.#bridge.transaction(callback);
  }

  /** @internal 作用域退出后失效。 */
  deactivate(): void {
    this.#active = false;
  }

  #assert(): void {
    if (!this.#active) throw new SQLiteError("scope-escaped", "transaction scope cannot be used outside its callback");
  }
}

/** 闭包运行器需要的连接能力，由 `SQLite` 以内部桥接对象提供。 */
export interface TransactionBridge {
  prepare<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams>(sql: string): Statement<Row, Params>;
  exec(script: string): void;
  transaction<T>(callback: (tx: TransactionScope) => T): T;
  inTransaction(): boolean;
  /** 直接执行控制语句，绕过受管所有权检查（仅闭包运行器使用）。 */
  execControl(sql: string): void;
}

/** 校验事务模式的 JS 形状；本引擎只有 deferred 级别。 */
export function checkTransactionMode(options?: { mode?: string }): void {
  if (options?.mode !== undefined && options.mode !== "deferred") {
    throw new SQLiteError("unsupported", `transaction mode "${options.mode}" needs real lock semantics; this engine only has the deferred level`);
  }
}

/**
 * 立即执行并返回回调结果。回调成功提交、抛错回滚；提交因延迟约束失败
 * 同样回滚并传播失败。嵌套使用 savepoint，内层失败可由外层捕获后继续。
 * 禁止异步回调：返回值若是 Promise 会被拒绝（提交时机不可控）。
 */
export function runTransaction<T>(bridge: TransactionBridge, callback: (tx: TransactionScope) => T, savepointName: string): T {
  const nested = bridge.inTransaction();
  if (nested) bridge.execControl(`SAVEPOINT ${savepointName}`);
  else bridge.execControl("BEGIN");

  const scope = new TransactionScope(bridge);
  let outcome: T;
  try {
    outcome = callback(scope);
  } catch (error) {
    scope.deactivate();
    try {
      if (nested) {
        bridge.execControl(`ROLLBACK TO ${savepointName}`);
        bridge.execControl(`RELEASE ${savepointName}`);
      } else {
        bridge.execControl("ROLLBACK");
      }
    } catch {
      // 回滚失败不掩盖原始错误。
    }
    throw error;
  }
  if (outcome instanceof Promise) {
    // 异步回调会把提交时机推到 Promise 之前，直接拒绝并回滚。
    try {
      if (nested) bridge.execControl(`ROLLBACK TO ${savepointName}`);
      else bridge.execControl("ROLLBACK");
    } catch {
      // ignore
    }
    scope.deactivate();
    throw new SQLiteError("async-callback", "transaction callbacks must be synchronous; Promise results are rejected before commit");
  }
  scope.deactivate();
  try {
    if (nested) bridge.execControl(`RELEASE ${savepointName}`);
    else bridge.execControl("COMMIT");
  } catch (error) {
    try {
      if (!nested) bridge.execControl("ROLLBACK");
    } catch {
      // 回滚失败不掩盖提交失败。
    }
    throw new SQLiteError("commit-failed", error instanceof Error ? error.message : String(error), { cause: error });
  }
  return outcome;
}
