import { DataSource } from "typeorm";

import SqliteBetterSqlite3 from "./sqlite-better-sqlite3.ts";
import { UserEntity } from "./entities.ts";

/** TypeORM DataSource wired through the public `driver` option for `better-sqlite3`. */
export function createSqliteTypeOrmDataSource(database: string): DataSource {
  return new DataSource({
    type: "better-sqlite3",
    database,
    driver: SqliteBetterSqlite3,
    entities: [UserEntity],
    synchronize: true,
    logging: false,
  });
}
