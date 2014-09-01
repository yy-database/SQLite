import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { nativeBindingPath, repository, stagesDir } from "../paths.mjs";

const require = createRequire(import.meta.url);

const outDir = resolve(stagesDir, "node/out");
const databasePath = resolve(outDir, "node-smoke.sqlite3");

// The stage reports assertion counts, never the row count it happens to write.
// `rows` is the data volume, kept in a separate field so a bigger benchmark
// can never pass for more coverage.
const counts = { storage: 0, sql: 0 };
const data = { rows: 0 };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

function assertStorage(condition, message) {
  counts.storage += 1;
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

run(process.execPath, [resolve(repository, "scripts/build-napi.mjs")], repository);

const binding = require(nativeBindingPath());
const columns = [
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT", notNull: true },
  { name: "score", declaredType: "REAL" },
];
const writer = binding.SqliteWriter.create(4096);
writer.createTable("bench", JSON.stringify(columns));
for (let index = 1; index <= 1000; index += 1) {
  writer.insert("bench", JSON.stringify([index, `row-${index}`, index / 10]));
}
mkdirSync(outDir, { recursive: true });
writer.save(databasePath);
data.rows = 1000;

const rows = writer.tableDecoded("bench");
assertStorage(rows.length === 1000, `writer sees 1000 rows, got ${rows.length}`);
assertStorage(rows[0].rowid === 1n, "first rowid is 1");

const external = spawnSync("python", [resolve(stagesDir, "verify_sqlite.py"), databasePath, "bench", "id,label,score"], { encoding: "utf8" });
if (external.status !== 0) {
  throw new Error(`python verification failed:\n${external.stdout}\n${external.stderr}`);
}
const report = JSON.parse(external.stdout);
assertStorage(report.integrity_check === "ok", `PRAGMA integrity_check is ok, got ${report.integrity_check}`);
assertStorage(report.count === 1000, `external sqlite3 sees 1000 rows, got ${report.count}`);
assertStorage(report.first_row[0] === 1 && report.first_row[1] === "row-1", "external sqlite3 reads the first row");

const database = binding.SqliteDatabase.open(databasePath);
assertStorage(database.ping() > 0, "header ping");
assertStorage(database.table("bench").length === 1000, "reader sees 1000 rows");

console.log(
  JSON.stringify(
    {
      status: "PASS",
      binding: "napi",
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
