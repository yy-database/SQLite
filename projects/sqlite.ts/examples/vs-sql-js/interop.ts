// Cross-library write/read between `@yydb/sqlite` and `sql.js`.
// sql.js is memory-first: the shared store is a serialized main-file image on disk
// (`export()` / `readFileSync` + `new Database(bytes)`), closed between sides.
//
// Run: `pnpm --dir projects/sqlite.ts/examples/vs-sql-js test`
//   or: `node --experimental-strip-types projects/sqlite.ts/examples/vs-sql-js/interop.ts`

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWriter, openDatabase, type RecordValue } from "../../packages/sqlite/src/index.ts";

const PAGE_SIZE = 4096;
const ROWS = 64;

const columns = JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT" },
  { name: "score", declaredType: "REAL" },
]);

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
};

type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
};

const requireFromHarness = createRequire(
  join(fileURLToPath(new URL("../../packages/sqlite-harness/package.json", import.meta.url))),
);

async function loadSqlJs(): Promise<SqlJsStatic> {
  const entry = requireFromHarness.resolve("sql.js");
  const factory = requireFromHarness("sql.js") as (options: {
    locateFile(file: string): string;
  }) => Promise<SqlJsStatic>;
  return factory({ locateFile: (file) => join(dirname(entry), file) });
}

function column(value: RecordValue): unknown {
  switch (value.kind) {
    case "null":
      return null;
    case "integer":
      return Number(value.valueInteger);
    case "real":
      return value.valueReal;
    case "text":
      return value.valueText;
    case "blob":
      return Buffer.from(value.valueBlob ?? []);
    default:
      throw new Error(`unknown column kind ${(value as RecordValue).kind}`);
  }
}

function expectedRows() {
  return Array.from({ length: ROWS }, (_, index) => ({
    id: index + 1,
    label: `row-${index + 1}`,
    score: (index + 1) / 4,
  }));
}

function workspace(): { path: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-vs-sql-js-"));
  return {
    path: join(root, "main.sqlite3"),
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // disposable
      }
    },
  };
}

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

const space = workspace();
try {
  const SQL = await loadSqlJs();
  oursWritePeerRead(SQL, space.path);
  rmSync(space.path, { force: true });
  peerWriteOursRead(SQL, space.path);
  console.log(`ok vs-sql-js interop: ${ROWS} rows both directions (serialized main file)`);
} finally {
  space.dispose();
}
