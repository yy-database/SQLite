// 原生执行结果 → JS Iterator 协议。
//
// 每次 `next()` 推进一行，`return()`（含 `for...of` 的 `break`/异常路径）
// 释放忙状态。上游引擎长出真逐行 cursor 之前，行集由原生一次执行物化；
// 本模块只提供 Iterator 协议，不假装原生游标（能力缺口记录在项目纪要）。

import type { NativeRunResult } from "../native/binding.ts";
import { projectRow, type ResultView } from "./rows.ts";

/** 游标忙状态宿主：同一原生句柄的 raw/pluck 视图共享它。 */
export interface CursorState {
  activeCursor: boolean;
}

export function createIterator(result: NativeRunResult, view: ResultView, state: CursorState): Generator<unknown, void, unknown> {
  const total = result.rows.length;
  state.activeCursor = true;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      state.activeCursor = false;
    }
  };
  function* rows(): Generator<unknown, void, unknown> {
    try {
      for (let index = 0; index < total; index += 1) yield projectRow(result, view, index);
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
