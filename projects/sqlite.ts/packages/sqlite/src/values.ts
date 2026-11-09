// 公开 SQL 值、参数与行类型。
//
// 类型映射是忠实的：SQLite INTEGER→`bigint`（含 rowid 与 `lastInsertRowid`）、
// REAL→`number`、TEXT→`string`、BLOB→`Uint8Array`、NULL→`null`；绑定参数与
// 读取遵守同一映射。库不做任何按大小、按精度的自动改判，也不替用户把
// Date/对象转换成数据库值。`boolean` 不是可绑定值——SQL 没有布尔类型，
// 0/1 转换是用户的业务决定。

/** 结果值：忠实映射 SQLite 存储类别。 */
export type SQLiteValue = null | bigint | number | string | Uint8Array;

/** 可绑定值：结果值本身。`boolean` 被显式排除，转换归用户。 */
export type SQLiteBindValue = null | bigint | number | string | Uint8Array;

/** 参数容器只有两种形状：位置数组或具名对象。 */
export type SQLiteParams = readonly SQLiteBindValue[] | Readonly<Record<string, SQLiteBindValue>>;

/** 对象行；重复列标签在执行时抛错，用 `.raw()`/`AS` 消歧。 */
export type SQLiteRow = Readonly<Record<string, SQLiteValue>>;

export interface SQLiteRunResult {
  /** 受影响行数，`bigint`（与 INTEGER 合同一致，不截断到 32 位）。 */
  changes: bigint;
  lastInsertRowid: bigint;
}
