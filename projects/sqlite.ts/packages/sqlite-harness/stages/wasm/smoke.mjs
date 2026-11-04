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
  const deleted = throws(() => database.exec("delete from probe"));
  assertSql(/unsupported statement/.test(deleted), `delete is rejected, got ${deleted}`);
  const grouped = throws(() => database.exec("select * from probe group by id"));
  assertSql(/unsupported `SELECT` clause/.test(grouped), `group by is rejected, got ${grouped}`);
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

  const rejected = JSON.parse(database.tryExecute("select * from p group by id"));
  assertSql(rejected.ok === false, "tryExecute reports a rejection without throwing");
  assertSql(
    rejected.error.code === "unsupported-clause" && rejected.error.statement === "select" && rejected.error.clause === "GROUP",
    "tryExecute error carries code, statement and clause",
  );
  assertSql(rejected.error.position === 16, "tryExecute error carries the clause offset");
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

checkHostContract();
checkPrimitives();

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
