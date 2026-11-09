// 独立的检视与格式-3 工具入口：`@yydb/sqlite/inspect`。
//
// 只读检视、镜像解码与快照构建原语从这里进出；正式 SQL 连接一律走主入口
// `new SQLite()`。主包不公开这些句柄，也不提供 `engine()`/`bindings` 后门。

export {
  decodeRecord,
  openDatabase,
  openInMemoryDatabase,
  openSnapshot,
  type DatabaseReader,
  type DecodedRow,
  type DecodedValue,
  type RawRow,
  type ReadLimits,
  type SchemaObject,
  type SnapshotReader,
} from "./reader.ts";

import { addon } from "../native/binding.ts";
import type { NativeWriter } from "../native/binding.ts";

export type WriterHandle = NativeWriter;

/** 创建一个空白 format-3 写者镜像。 */
export function createWriter(pageSize?: number): WriterHandle {
  return addon.SqliteWriter.create(pageSize);
}

/** 载入既有主文件继续改写。 */
export function openWriter(path: string): WriterHandle {
  return addon.SqliteWriter.open(path);
}
