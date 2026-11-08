// Side-by-side throughput with `node:sqlite` (`DatabaseSync`) as baseline.
// Console + report show relative uplift/gap vs baseline only (same measurements underneath).
// Timing style matches `packages/sqlite-harness/src/bench.ts` (hrtime, median).
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
// Env: BENCH_ROWS (default 5000), BENCH_TXN (1000), BENCH_PAGE (4096), BENCH_ROUNDS (3), BENCH_POINT (1000)

import Database from "better-sqlite3";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createEngine, createWriter, openDatabase } from "../../../packages/sqlite/src/index.ts";
import { workspace } from "../src/shared.ts";
import { loadSqlJs, type SqlJsStatic } from "../src/sql-js.ts";
import { elapsedMs, median } from "../src/timing.ts";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROWS = Number(process.env.BENCH_ROWS ?? 5_000);
const ROWS_PER_TXN = Number(process.env.BENCH_TXN ?? 1_000);
const PAGE_SIZE = Number(process.env.BENCH_PAGE ?? 4_096);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const POINT_OPS = Number(process.env.BENCH_POINT ?? 1_000);

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
]);

function thrptPerSec(ops: number, ms: number): number {
  if (ms <= 0) return 0;
  return (ops / ms) * 1_000;
}

function formatThrpt(perSec: number): string {
  if (perSec <= 0) return "n/a";
  return `${Math.round(perSec).toLocaleString("en-US")}/s`;
}

/** Time ratio vs baseline (`candidate_time / baseline_time`). Faster => `<1`, slower => `>1`. */
function timeRatioVsBaseline(candidatePerSec: number, baselinePerSec: number): number {
  if (baselinePerSec <= 0 || candidatePerSec <= 0) return Number.NaN;
  return baselinePerSec / candidatePerSec;
}

function formatRatio(timeRatio: number): string {
  if (!Number.isFinite(timeRatio)) return "n/a";
  if (Math.abs(timeRatio - 1) < 0.005) return "1.00x";
  return `${timeRatio.toFixed(2)}x`;
}

function ourBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const start = process.hrtime.bigint();
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) writer.begin();
    writer.insert("items", JSON.stringify([row, `row-${row}`, row / 4]));
    if (row % ROWS_PER_TXN === 0) writer.commit();
  }
  writer.save(path);
  return elapsedMs(start);
}

function ourScan(path: string): number[] {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const reader = openDatabase(path);
    const rows = reader.table("items", { maxRows: ROWS });
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  return samples;
}

function ourPoint(): number[] {
  const engine = createEngine(PAGE_SIZE);
  engine.execute("create table items (id integer primary key, label text, score real)");
  for (let row = 1; row <= ROWS; row += 1) {
    engine.execute(`insert into items (id, label, score) values (${row}, 'row-${row}', ${row / 4})`);
  }
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const result = engine.execute(`select id, label, score from items where id = ${id}`);
      if (result.rows.length !== 1) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  return samples;
}

function betterSqlite3BatchLoad(path: string): number {
  rmSync(path, { force: true });
  const database = new Database(path);
  database.pragma(`page_size = ${PAGE_SIZE}`);
  database.pragma("synchronous = off");
  database.pragma("journal_mode = memory");
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.exec("begin");
    insert.run(row, `row-${row}`, row / 4);
    if (row % ROWS_PER_TXN === 0) database.exec("commit");
  }
  const total = elapsedMs(start);
  database.close();
  return total;
}

function betterSqlite3Scan(path: string): number[] {
  const database = new Database(path, { readonly: true });
  const samples: number[] = [];
  const select = database.prepare("select id, label, score from items");
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const rows = select.all();
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function betterSqlite3Point(path: string): number[] {
  const database = new Database(path, { readonly: true });
  const select = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const row = select.get(id);
      if (row === undefined) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nodeSqliteBatchLoad(path: string): number {
  rmSync(path, { force: true });
  const database = new DatabaseSync(path);
  database.exec(`pragma page_size = ${PAGE_SIZE}`);
  database.exec("pragma synchronous = off");
  database.exec("pragma journal_mode = memory");
  database.exec("create table items (id integer primary key, label text, score real)");
  const insert = database.prepare("insert into items (id, label, score) values (?, ?, ?)");
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.exec("begin");
    insert.run(row, `row-${row}`, row / 4);
    if (row % ROWS_PER_TXN === 0) database.exec("commit");
  }
  const total = elapsedMs(start);
  database.close();
  return total;
}

function nodeSqliteScan(path: string): number[] {
  const database = new DatabaseSync(path, { readOnly: true });
  const samples: number[] = [];
  const select = database.prepare("select id, label, score from items");
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const rows = select.all();
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function nodeSqlitePoint(path: string): number[] {
  const database = new DatabaseSync(path, { readOnly: true });
  const select = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      const row = select.get(id);
      if (row === undefined) throw new Error(`point miss id=${id}`);
    }
    samples.push(elapsedMs(start));
  }
  database.close();
  return samples;
}

