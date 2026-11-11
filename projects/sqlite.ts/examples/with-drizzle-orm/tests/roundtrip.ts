// Drizzle ORM roundtrip over `@yydb/sqlite` via the public `drizzle-orm/sqlite-proxy` hook.
//
// Run: `pnpm --dir projects/sqlite.ts/examples/with-drizzle-orm test`
//   or: `node --experimental-strip-types projects/sqlite.ts/examples/with-drizzle-orm/tests/roundtrip.ts`

import { eq } from "drizzle-orm";

import { createSqliteDrizzleDatabase } from "../src/database.ts";
import { users } from "../src/schema.ts";

async function main(): Promise<void> {
  const { connection, db } = createSqliteDrizzleDatabase(4096);

  connection.exec(
    "create table users (id integer primary key autoincrement not null, name text not null, score real)",
  );

  await db.insert(users).values([
    { name: "alice", score: 1.5 },
    { name: "bob", score: 2.25 },
  ]);

  const all = await db.select().from(users).orderBy(users.id);
  if (all.length !== 2) {
    throw new Error(`expected 2 rows, got ${all.length}`);
  }
  if (all[0]?.name !== "alice" || all[0]?.score !== 1.5) {
    throw new Error(`unexpected first row: ${JSON.stringify(all[0])}`);
  }
  if (all[1]?.name !== "bob" || all[1]?.score !== 2.25) {
    throw new Error(`unexpected second row: ${JSON.stringify(all[1])}`);
  }

  await db.update(users).set({ score: 9 }).where(eq(users.name, "alice"));
  const alice = await db.select().from(users).where(eq(users.name, "alice")).get();
  if (!alice || alice.score !== 9) {
    throw new Error(`expected alice.score=9, got ${JSON.stringify(alice)}`);
  }

  await db.delete(users).where(eq(users.name, "bob"));
  const remaining = await db.select().from(users).all();
  if (remaining.length !== 1 || remaining[0]?.name !== "alice") {
    throw new Error(`expected only alice left, got ${JSON.stringify(remaining)}`);
  }

  console.log("ok with-drizzle-orm roundtrip via sqlite-proxy");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
