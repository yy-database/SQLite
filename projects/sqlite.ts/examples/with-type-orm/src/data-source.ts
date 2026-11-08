import { DataSource } from "typeorm";

import YydbBetterSqlite3 from "./yydb-better-sqlite3.ts";
import { UserEntity } from "./entities.ts";

/** TypeORM DataSource wired through the public `driver` option for `better-sqlite3`. */
export function createYydbTypeOrmDataSource(database: string): DataSource {
  return new DataSource({
    type: "better-sqlite3",
    database,
    driver: YydbBetterSqlite3,
    entities: [UserEntity],
    synchronize: true,
    logging: false,
  });
}
