import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { stagesDir, wasmPlatform } from "../paths.mjs";

const require = createRequire(import.meta.url);
const { MemoryDatabase } = require(resolve(wasmPlatform, "pkg/sqlite_wasm.js"));

const outDir = resolve(stagesDir, "wasm/out");
const databasePath = resolve(outDir, "smoke.sqlite3");

function assert(condition, message) {
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
  assert(roundTrip.length === 4, `four statement results, got ${roundTrip.length}`);
  assert(roundTrip[2].columns[0] === "count(*)", "count(*) exposes its column name");
  assert(JSON.stringify(roundTrip[2].rows) === "[[1]]", "count(*) sees one row");
  assert(
    JSON.stringify(roundTrip[3]) ===
      JSON.stringify({ statement: "select", affected: 0, columns: ["id", "label"], rows: [[1, "alpha"]] }),
    "select round-trips the rowid alias and the text value",
  );

  const created = JSON.parse(database.exec("create table probe (id integer primary key, label text)"));
  assert(created[0].statement === "create-table" && created[0].affected === 1, "create-table envelope reports one table");
  const inserted = JSON.parse(database.exec("insert into probe (label) values ('a')"));
  assert(inserted[0].statement === "insert" && inserted[0].affected === 1, "insert envelope reports one row");
  assert(JSON.stringify(inserted[0].rows) === "[[1]]", "insert returns the assigned rowid");
  assert(
    database.exec("select * from probe") === '[{"statement":"select","affected":0,"columns":["id","label"],"rows":[[1,"a"]]}]',
    "select envelope matches the documented JSON wiring",
  );

  const missing = throws(() => database.exec("insert into missing values (1)"));
  assert(/unknown table/.test(missing), `unknown table is rejected, got ${missing}`);
  const arity = throws(() => database.exec("insert into probe values (1)"));
  assert(/expects 2 values/.test(arity), `arity mismatch is rejected, got ${arity}`);
  const deleted = throws(() => database.exec("delete from probe"));
  assert(/unsupported statement/.test(deleted), `delete is rejected, got ${deleted}`);
  const ordered = throws(() => database.exec("select * from probe order by id"));
  assert(/unsupported `SELECT` clause/.test(ordered), `order by is rejected, got ${ordered}`);
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

const wasmBytes = readFileSync(resolve(wasmPlatform, "pkg/sqlite_wasm_bg.wasm")).length;
const database = new MemoryDatabase(4096);
const created = JSON.parse(database.exec("create table bench (id integer primary key, label text not null, score real)"));
assert(created[0].statement === "create-table", "create table result shape");

for (let index = 1; index <= 1000; index += 1) {
  database.exec(`insert into bench (id, label, score) values (${index}, 'row-${index}', ${index}.5)`);
}

const counted = JSON.parse(database.exec("select count(*) from bench"));
assert(counted[0].rows.length === 1 && counted[0].rows[0][0] === 1000, "count(*) is 1000");

const sampled = JSON.parse(database.exec("select * from bench limit 3"));
assert(sampled[0].rows.length === 3, "limit 3 returns 3 rows");
assert(sampled[0].rows[0][0] === 1 && sampled[0].rows[0][1] === "row-1", "first row round-trips");

mkdirSync(outDir, { recursive: true });
writeFileSync(databasePath, database.snapshot());

const external = spawnSync("python", [resolve(stagesDir, "verify_sqlite.py"), databasePath, "bench", "id,label,score"], { encoding: "utf8" });
if (external.status !== 0) {
  throw new Error(`python verification failed:\n${external.stdout}\n${external.stderr}`);
}
const report = JSON.parse(external.stdout);
assert(report.integrity_check === "ok", `PRAGMA integrity_check is ok, got ${report.integrity_check}`);
assert(report.count === 1000, `external sqlite3 sees 1000 rows, got ${report.count}`);
assert(report.first_row[0] === 1 && report.first_row[1] === "row-1", "external sqlite3 reads the first row");

console.log(
  JSON.stringify(
    {
      status: "PASS",
      wasm_bytes: wasmBytes,
      snapshot_bytes: database.snapshot().length,
      page_size: database.pageSize(),
      sqlite_version: database.sqliteVersion(),
      count: counted[0].rows[0][0],
      integrity_check: report.integrity_check,
      external_count: report.count,
      first_row: report.first_row,
    },
    null,
    2,
  ),
);
rmSync(outDir, { recursive: true, force: true });
