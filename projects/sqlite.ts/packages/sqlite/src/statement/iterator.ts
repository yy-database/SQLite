// 原生游标窗口 → JS Iterator 协议。
//
// `iterate()` 通过连接内游标逐窗取值，每窗最多 `CURSOR_WINDOW` 行。Rust 侧
// 仍在打开游标时物化完整行集（引擎没有逐行执行接口），所以这不是端到端
// 流式执行；收益是 JS 不再一次构造全部行对象，且窗口大小有界。
//
// 游标生命周期由 `finally` 与 `return()` 关闭：`for...of` 的正常耗尽、
// `break` 与异常路径都会走到 `return()`，不会把游标留在连接里。

import { toSQLiteError } from "../errors.ts";
import type { NativeCell, NativeStatement } from "../native/binding.ts";
import { projectRow, type ResultView } from "./rows.ts";

/** 每次从原生游标取的行数。 */
export const CURSOR_WINDOW = 256;

/** 游标忙状态宿主：同一原生句柄的 raw/pluck 视图共享它。 */
export interface CursorState {
  activeCursor: boolean;
}

/** 把已打开的游标包装成可迭代的行对象序列。 */
export function createIterator(
  native: Pick<NativeStatement, "cursorNext" | "cursorClose">,
  handle: number,
  columns: string[],
  view: ResultView,
  state: CursorState,
): Generator<unknown, void, unknown> {
  const window: { columns: string[]; rows: NativeCell[][] } = { columns, rows: [] };
  let index = 0;
  let done = false;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    state.activeCursor = false;
    try {
      native.cursorClose(handle);
    } catch {
      // 连接可能已经关闭；生命周期由原生侧兜底，清理不再抛第二轮错误。
    }
  };

  function* rows(): Generator<unknown, void, unknown> {
    try {
      while (true) {
        if (index < window.rows.length) {
          yield projectRow(window, view, index++);
          continue;
        }
        if (done) return;
        let batch;
        try {
          batch = native.cursorNext(handle, CURSOR_WINDOW);
        } catch (error) {
          throw toSQLiteError(error);
        }
        window.rows = batch.rows;
        index = 0;
        done = batch.done;
        if (window.rows.length === 0 && done) return;
      }
    } finally {
      release();
    }
  }

  const generator = rows();
  const originalReturn = generator.return.bind(generator);
  generator.return = () => {
    release();
    return originalReturn();
  };
  return generator;
}
