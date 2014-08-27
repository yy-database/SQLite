// Test-only bridge: exposes the `sqlite.node` surface and `better-sqlite3`
// oracle to the Python suite. It is not a product entry point.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The binding is staged in `../sqlite.ts/platforms/<pkg>/lib` by
// `scripts/build-napi.mjs`. The bridge is test-only glue, so it reads that
// staged artefact directly instead of resolving an optional dependency that
// this Python project does not declare.
function platformKey() {
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  return null;
}

function nativePath() {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) return resolve(fromEnv);
  const key = platformKey();
  if (!key) throw new Error(`no SQLite native binding for ${process.platform}-${process.arch}`);
  const project = dirname(fileURLToPath(import.meta.url));
  const libDir = join(project, "..", "sqlite.ts", "platforms", `sqlite-node-${key}`, "lib");
  const fileName = existsSync(libDir)
    ? readdirSync(libDir).find((entry) => entry.endsWith(".node"))
    : undefined;
  if (!fileName) throw new Error(`missing .node binary in ${libDir}, run pnpm build:napi`);
  return join(libDir, fileName);
}

const native = require(nativePath());

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
