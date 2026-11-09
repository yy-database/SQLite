// Cross-library write/read between `@yydb/sqlite` and Node's built-in `node:sqlite`.
// Both directions close/reopen the same on-disk file between writer and reader.
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:node-sqlite`
//   or: `node --experimental-strip-types projects/sqlite.ts/examples/vs-js-libraries/tests/cross-read-write-node-sqlite.ts`

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createWriter, openDatabase } from "../../../packages/sqlite/src/index.ts";
import { PAGE_SIZE, ROWS, column, columns, expectedRows, verifyPointAndRange, workspace } from "../src/shared.ts";

function oursWritePeerRead(path: string): void {
  const rows = expectedRows();
  const writer = createWriter(PAGE_SIZE);
  writer.createTable("items", columns);
  for (const row of rows) {
    writer.insert("items", JSON.stringify([row.id, row.label, row.score]));
  }
  writer.save(path);

  const peer = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = peer.prepare("pragma integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`integrity_check failed: ${integrity.integrity_check}`);
    }
    const observed = peer.prepare("select id, label, score from items order by id").all() as Array<{
      id: number | bigint;
      label: string;
      score: number;
    }>;
    if (observed.length !== ROWS) throw new Error(`peer read ${observed.length} rows, expected ${ROWS}`);
    for (const row of rows) {
      const hit = observed[row.id - 1];
      if (Number(hit.id) !== row.id || hit.label !== row.label || hit.score !== row.score) {
        throw new Error(`ours→peer mismatch at id=${row.id}: ${JSON.stringify(hit)}`);
      }
    }
  } finally {
    peer.close();
  }
}

function peerWriteOursRead(path: string): void {
  const rows = expectedRows();
  const peer = new DatabaseSync(path);
  try {
    peer.exec(`pragma page_size = ${PAGE_SIZE}`);
    peer.exec("create table items (id integer primary key, label text, score real)");
    const insert = peer.prepare("insert into items (id, label, score) values (?, ?, ?)");
    for (const row of rows) insert.run(row.id, row.label, row.score);
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
  verifyPointAndRange(reader, rows);
}

const space = workspace("sqlite-vs-js-libraries-node-sqlite");
try {
  oursWritePeerRead(space.path);
  rmSync(space.path, { force: true });
  peerWriteOursRead(space.path);
  console.log(`ok cross-read-write node-sqlite: ${ROWS} rows both directions`);
} finally {
  space.dispose();
}
