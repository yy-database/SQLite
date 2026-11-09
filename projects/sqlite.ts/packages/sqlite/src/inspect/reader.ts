// 只读检视包装：文件/镜像的格式-3 检视与记录解码。
//
// 这些原语只读主文件、不执行 SQL；SQL 连接一律走正式入口 `new SQLite()`。

import { addon } from "../native/binding.ts";
import type { DecodedRow, DecodedValue, NativeDatabase, NativeSnapshot, RawRow, ReadLimits, SchemaObject } from "../native/binding.ts";

export type { DecodedRow, DecodedValue, RawRow, ReadLimits, SchemaObject };

/** 一个已打开的只读检视句柄。 */
export type DatabaseReader = NativeDatabase;
/** 一份已校验的内存镜像检视句柄。 */
export type SnapshotReader = NativeSnapshot;

/** 打开（或创建）文件快照，内存回放 `-wal` 或热 `-journal`。 */
export function openDatabase(path: string): DatabaseReader {
  return addon.SqliteDatabase.open(path);
}

/** 打开一个空白内存快照。 */
export function openInMemoryDatabase(): DatabaseReader {
  return addon.SqliteDatabase.openInMemory();
}

/** 校验并复制一份镜像，默认上限 256 MiB。 */
export function openSnapshot(bytes: Uint8Array, maxSnapshotBytes?: number): SnapshotReader {
  return new addon.SqliteSnapshot(Buffer.from(bytes), maxSnapshotBytes);
}

/** 把一条记录载荷解码成忠实类型的存储值。 */
export function decodeRecord(payload: Uint8Array, encoding?: string): DecodedValue[] {
  return addon.decodeRecord(Buffer.from(payload), encoding);
}
