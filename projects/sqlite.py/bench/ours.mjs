// Bench-only helper: runs the same workload against our writer/reader and
// prints timings measured inside Node, so the Python harness does not time
// JSON marshalling or process startup.
//
// Usage: node bench/ours.mjs <path> <rows> <rowsPerTxn> <pageSize> <pointOps>

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../../sqlite.rs/sqlite-napi/sqlite.node");

const [path, rowsText, txnText, pageText, pointText] = process.argv.slice(2);
const rows = Number(rowsText);
const perTxn = Number(txnText);
const pageSize = Number(pageText);
const pointOps = Number(pointText);

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
  { name: "payload", declaredType: "BLOB" },
]);

const payload = Buffer.alloc(48, 0x78).toString("hex");

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

const writer = native.SqliteWriter.create(pageSize);
writer.createTable("items", columns);
const loadStart = process.hrtime.bigint();
for (let row = 1; row <= rows; row += 1) {
  if ((row - 1) % perTxn === 0) writer.begin();
  writer.insert("items", JSON.stringify([row, `row-${row}`, row / 4, { $blob: payload }]));
  if (row % perTxn === 0) writer.commit();
}
writer.save(path);
const batchLoadMs = elapsedMs(loadStart);

const reader = native.SqliteDatabase.open(path);
const scanStart = process.hrtime.bigint();
const decoded = reader.table("items", { maxRows: rows });
const scanMs = elapsedMs(scanStart);
if (decoded.length !== rows) throw new Error(`${decoded.length} rows, expected ${rows}`);

const pointMs = [];
for (let index = 0; index < Math.min(pointOps, 100); index += 1) {
  const start = process.hrtime.bigint();
  const reopened = native.SqliteDatabase.open(path);
  reopened.table("items", { maxRows: rows });
  pointMs.push(elapsedMs(start));
}

const insertWriter = native.SqliteWriter.create(pageSize);
insertWriter.createTable("items", columns);
const singleMs = [];
for (let row = 1; row <= 200; row += 1) {
  const start = process.hrtime.bigint();
  insertWriter.insert("items", JSON.stringify([row, `row-${row}`, row / 4, { $blob: payload }]));
  singleMs.push(elapsedMs(start));
}

process.stdout.write(JSON.stringify({ batchLoadMs, scanMs, pointMs, singleMs }));
