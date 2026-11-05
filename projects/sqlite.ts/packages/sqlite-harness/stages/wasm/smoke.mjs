import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { stagesDir, wasmPlatform } from "../paths.mjs";

const require = createRequire(import.meta.url);
const { MemoryDatabase } = require(resolve(wasmPlatform, "pkg/sqlite_wasm.js"));

const outDir = resolve(stagesDir, "wasm/out");
const databasePath = resolve(outDir, "smoke.sqlite3");

// Assertions are counted per layer so the harness can report SQL execution
// separately from the storage image check. `rows` stays a data-volume field.
const counts = { storage: 0, sql: 0 };
const data = { rows: 0 };

function assertStorage(condition, message) {
  counts.storage += 1;
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function assertSql(condition, message) {
  counts.sql += 1;
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

// Published host contract: the JSON envelope, the fail-closed statement subset
// and the rejection messages. The expectation comes from the documented shape
// in `projects/sqlite.ts/homepage/documents/zh-hans`, never from round-tripping
// the engine against itself.
function checkHostContract() {
  const database = new MemoryDatabase(4096);

  const roundTrip = JSON.parse(
    database.exec(
      "create table t (id integer primary key, label text not null); insert into t (label) values ('alpha'); select count(*) from t; select * from t;",
    ),
  );
  assertSql(roundTrip.length === 4, `four statement results, got ${roundTrip.length}`);
  assertSql(roundTrip[2].columns[0] === "count(*)", "count(*) exposes its column name");
  assertSql(JSON.stringify(roundTrip[2].rows) === "[[1]]", "count(*) sees one row");
  assertSql(
    JSON.stringify(roundTrip[3]) ===
      JSON.stringify({ statement: "select", affected: 0, columns: ["id", "label"], rows: [[1, "alpha"]] }),
    "select round-trips the rowid alias and the text value",
  );

  const created = JSON.parse(database.exec("create table probe (id integer primary key, label text)"));
  assertSql(created[0].statement === "create-table" && created[0].affected === 1, "create-table envelope reports one table");
  const inserted = JSON.parse(database.exec("insert into probe (label) values ('a')"));
  assertSql(inserted[0].statement === "insert" && inserted[0].affected === 1, "insert envelope reports one row");
  assertSql(JSON.stringify(inserted[0].rows) === "[[1]]", "insert returns the assigned rowid");
  assertSql(
    database.exec("select * from probe") === '[{"statement":"select","affected":0,"columns":["id","label"],"rows":[[1,"a"]]}]',
    "select envelope matches the documented JSON wiring",
  );

  const missing = throws(() => database.exec("insert into missing values (1)"));
  assertSql(/unknown table/.test(missing), `unknown table is rejected, got ${missing}`);
  const arity = throws(() => database.exec("insert into probe values (1)"));
  assertSql(/expects 2 values/.test(arity), `arity mismatch is rejected, got ${arity}`);
  const rightJoin = JSON.parse(database.exec("select * from probe right join probe as other on probe.id = other.id"));
  assertSql(
    rightJoin[0].columns.join(",") === "id,label,id,label" && JSON.stringify(rightJoin[0].rows) === '[[1,"a",1,"a"]]',
    `right join keeps the left columns first, got ${JSON.stringify(rightJoin)}`,
  );
  const rejected = throws(() => database.exec("select * from probe for update"));
  assertSql(/unsupported .*clause/i.test(rejected), `unsupported clause is rejected, got ${rejected}`);
  const deleted = JSON.parse(database.exec("delete from probe"));
  assertSql(deleted[0].statement === "delete" && deleted[0].affected === 1, "delete envelope reports one removed row");
  assertSql(JSON.parse(database.exec("select count(*) from probe"))[0].rows[0][0] === 0, "delete empties the table");
  const dropped = throws(() => database.exec("drop table probe"));
  assertSql(/unsupported statement/.test(dropped), `drop is still rejected, got ${dropped}`);
}

// The orthogonal primitives: one statement, a statement list, and the
// non-throwing outcome. Each returns the same JSON envelope as `exec`.
function checkPrimitives() {
  const database = new MemoryDatabase(4096);
  const created = JSON.parse(database.execute("create table p (id integer primary key, label text)"));
  assertSql(created.statement === "create-table" && created.affected === 1, "execute reports create-table");
  const inserted = JSON.parse(database.execute("insert into p (label) values ('a')"));
  assertSql(inserted.statement === "insert" && inserted.affected === 1, "execute reports insert");
  assertSql(JSON.stringify(inserted.rows) === "[[1]]", "execute returns the assigned rowid");
  const selected = JSON.parse(database.execute("select * from p"));
  assertSql(
    JSON.stringify(selected) ===
      JSON.stringify({ statement: "select", affected: 0, columns: ["id", "label"], rows: [[1, "a"]] }),
    "execute returns the select envelope",
  );

  const batch = JSON.parse(database.executeBatch(["insert into p (label) values ('b')", "select count(*) from p"]));
  assertSql(batch.length === 2 && JSON.stringify(batch[1].rows) === "[[2]]", "executeBatch runs the list in order");

  const rightJoin = JSON.parse(database.tryExecute("select * from p right join p as other on p.id = other.id"));
  assertSql(rightJoin.ok === true && rightJoin.result.rows.length === 2, "tryExecute executes a right join");
  const rejected = JSON.parse(database.tryExecute("select * from p for update"));
  assertSql(rejected.ok === false, "tryExecute reports a rejection without throwing");
  assertSql(
    rejected.error.code === "unsupported-clause" && rejected.error.statement === "select" && rejected.error.clause === "UPDATE",
    "tryExecute error carries code, statement and clause",
  );
  assertSql(rejected.error.position === 20, "tryExecute error carries the clause offset");
  const filtered = JSON.parse(database.tryExecute("select label from p where id >= 2 order by id desc limit 1"));
  assertSql(filtered.ok === true && JSON.stringify(filtered.result.rows) === '[["b"]]', "where, order by and limit run together");
  const accepted = JSON.parse(database.tryExecute("select * from p"));
  assertSql(accepted.ok === true && accepted.result.rows.length === 2, "tryExecute returns the result on success");
}

function throws(run) {
  try {
    run();
  } catch (error) {
    return String(error?.message ?? error);
  }
  throw new Error("assertion failed: expected the statement to be rejected");
}

// `NULL` group: a comparison that touches SQL `NULL` stays unknown, so `WHERE`
// must drop the row. Each failure names the offending predicate and carries the
// `three-valued-logic` tag, so one leaked row fails on its own.
const COMPARISONS = [
  "score = null",
  "null = score",
  "score <> null",
  "null <> score",
  "score < null",
  "null < score",
  "score <= null",
  "null <= score",
  "score > null",
  "null > score",
  "score >= null",
  "null >= score",
];

function checkThreeValuedLogic() {
  const database = new MemoryDatabase(4096);
  database.exec(
    "create table nums (id integer primary key, label text, score real);" +
      "insert into nums (label, score) values ('a', 1.5);" +
      "insert into nums (label, score) values ('b', null);" +
      "insert into nums (label, score) values (null, 2.5);" +
      "insert into nums (label, score) values ('d', null);",
  );

  for (const predicate of COMPARISONS) {
    const rows = JSON.parse(database.execute(`select id from nums where ${predicate}`)).rows;
    assertSql(rows.length === 0, `three-valued-logic: \`where ${predicate}\` treated SQL NULL as TRUE and returned ${JSON.stringify(rows)}`);
  }

  const total = JSON.parse(database.execute("select count(*) from nums")).rows[0][0];
  const nullScores = JSON.parse(database.execute("select count(*) from nums where score is null")).rows[0][0];
  const notNullScores = JSON.parse(database.execute("select count(*) from nums where score is not null")).rows[0][0];
  assertSql(total - nullScores === 2, `three-valued-logic: count(*) minus the NULL scores must be 2, got ${total - nullScores}`);
  assertSql(nullScores + notNullScores === total, `three-valued-logic: IS NULL plus IS NOT NULL must cover ${total} rows, got ${nullScores + notNullScores}`);

  const ascending = JSON.parse(database.execute("select id, score from nums order by score asc")).rows;
  const descending = JSON.parse(database.execute("select id, score from nums order by score desc")).rows;
  assertSql(ascending[0][1] === null, `three-valued-logic: ascending order must start with a NULL score, got ${JSON.stringify(ascending)}`);
  assertSql(descending[descending.length - 1][1] === null, `three-valued-logic: descending order must end with a NULL score, got ${JSON.stringify(descending)}`);
}

checkHostContract();
checkPrimitives();
checkThreeValuedLogic();

const wasmBytes = readFileSync(resolve(wasmPlatform, "pkg/sqlite_wasm_bg.wasm")).length;
const database = new MemoryDatabase(4096);
const created = JSON.parse(database.exec("create table bench (id integer primary key, label text not null, score real)"));
assertSql(created[0].statement === "create-table", "create table result shape");

for (let index = 1; index <= 1000; index += 1) {
  database.exec(`insert into bench (id, label, score) values (${index}, 'row-${index}', ${index}.5)`);
}
data.rows = 1000;

const counted = JSON.parse(database.exec("select count(*) from bench"));
assertSql(counted[0].rows.length === 1 && counted[0].rows[0][0] === 1000, "count(*) is 1000");

const sampled = JSON.parse(database.exec("select * from bench limit 3"));
assertSql(sampled[0].rows.length === 3, "limit 3 returns 3 rows");
assertSql(sampled[0].rows[0][0] === 1 && sampled[0].rows[0][1] === "row-1", "first row round-trips");

mkdirSync(outDir, { recursive: true });
writeFileSync(databasePath, database.snapshot());

const external = spawnSync("python", [resolve(stagesDir, "verify_sqlite.py"), databasePath, "bench", "id,label,score"], { encoding: "utf8" });
if (external.status !== 0) {
  throw new Error(`python verification failed:\n${external.stdout}\n${external.stderr}`);
}
const report = JSON.parse(external.stdout);
assertStorage(report.integrity_check === "ok", `PRAGMA integrity_check is ok, got ${report.integrity_check}`);
assertStorage(report.count === 1000, `external sqlite3 sees 1000 rows, got ${report.count}`);
assertStorage(report.first_row[0] === 1 && report.first_row[1] === "row-1", "external sqlite3 reads the first row");

console.log(
  JSON.stringify(
    {
      status: "PASS",
      wasm_bytes: wasmBytes,
      snapshot_bytes: database.snapshot().length,
      page_size: database.pageSize(),
      sqlite_version: database.sqliteVersion(),
      assertions: counts.storage + counts.sql,
      layers: counts,
      rows: data.rows,
      integrity_check: report.integrity_check,
      external_count: report.count,
      first_row: report.first_row,
    },
    null,
    2,
  ),
);
rmSync(outDir, { recursive: true, force: true });
