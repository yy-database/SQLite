// Prisma driver-adapter roundtrip over `@yydb/sqlite` via the public `SqlDriverAdapter` hook.
// Exercises the adapter contract Prisma Client uses (`queryRaw` / `executeRaw` / transactions).
// Full `PrismaClient` model codegen still needs `prisma generate` and is out of this smoke path.
//
// Run: `pnpm --dir projects/sqlite.ts/examples/with-prisma test`
//   or: `node --experimental-strip-types projects/sqlite.ts/examples/with-prisma/tests/adapter-roundtrip.ts`

import { ColumnTypeEnum } from "@prisma/driver-adapter-utils";

import { SqliteDriverAdapterFactory } from "../src/sqlite-driver-adapter.ts";

async function main(): Promise<void> {
  const factory = new SqliteDriverAdapterFactory(4096);
  const adapter = await factory.connect();

  await adapter.executeScript(`
    create table users (
      id integer primary key autoincrement not null,
      name text not null,
      score real
    );
  `);

  const inserted = await adapter.executeRaw({
    sql: "insert into users (name, score) values (?, ?)",
    args: ["alice", 1.5],
    argTypes: [
      { scalarType: "string", arity: "scalar" },
      { scalarType: "float", arity: "scalar" },
    ],
  });
  if (inserted !== 1) throw new Error(`expected 1 inserted, got ${inserted}`);

  await adapter.executeRaw({
    sql: "insert into users (name, score) values (?, ?)",
    args: ["bob", 2.25],
    argTypes: [
      { scalarType: "string", arity: "scalar" },
      { scalarType: "float", arity: "scalar" },
    ],
  });

  const selected = await adapter.queryRaw({
    sql: "select id, name, score from users order by id",
    args: [],
    argTypes: [],
  });
  if (selected.columnNames.join(",") !== "id,name,score") {
    throw new Error(`unexpected columns: ${selected.columnNames.join(",")}`);
  }
  if (selected.rows.length !== 2) {
    throw new Error(`expected 2 rows, got ${selected.rows.length}`);
  }
  if (selected.rows[0]?.[1] !== "alice" || selected.rows[0]?.[2] !== 1.5) {
    throw new Error(`unexpected first row: ${JSON.stringify(selected.rows[0])}`);
  }
  if (selected.columnTypes[2] !== ColumnTypeEnum.Double) {
    throw new Error(`expected score column Double, got ${selected.columnTypes[2]}`);
  }

  const tx = await adapter.startTransaction();
  await tx.executeRaw({
    sql: "update users set score = ? where name = ?",
    args: [9, "alice"],
    argTypes: [
      { scalarType: "float", arity: "scalar" },
      { scalarType: "string", arity: "scalar" },
    ],
  });
  await tx.commit();

  const alice = await adapter.queryRaw({
    sql: "select score from users where name = ?",
    args: ["alice"],
    argTypes: [{ scalarType: "string", arity: "scalar" }],
  });
  if (alice.rows[0]?.[0] !== 9) {
    throw new Error(`expected alice.score=9, got ${JSON.stringify(alice.rows[0])}`);
  }

  const shadow = await factory.connectToShadowDb();
  await shadow.executeScript("create table shadow_probe (id integer primary key)");
  await shadow.dispose();
  await adapter.dispose();

  console.log("ok with-prisma adapter-roundtrip via SqlDriverAdapter");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
