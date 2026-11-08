import { drizzle } from "drizzle-orm/sqlite-proxy";

import { createYydbSqliteProxyEngine } from "./yydb-sqlite-proxy.ts";
import * as schema from "./schema.ts";

/** Builds a Drizzle database bound to `@yydb/sqlite` through `drizzle-orm/sqlite-proxy`. */
export function createYydbDrizzleDatabase(pageSize = 4096) {
  const { engine, execute } = createYydbSqliteProxyEngine(pageSize);
  const db = drizzle(execute, { schema });
  return { engine, db };
}
