// Cross-library write/read between `@yydb/sqlite` and `sql.js`.
// sql.js is memory-first: the shared store is a serialized main-file image on disk
// (`export()` / `readFileSync` + `new Database(bytes)`), closed between sides.
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:sql-js`
//   or: `node --experimental-strip-types projects/sqlite.ts/examples/vs-js-libraries/tests/cross-read-write-sql-js.ts`

import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { createWriter, openDatabase } from "../../../packages/sqlite/src/index.ts";
import { PAGE_SIZE, ROWS, column, columns, expectedRows, workspace } from "../src/shared.ts";
import { loadSqlJs, type SqlJsStatic } from "../src/sql-js.ts";

function oursWritePeerRead(SQL: SqlJsStatic, path: string): void {
  const rows = expectedRows();
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  for (const row of rows) {
    writer.insert("items", JSON.stringify([row.id, row.label, row.score]));
  }
  writer.save(path);

  const peer = new SQL.Database(readFileSync(path));
  try {
    const integrity = peer.exec("pragma integrity_check");
    const status = String(integrity[0]?.values[0]?.[0] ?? "");
    if (status !== "ok") throw new Error(`integrity_check failed: ${status}`);
    const observed = peer.exec("select id, label, score from items order by id");
    const values = observed[0]?.values ?? [];
    if (values.length !== ROWS) throw new Error(`peer read ${values.length} rows, expected ${ROWS}`);
    for (const row of rows) {
      const hit = values[row.id - 1];
      if (Number(hit[0]) !== row.id || hit[1] !== row.label || Number(hit[2]) !== row.score) {
        throw new Error(`ours→peer mismatch at id=${row.id}: ${JSON.stringify(hit)}`);
      }
    }
  } finally {
    peer.close();
  }
}

function peerWriteOursRead(SQL: SqlJsStatic, path: string): void {
  const rows = expectedRows();
  const peer = new SQL.Database();
  try {
    peer.run(`pragma page_size = ${PAGE_SIZE}`);
    peer.run("create table items (id integer primary key, label text, score real)");
    for (const row of rows) {
      peer.run("insert into items (id, label, score) values (?, ?, ?)", [row.id, row.label, row.score]);
    }
    writeFileSync(path, Buffer.from(peer.export()));
  } finally {
    peer.close();
  }

  const reader = openDatabase(path);
  const decoded = reader.table("items");
  if (decoded.length !== ROWS) throw new Error(`ours read ${decoded.length} rows, expected ${ROWS}`);
  for (const row of rows) {
    const hit = decoded[row.id - 1];
    const cells = hit.columns.map(column);
    if (Number(hit.rowid) !== row.id || cells[1] !== row.label || cells[2] !== row.score) {
      throw new Error(`peer→ours mismatch at id=${row.id}: rowid=${hit.rowid} cells=${JSON.stringify(cells)}`);
    }
  }
}

const space = workspace("sqlite-vs-js-libraries-sql-js");
try {
  const SQL = await loadSqlJs();
  oursWritePeerRead(SQL, space.path);
  rmSync(space.path, { force: true });
  peerWriteOursRead(SQL, space.path);
  console.log(`ok cross-read-write sql-js: ${ROWS} rows both directions (serialized main file)`);
} finally {
  space.dispose();
}
