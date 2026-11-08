// TypeORM roundtrip over `@yydb/sqlite` via the public `better-sqlite3` `driver` hook.
//
// Run: `pnpm --dir projects/sqlite.ts/examples/with-type-orm test`
//   or: `node --experimental-strip-types projects/sqlite.ts/examples/with-type-orm/tests/roundtrip.ts`

import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteTypeOrmDataSource } from "../src/data-source.ts";
import { UserEntity, type UserRow } from "../src/entities.ts";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "with-type-orm-"));
  const database = join(root, "typeorm.sqlite3");

  try {
    const dataSource = createSqliteTypeOrmDataSource(database);
    await dataSource.initialize();

    const users = dataSource.getRepository(UserEntity);
    await users.save([
      { name: "alice", score: 1.5 },
      { name: "bob", score: 2.25 },
    ] as UserRow[]);

    const all = await users.find({ order: { id: "ASC" } });
    if (all.length !== 2) {
      throw new Error(`expected 2 rows, got ${all.length}`);
    }
    if (all[0]?.name !== "alice" || Number(all[0]?.score) !== 1.5) {
      throw new Error(`unexpected first row: ${JSON.stringify(all[0])}`);
    }

    await users.update({ name: "alice" }, { score: 9 });
    const alice = await users.findOneByOrFail({ name: "alice" });
    if (Number(alice.score) !== 9) {
      throw new Error(`expected alice.score=9, got ${JSON.stringify(alice)}`);
    }

    await users.delete({ name: "bob" });
    const remaining = await users.find();
    if (remaining.length !== 1 || remaining[0]?.name !== "alice") {
      throw new Error(`expected only alice left, got ${JSON.stringify(remaining)}`);
    }

    await dataSource.destroy();
    console.log("ok with-type-orm roundtrip via better-sqlite3 driver hook");
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may keep the handle briefly.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
