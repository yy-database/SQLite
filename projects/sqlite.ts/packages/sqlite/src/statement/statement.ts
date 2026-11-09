// Statement：持有真实原生预编译句柄的执行入口。
//
// 解析、槽位、读写分类、只读拒绝与参数个数都来自原生句柄（Rust 权威）；
// TS 只做参数容器的 JS 形状检查与行投影。`raw()`/`pluck()` 视图共享同一
// 句柄包（原生句柄 + 忙状态），生命周期一致。

import { SQLiteError, toSQLiteError } from "../errors.ts";
import type { NativeRunResult, NativeSlot, NativeStatement } from "../native/binding.ts";
import type { SQLiteBindValue, SQLiteParams, SQLiteRow, SQLiteRunResult, SQLiteValue } from "../values.ts";
import { createIterator } from "./iterator.ts";
import { projectRow, type ResultView } from "./rows.ts";

/** 连接侧的执行前守卫：受管事务所有权等 JS 控制流检查。 */
export type ExecutionGuard = (statementName: string) => void;

/** 同一原生句柄及其忙状态与列标签，被所有视图共享。 */
export interface StatementHandle {
  native: NativeStatement;
  guard: ExecutionGuard;
  state: { activeCursor: boolean; closed: boolean; columns: string[] | null };
}

function normalizeBindValue(value: unknown): SQLiteBindValue {
  if (value === undefined) {
    throw new SQLiteError("param-undefined", "SQL NULL must be an explicit null; undefined is not a bindable value");
  }
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") {
    throw new SQLiteError("param-type", "boolean is not a bindable SQL value; convert it explicitly (e.g. value ? 1 : 0)");
  }
  if (typeof value === "bigint") {
    if (value > 9223372036854775807n || value < -9223372036854775808n) {
      throw new SQLiteError("param-range", "bigint parameter exceeds the signed 64-bit INTEGER range");
    }
    return value;
  }
  if (value instanceof Uint8Array) return Buffer.isBuffer(value) ? value : Buffer.from(value);
  throw new SQLiteError("param-type", "cannot bind Date, arrays or plain objects; convert them explicitly (e.g. value.toISOString(), JSON.stringify)");
}

/** 用原生权威槽位把 JS 参数容器展开成零基位置数组。 */
function bindCells(slots: NativeSlot[], count: number, params: SQLiteParams | undefined): unknown[] {
  const providedCount = params === undefined ? 0 : Array.isArray(params) ? params.length : Object.keys(params).length;
  if (count === 0) {
    if (providedCount > 0) throw new SQLiteError("param-extra", "statement has no placeholders but parameters were provided");
    return [];
  }
  if (params === undefined) {
    throw new SQLiteError("param-missing", `statement needs ${count} parameter(s) but none were provided`);
  }
  const positional = slots.filter((slot) => slot.text.startsWith("?"));
  const named = slots.filter((slot) => !slot.text.startsWith("?"));
  if (Array.isArray(params)) {
    if (named.length > 0) {
      throw new SQLiteError("param-shape", "named placeholders require an object container");
    }
    if (params.length > count) {
      throw new SQLiteError("param-extra", `statement takes ${count} parameter(s), got ${params.length}`);
    }
    if (params.length < count) {
      throw new SQLiteError("param-missing", `expected ${count} positional parameter(s), got ${params.length}`);
    }
    return params.map(normalizeBindValue);
  }
  if (positional.length > 0) {
    throw new SQLiteError("param-shape", "positional placeholders require an array container");
  }
  const record = params as Record<string, unknown>;
  const cells: unknown[] = new Array(count).fill(undefined);
  const consumed = new Set<string>();
  for (const slot of named) {
    const name = slot.text.slice(1);
    // 前缀省略：裸键或任意前缀键都可命中 `:name` 槽位。
    const candidates = [slot.text, name, `$${name}`, `@${name}`];
    const key = candidates.find((candidate) => record[candidate] !== undefined);
    if (key === undefined) {
      throw new SQLiteError("param-missing", `missing value for placeholder ${slot.text}; provide "${name}" or "${slot.text}"`);
    }
    consumed.add(key);
    cells[slot.index] = normalizeBindValue(record[key]);
  }
  const extra = Object.keys(record).filter((key) => !consumed.has(key));
  if (extra.length > 0) throw new SQLiteError("param-extra", `unused parameter keys: ${extra.join(", ")}`);
  return cells;
}

export class Statement<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams> {
  readonly #shared: StatementHandle;
  readonly #view: ResultView;

  /** @internal 由 `SQLite.prepare` 构造；视图方法传入同一个 `shared` 包。 */
  constructor(shared: StatementHandle, view: ResultView = "object") {
    this.#shared = shared;
    this.#view = view;
  }

  get isClosed(): boolean {
    return this.#shared.state.closed;
  }

  /** 结果列标签。prepare 期元数据需要上游 describe 支持，首次执行前会抛 `columns-pending`。 */
  columns(): string[] {
    const columns = this.#shared.state.columns;
    if (columns === null) {
      throw new SQLiteError("columns-pending", "column metadata is captured on first execution; prepare-time describe is not available yet");
    }
    return [...columns];
  }

  raw(): Statement<SQLiteValue[], Params> {
    return new Statement<SQLiteValue[], Params>(this.#shared, "raw");
  }

  pluck<T = SQLiteValue>(): Statement<T, Params> {
    return new Statement<T, Params>(this.#shared, "pluck");
  }

  run(params?: Params): SQLiteRunResult {
    const result = this.#execute(params);
    return { changes: result.affected, lastInsertRowid: result.lastInsertRowid };
  }

  get(params?: Params): Row | undefined {
    const result = this.#execute(params);
    if (result.rows.length === 0) return undefined;
    return projectRow(result, this.#view, 0) as Row;
  }

  all(params?: Params): Row[] {
    const result = this.#execute(params);
    return result.rows.map((_row, index) => projectRow(result, this.#view, index) as Row);
  }

  /**
   * 逐行读取。`for...of` 的耗尽、`break`、异常都会释放游标；手动 `next()`
   * 中途退出需要 `return()`。同一句柄有活跃游标时禁止重复执行，
   * 不静默打断旧游标。
   */
  iterate(params?: Params): Generator<Row, void, unknown> {
    const result = this.#execute(params);
    return createIterator(result, this.#view, this.#shared.state) as Generator<Row, void, unknown>;
  }

  /** 释放原生预编译句柄；共享该句柄的所有视图同时失效。 */
  close(): void {
    if (this.#shared.state.closed) return;
    this.#shared.state.closed = true;
    this.#shared.native.finalize();
  }

  #execute(params: SQLiteParams | undefined): NativeRunResult {
    const state = this.#shared.state;
    if (state.closed) throw new SQLiteError("statement-closed", "statement is closed");
    if (state.activeCursor) throw new SQLiteError("cursor-active", "statement has an active cursor; finish or close it before re-executing");
    this.#shared.guard(this.#shared.native.statementName());
    const cells = bindCells(this.#shared.native.slots(), this.#shared.native.parameterCount(), params);
    let result: NativeRunResult;
    try {
      result = this.#shared.native.run(cells);
    } catch (error) {
      throw toSQLiteError(error);
    }
    state.columns = result.columns;
    return result;
  }
}