function sqlJsBatchLoad(SQL: SqlJsStatic, path: string): number {
  rmSync(path, { force: true });
  const database = new SQL.Database();
  database.run(`pragma page_size = ${PAGE_SIZE}`);
  database.run("create table items (id integer primary key, label text, score real)");
  const start = process.hrtime.bigint();
  for (let row = 1; row <= ROWS; row += 1) {
    if ((row - 1) % ROWS_PER_TXN === 0) database.run("begin");
    database.run("insert into items (id, label, score) values (?, ?, ?)", [row, `row-${row}`, row / 4]);
    if (row % ROWS_PER_TXN === 0) database.run("commit");
  }
  writeFileSync(path, Buffer.from(database.export()));
  const total = elapsedMs(start);
  database.close();
  return total;
}

function sqlJsScan(SQL: SqlJsStatic, path: string): number[] {
  const bytes = readFileSync(path);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    const database = new SQL.Database(bytes);
    const rows = database.exec("select id, label, score from items")[0]?.values ?? [];
    if (rows.length !== ROWS) throw new Error(`${rows.length} rows, expected ${ROWS}`);
    database.close();
    samples.push(elapsedMs(start));
  }
  return samples;
}

function sqlJsPoint(SQL: SqlJsStatic, path: string): number[] {
  const database = new SQL.Database(readFileSync(path));
  const statement = database.prepare("select id, label, score from items where id = ?");
  const ids = Array.from({ length: POINT_OPS }, (_, index) => (index % ROWS) + 1);
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = process.hrtime.bigint();
    for (const id of ids) {
      statement.bind([id]);
      if (!statement.step()) throw new Error(`point miss id=${id}`);
      statement.getAsObject();
      statement.reset();
    }
    samples.push(elapsedMs(start));
  }
  statement.free();
  database.close();
  return samples;
}

type WorkloadRates = {
  batch: number;
  scan: number;
  point: number;
};

type LibraryRates = {
  name: string;
  rates: WorkloadRates;
};

function ratesFromSamples(batch: number[], scan: number[], point: number[]): WorkloadRates {
  return {
    batch: thrptPerSec(ROWS, median(batch)),
    scan: thrptPerSec(ROWS, median(scan)),
    point: thrptPerSec(POINT_OPS, median(point)),
  };
}

function rowRatios(libraries: LibraryRates[], baseline: WorkloadRates, workload: keyof WorkloadRates): number[] {
  return libraries.map((library) => timeRatioVsBaseline(library.rates[workload], baseline[workload]));
}

function printRelativeTable(libraries: LibraryRates[], baseline: WorkloadRates): void {
  const names = libraries.map((library) => library.name);
  const plainCells = (["batch", "scan", "point"] as const).flatMap((workload) =>
    rowRatios(libraries, baseline, workload).map((ratio) => formatRatio(ratio)),
  );
  const colWidth = Math.max(12, ...names.map((name) => name.length), ...plainCells.map((cell) => cell.length + 2));
  const workloadWidth = 8;

  const header = ["Workload".padEnd(workloadWidth), ...names.map((name) => name.padStart(colWidth))].join("  ");
  console.log("vs-js-libraries — relative to `node:sqlite` baseline (time ratio; * = fastest)");
  console.log(
    `Defaults: BENCH_ROWS=${ROWS}, BENCH_TXN=${ROWS_PER_TXN}, BENCH_PAGE=${PAGE_SIZE}, BENCH_ROUNDS=${ROUNDS}, BENCH_POINT=${POINT_OPS}`,
  );
  console.log(header);
  for (const workload of ["batch", "scan", "point"] as const) {
    const ratios = rowRatios(libraries, baseline, workload);
    const best = Math.min(...ratios.filter((ratio) => Number.isFinite(ratio)));
    console.log(
      [
        workload.padEnd(workloadWidth),
        ...ratios.map((ratio) => {
          const text = formatRatio(ratio);
          const marked = Math.abs(ratio - best) < 1e-9 ? `*${text}*` : text;
          return marked.padStart(colWidth);
        }),
      ].join("  "),
    );
  }
  console.log("");
}

