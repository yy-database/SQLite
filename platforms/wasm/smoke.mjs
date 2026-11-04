import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { MemoryDatabase } = require("./pkg/sqlite_wasm.js");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out");
const databasePath = resolve(outDir, "smoke.sqlite3");

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const wasmBytes = readFileSync(resolve(here, "pkg/sqlite_wasm_bg.wasm")).length;
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

const external = spawnSync("python", [resolve(here, "../verify_sqlite.py"), databasePath, "bench", "id,label,score"], { encoding: "utf8" });
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
