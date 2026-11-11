// options 定义与 JS 形状校验。
//
// TS 层只判断选项的 JS 形状与诚实性（未实现的旋钮显式拒绝）；文件是否存在、
// 是否只读、页大小等数据库行为全部交给原生连接。

import { fileURLToPath } from "node:url";

import type { NativeConnectionOptions } from "../native/binding.ts";
import { SQLiteError } from "../errors.ts";

export interface SQLiteOptions {
  /** 文件路径；与 `data` 互斥。不存在时默认创建（`create: false` 要求已存在）。 */
  filename?: string | URL;
  /** 从镜像创建私有内存副本；不自动写回传入数组。 */
  data?: Uint8Array;
  /** 文件不存在时是否创建，默认 `true`。 */
  create?: boolean;
  /** 只读打开：拒绝任何写语句，永不写文件。默认 `false`。 */
  readOnly?: boolean;
  /** 外键约束，默认开启（本绑定的明确产品策略）。 */
  foreignKeys?: boolean;
  /** 仅支持 `"preserve"`（提交时发布一致镜像）；`"delete"`/`"wal"` 需要真实日志实现，显式请求会抛 unsupported。 */
  journalMode?: "preserve" | "delete" | "wal";
  /** 新建库的页大小，默认 4096。 */
  pageSize?: number;
  /** `PRAGMA synchronous`：`false` 时落盘跳过持久化刷新，默认 `true`。 */
  synchronous?: boolean;
  /**
   * 文件写连接等待跨进程写锁的毫秒数，默认 `0`（只尝试一次）。
   * 超时以 `busy` 拒绝；只读、内存与字节镜像连接不参与加锁，该值无意义。
   */
  busyTimeoutMs?: number;
  /** 未支持：需要上游限额链路。传入即抛 `unsupported`。 */
  limits?: Record<string, number>;
}

export interface NormalizedOptions {
  /** 直接交给原生连接的值。 */
  native: NativeConnectionOptions;
  foreignKeys: boolean;
  readOnly: boolean;
}

/** 校验选项的 JS 形状，返回可交给原生的值；未实现的能力显式拒绝。 */
export function normalizeOptions(options: SQLiteOptions): NormalizedOptions {
  if (options.busyTimeoutMs !== undefined) {
    const timeout = options.busyTimeoutMs;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0 || timeout > 0xffff_ffff) {
      throw new SQLiteError(
        "option-invalid",
        `busyTimeoutMs must be a non-negative integer number of milliseconds (<= 4294967295), got ${String(timeout)}`,
      );
    }
  }
  if (options.limits !== undefined) {
    throw new SQLiteError("unsupported", "limits requires the upstream resource-limit chain; apply explicit checks at the call site for now");
  }
  if ((options as { integers?: unknown }).integers !== undefined) {
    throw new SQLiteError("unsupported", "the integers mode was removed; INTEGER is always bigint, REAL is always number");
  }
  if (options.journalMode !== undefined && options.journalMode !== "preserve") {
    throw new SQLiteError("unsupported", `journalMode "${options.journalMode}" needs a real journal/locking implementation`);
  }
  if (options.data !== undefined && (options.filename !== undefined || options.create !== undefined)) {
    throw new SQLiteError("option-conflict", "data is mutually exclusive with filename/create");
  }

  const readOnly = options.readOnly ?? false;
  const native: NativeConnectionOptions = { readOnly, create: options.create ?? true, synchronous: options.synchronous ?? true };
  if (options.filename !== undefined) {
    native.filename = typeof options.filename === "string" ? options.filename : fileURLToPath(options.filename);
  }
  if (options.data !== undefined) {
    native.data = options.data;
  }
  if (options.pageSize !== undefined) {
    native.pageSize = options.pageSize;
  }
  if (options.busyTimeoutMs !== undefined) {
    native.busyTimeoutMs = options.busyTimeoutMs;
  }
  return { native, foreignKeys: options.foreignKeys ?? true, readOnly };
}
