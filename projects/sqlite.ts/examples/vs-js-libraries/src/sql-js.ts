import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    reset(): void;
    free(): void;
  };
  export(): Uint8Array;
  close(): void;
};

export type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
};

const requireFromHarness = createRequire(
  join(fileURLToPath(new URL("../../../packages/sqlite-harness/package.json", import.meta.url))),
);

/** Resolve `sql.js` from the workspace harness pin (same oracle suite dependency). */
export async function loadSqlJs(): Promise<SqlJsStatic> {
  const entry = requireFromHarness.resolve("sql.js");
  const factory = requireFromHarness("sql.js") as (options: {
    locateFile(file: string): string;
  }) => Promise<SqlJsStatic>;
  return factory({ locateFile: (file) => join(dirname(entry), file) });
}
