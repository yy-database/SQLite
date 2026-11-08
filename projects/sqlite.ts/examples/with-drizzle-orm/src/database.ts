import { drizzle } from "drizzle-orm/sqlite-proxy";

import { createSqliteProxyEngine } from "./sqlite-proxy.ts";
import * as schema from "./schema.ts";

/** Builds a Drizzle database bound to `@yydb/sqlite` through `drizzle-orm/sqlite-proxy`. */
export function createSqliteDrizzleDatabase(pageSize = 4096) {
  const { engine, execute } = createSqliteProxyEngine(pageSize);
  const db = drizzle(execute, { schema });
  return { engine, db };
}
