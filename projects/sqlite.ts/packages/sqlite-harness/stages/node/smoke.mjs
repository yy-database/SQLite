import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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

function assertSql(condition, message) {
  counts.sql += 1;
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

// SQL layer: the same orthogonal primitives the WebAssembly and PyO3 hosts
// expose, executed against the Node-API binding.
const engine = binding.SqliteEngine.create(4096);
const created = engine.execute("create table people (id integer primary key, name text not null, score real)");
assertSql(created.statement === "create-table" && created.affected === 1, "engine reports create-table");
const inserted = engine.execute("insert into people (name, score) values ('ada', 9.5)");
assertSql(inserted.statement === "insert" && inserted.affected === 1, "engine reports insert");
assertSql(inserted.columns[0] === "rowid" && inserted.rows[0][0] === 1, "engine returns the assigned rowid");
const selected = engine.execute("select * from people");
assertSql(selected.columns.join(",") === "id,name,score", "engine returns the column labels");
assertSql(selected.rows.length === 1 && selected.rows[0][1] === "ada", "engine returns the rows");
const batch = engine.executeBatch(["insert into people (name) values ('bob')", "select count(*) from people"]);
assertSql(batch.length === 2 && batch[1].rows[0][0] === 2, "engine batch runs the list in order");
const filtered = engine.execute("select name from people where score >= 9.0 order by score desc");
assertSql(filtered.rows.length === 1 && filtered.rows[0][0] === "ada", "engine filters and orders rows");
const nulls = engine.execute("select count(*) from people where score is null");
assertSql(nulls.rows[0][0] === 1, "engine counts null predicates");
const rightJoin = engine.tryExecute("select * from people right join people as other on people.id = other.id");
assertSql(
  rightJoin.ok === true && rightJoin.result.rows.length === 2 && rightJoin.result.rows[0][0] === 1,
  "engine executes a right join",
);
const rejected = engine.tryExecute("select * from people for update");
assertSql(rejected.ok === false && rejected.error.code === "unsupported-clause", "engine rejects an unsupported clause");
assertSql(
  rejected.error.statement === "select" && rejected.error.clause === "UPDATE" && rejected.error.position === 25,
  "engine rejection carries statement, clause and offset",
);
assertSql(engine.ping() > 0, "engine header ping");

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
  const engine = binding.SqliteEngine.create(4096);
  engine.execute("create table nums (id integer primary key, label text, score real)");
  engine.executeBatch([
    "insert into nums (label, score) values ('a', 1.5)",
    "insert into nums (label, score) values ('b', null)",
    "insert into nums (label, score) values (null, 2.5)",
    "insert into nums (label, score) values ('d', null)",
  ]);

  for (const predicate of COMPARISONS) {
    const rows = engine.execute(`select id from nums where ${predicate}`).rows;
    assertSql(rows.length === 0, `three-valued-logic: \`where ${predicate}\` treated SQL NULL as TRUE and returned ${JSON.stringify(rows)}`);
  }

  const total = engine.execute("select count(*) from nums").rows[0][0];
  const nullScores = engine.execute("select count(*) from nums where score is null").rows[0][0];
  const notNullScores = engine.execute("select count(*) from nums where score is not null").rows[0][0];
  assertSql(total - nullScores === 2, `three-valued-logic: count(*) minus the NULL scores must be 2, got ${total - nullScores}`);
  assertSql(nullScores + notNullScores === total, `three-valued-logic: IS NULL plus IS NOT NULL must cover ${total} rows, got ${nullScores + notNullScores}`);

  const ascending = engine.execute("select id, score from nums order by score asc").rows;
  const descending = engine.execute("select id, score from nums order by score desc").rows;
  assertSql(ascending[0][1] === null, `three-valued-logic: ascending order must start with a NULL score, got ${JSON.stringify(ascending)}`);
  assertSql(descending[descending.length - 1][1] === null, `three-valued-logic: descending order must end with a NULL score, got ${JSON.stringify(descending)}`);
}

const enginePath = resolve(outDir, "engine.sqlite3");
writeFileSync(enginePath, engine.snapshot());
const engineCheck = spawnSync("python", [resolve(stagesDir, "verify_sqlite.py"), enginePath, "people", "id,name,score"], {
  encoding: "utf8",
});
if (engineCheck.status !== 0) {
  throw new Error(`python verification failed:\n${engineCheck.stdout}\n${engineCheck.stderr}`);
}
const engineReport = JSON.parse(engineCheck.stdout);
assertSql(
  engineReport.integrity_check === "ok" && engineReport.count === 2,
  "external sqlite3 reads the SQL-written rows",
);

checkThreeValuedLogic();

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