function markdownRelativeTable(libraries: LibraryRates[], baseline: WorkloadRates): string {
  const names = libraries.map((library) => library.name);
  const lines = [
    `| Workload | ${names.join(" | ")} |`,
    `|---------:|${names.map(() => "-------:").join("|")}|`,
  ];
  for (const workload of ["batch", "scan", "point"] as const) {
    const ratios = rowRatios(libraries, baseline, workload);
    const best = Math.min(...ratios.filter((ratio) => Number.isFinite(ratio)));
    const cells = ratios.map((ratio) => {
      const text = formatRatio(ratio);
      return Math.abs(ratio - best) < 1e-9 ? `**${text}**` : text;
    });
    lines.push(`| ${workload} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

const oursSpace = workspace("sqlite-vs-js-libraries-ours");
const betterSpace = workspace("sqlite-vs-js-libraries-better-sqlite3");
const nodeSpace = workspace("sqlite-vs-js-libraries-node-sqlite");
const sqlJsSpace = workspace("sqlite-vs-js-libraries-sql-js");

try {
  const SQL = await loadSqlJs();

  const nodeBatch = [
    nodeSqliteBatchLoad(nodeSpace.path),
    nodeSqliteBatchLoad(nodeSpace.path),
    nodeSqliteBatchLoad(nodeSpace.path),
  ];
  const nodeScan = nodeSqliteScan(nodeSpace.path);
  const nodePoint = nodeSqlitePoint(nodeSpace.path);
  const baselineRates = ratesFromSamples(nodeBatch, nodeScan, nodePoint);

  const oursBatch = [ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path), ourBatchLoad(oursSpace.path)];
  const oursScan = ourScan(oursSpace.path);
  const oursPoint = ourPoint();

  const betterBatch = [
    betterSqlite3BatchLoad(betterSpace.path),
    betterSqlite3BatchLoad(betterSpace.path),
    betterSqlite3BatchLoad(betterSpace.path),
  ];
  const betterScan = betterSqlite3Scan(betterSpace.path);
  const betterPoint = betterSqlite3Point(betterSpace.path);

  const sqlJsBatch = [
    sqlJsBatchLoad(SQL, sqlJsSpace.path),
    sqlJsBatchLoad(SQL, sqlJsSpace.path),
    sqlJsBatchLoad(SQL, sqlJsSpace.path),
  ];
  const sqlJsScanSamples = sqlJsScan(SQL, sqlJsSpace.path);
  const sqlJsPointSamples = sqlJsPoint(SQL, sqlJsSpace.path);

  const libraries: LibraryRates[] = [
    { name: "node:sqlite", rates: baselineRates },
    { name: "@yydb/sqlite", rates: ratesFromSamples(oursBatch, oursScan, oursPoint) },
    { name: "better-sqlite3", rates: ratesFromSamples(betterBatch, betterScan, betterPoint) },
    { name: "sql.js", rates: ratesFromSamples(sqlJsBatch, sqlJsScanSamples, sqlJsPointSamples) },
  ];
  printRelativeTable(libraries, baselineRates);

  const report = `# Benchmark report

Command: \`pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark\`
Defaults: \`BENCH_ROWS=${ROWS}\`, \`BENCH_TXN=${ROWS_PER_TXN}\`, \`BENCH_PAGE=${PAGE_SIZE}\`, \`BENCH_ROUNDS=${ROUNDS}\`, \`BENCH_POINT=${POINT_OPS}\`
Baseline: \`node:sqlite\` (\`DatabaseSync\`) = \`1.00x\`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Relative to \`node:sqlite\`

${markdownRelativeTable(libraries, baselineRates)}

## Intentional deltas

- Format-3 reader has no point API; point select benches \`createEngine\` SQL against each peer's prepared get / step.
- Our writer has no \`synchronous\` switch; better-sqlite3 / node:sqlite batch load use \`synchronous=off\` and \`journal_mode=memory\`.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch timing includes \`export()\`.

Regenerate: \`pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark\`
`;
  writeFileSync(join(exampleRoot, "reports", "benchmark.md"), report, "utf8");

  console.log(
    "Notes: baseline is node:sqlite (DatabaseSync). Batch/scan use format-3 writer/reader for @yydb/sqlite vs peer file I/O. Point select uses createEngine SQL on our side (reader has no point API). better-sqlite3 / node:sqlite batch use synchronous=off journal_mode=memory. sql.js peer batch includes export(); peer scan reloads bytes each round.",
  );
} finally {
  oursSpace.dispose();
  betterSpace.dispose();
  nodeSpace.dispose();
  sqlJsSpace.dispose();
}
