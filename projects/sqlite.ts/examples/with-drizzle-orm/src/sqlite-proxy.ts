// Drizzle `sqlite-proxy` 适配：构建在 `@yydb/sqlite` 正式入口 `new SQLite()` 之上。
// 忠实类型映射（INTEGER→bigint）在适配层按 drizzle 的 number 期望收窄；
// 超出安全整数范围时保持 bigint，由使用者显式决定。

import { SQLite, type SQLiteBindValue, type SQLiteValue } from "../../../packages/sqlite/src/index.ts";

export type SqliteProxyMethod = "run" | "all" | "values" | "get";

export type SqliteProxyResult = {
  rows: unknown[] | unknown[][];
};

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;

/** Wraps the `SQLite` entry as the callback shape `drizzle-orm/sqlite-proxy` expects. */
export function createSqliteProxyEngine(pageSize = 4096): {
  connection: SQLite;
  execute: (
    sql: string,
    params: unknown[],
    method: SqliteProxyMethod,
  ) => Promise<SqliteProxyResult>;
} {
  const connection = new SQLite({ pageSize });

  return {
    connection,
    async execute(sql, params, method) {
      // drizzle 的 proxy 合同按位置数组绑定，行以数组形态进出。
      const statement = connection.prepare(sql).raw();
      const bind = params as readonly SQLiteBindValue[];
      if (method === "run") {
        statement.run(bind);
        return { rows: [] };
      }
      if (method === "get") {
        const row = statement.get(bind);
        return { rows: row === undefined ? [] : row.map(toProxyValue) };
      }
      return { rows: statement.all(bind).map((row) => row.map(toProxyValue)) };
    },
  };
}

function toProxyValue(value: SQLiteValue): unknown {
  if (typeof value !== "bigint") return value;
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) return value;
  return Number(value);
}
