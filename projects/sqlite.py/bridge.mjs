// Test-only bridge: exposes the `sqlite.node` surface and `better-sqlite3`
// oracle to the Python suite. It is not a product entry point.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const native = require("../sqlite.rs/sqlite-napi/sqlite.node");

function decodeValue(value) {
  switch (value.kind) {
    case "null":
      return { kind: "null", value: null };
    case "integer":
      return { kind: "integer", value: String(value.valueInteger) };
    case "real":
      return { kind: "real", value: value.valueReal };
    case "text":
      return { kind: "text", value: value.valueText };
    case "blob":
      return { kind: "blob", value: Buffer.from(value.valueBlob).toString("hex") };
    default:
      throw new Error(`unknown sqlite value kind ${value.kind}`);
  }
}

function build({ path, pageSize, steps }) {
  const writer = native.SqliteWriter.create(pageSize);
  const rowids = [];
  for (const step of steps) {
    switch (step.kind) {
      case "createTable":
        writer.createTable(step.name, JSON.stringify(step.columns));
        break;
      case "createIndex":
        writer.createIndex(step.name, step.table, step.columns, step.unique ?? false);
        break;
      case "insert":
        rowids.push(writer.insert(step.table, JSON.stringify(step.values)));
        break;
      case "update":
        writer.update(step.table, step.rowid, JSON.stringify(step.slots));
        break;
      case "delete":
        writer.delete(step.table, step.rowid);
        break;
      case "begin":
        writer.begin();
        break;
      case "commit":
        writer.commit();
        break;
      case "rollback":
        writer.rollback();
        break;
      default:
        throw new Error(`unknown writer step ${step.kind}`);
    }
  }
  writer.save(path);
  return { rowids };
}

function read({ path, table }) {
  const database = native.SqliteDatabase.open(path);
  return database.table(table).map((row) => ({
    rowid: String(row.rowid),
    columns: row.columns.map(decodeValue),
  }));
}

function schema({ path }) {
  return native.SqliteDatabase.open(path).schema();
}

function readWithoutRowid({ path, table }) {
  return native.SqliteDatabase.open(path)
    .tableWithoutRowid(table)
    .map((columns) => columns.map(decodeValue));
}

function readIndex({ path, index }) {
  return native.SqliteDatabase.open(path)
    .index(index)
    .map((row) => ({
      rowid: String(row.rowid),
      columns: row.columns.map(decodeValue),
    }));
}

function meta({ path }) {
  const database = native.SqliteDatabase.open(path);
  const pages = database.pages();
  const rawPageSize = pages.readUInt16BE(16);
  return {
    bytes: pages.length,
    pageSize: rawPageSize === 1 ? 65536 : rawPageSize,
    databasePages: pages.readUInt32BE(28),
    encoding: database.encoding(),
    textEncoding: pages.readUInt32BE(56),
  };
}

function oracle({ path, sql }) {
  const Database = require("../sqlite.ts/node_modules/better-sqlite3");
  const db = new Database(path);
  let rows;
  if (/^\s*pragma\s+/i.test(sql)) {
    rows = db.pragma(sql.replace(/^\s*pragma\s+/i, ""), { simple: true });
  } else {
    rows = db.prepare(sql).all();
  }
  db.close();
  return rows;
}

const [command, payload] = process.argv.slice(2);
const input = JSON.parse(payload ?? readFileSync(0, "utf8"));
const handlers = { build, read, readWithoutRowid, readIndex, schema, meta, oracle };
const handler = handlers[command];
if (!handler) {
  throw new Error(`unknown bridge command ${command}`);
}
process.stdout.write(JSON.stringify(handler(input)));
