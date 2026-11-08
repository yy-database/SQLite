import {
  createEngine,
  type ExecResult,
  type NativeEngine,
} from "../../../packages/sqlite/src/index.ts";

export type SqliteProxyMethod = "run" | "all" | "values" | "get";

export type SqliteProxyResult = {
  rows: unknown[] | unknown[][];
};

/** Wraps `createEngine` as the callback shape `drizzle-orm/sqlite-proxy` expects. */
export function createYydbSqliteProxyEngine(pageSize = 4096): {
  engine: NativeEngine;
  execute: (
    sql: string,
    params: unknown[],
    method: SqliteProxyMethod,
  ) => Promise<SqliteProxyResult>;
} {
  const engine = createEngine(pageSize);

  return {
    engine,
    async execute(sql, params, method) {
      const batch = engine.executeWithParameters(sql, params);
      const result = lastResult(batch);
      if (method === "run") {
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: (result.rows[0] ?? []) as unknown[] };
      }
      return { rows: result.rows as unknown[][] };
    },
  };
}

function lastResult(batch: ExecResult[]): ExecResult {
  if (batch.length === 0) {
    return { statement: "pragma", affected: 0, columns: [], rows: [] };
  }
  return batch[batch.length - 1]!;
}
