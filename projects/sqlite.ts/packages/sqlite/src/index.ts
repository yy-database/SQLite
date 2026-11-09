// 正式产品入口：`new SQLite(options?)` 是一个已打开、可直接使用的连接，
// 查询、预编译语句、事务全部从这里闭合，类型映射忠实（INTEGER→bigint、
// BLOB→Uint8Array）。
//
// 检视与 format-3 工具另有 `@yydb/sqlite/inspect` 子路径。本文件下方再导出的
// `createEngine` / `executeSql` / `bindings` / `Native*` 是过渡 JSON 原语面，
// 仅为尚未迁移的 ORM 适配、harness 与 examples 暂留，待消费者迁到新入口后移除。

export { SQLite } from "./connection/sqlite.ts";
export type { SQLiteOptions } from "./connection/options.ts";
export { TransactionScope } from "./connection/transaction.ts";
export { Statement } from "./statement/statement.ts";
export { SQLiteError } from "./errors.ts";
export type {
  SQLiteBindValue,
  SQLiteParams,
  SQLiteRow,
  SQLiteRunResult,
  SQLiteValue,
} from "./values.ts";

// 过渡原语面（见 primitives.ts 顶部说明），消费者迁移完成后整段移除。
export * from "./primitives.ts";
