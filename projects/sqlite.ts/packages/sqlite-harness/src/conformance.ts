// `conformance` subcommand: parse the bytes of externally produced `.sqlite3`
// fixtures with an independent reader and compare every derived fact with
// what an external engine reports. The expected side is always
// `better-sqlite3` (a real SQLite build), never this repository's decoder.
//
// Covered: the 100-byte file header, page 1 b-tree header, serial-type
// encoding of a record, the overflow chain, the 65536 page-size encoding and
// the WAL header/frame layout.

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256, fixturePath } from "./fixtures.ts";
import { emit, repoPath, renderTable, type CliOptions } from "./util.ts";

const require = createRequire(repoPath("projects", "sqlite.ts", "packages", "sqlite", "package.json"));
const BetterSqlite = require("better-sqlite3") as new (path: string, options?: Record<string, unknown>) => {
  prepare(source: string): { all(...args: unknown[]): Record<string, unknown>[] };
  close(): void;
};

const FIXTURES = repoPath("projects", "sqlite.ts", "packages", "sqlite-fixtures", "fixtures");

export interface FileHeader {
  readonly magic: string;
  readonly pageSize: number;
  readonly writeVersion: number;
  readonly readVersion: number;
  readonly reservedSpace: number;
  readonly maxPayloadFraction: number;
  readonly minPayloadFraction: number;
  readonly leafPayloadFraction: number;
  readonly changeCounter: number;
  readonly pageCount: number;
  readonly freelistTrunk: number;
  readonly freelistPages: number;
  readonly schemaCookie: number;
  readonly schemaFormat: number;
  readonly textEncoding: number;
  readonly versionValidFor: number;
  readonly sqliteVersion: number;
}

const u8 = (bytes: Uint8Array, offset: number): number => bytes[offset];
const u16 = (bytes: Uint8Array, offset: number): number => (bytes[offset] << 8) | bytes[offset + 1];
const u32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

export function readHeader(bytes: Uint8Array): FileHeader {
  const magic = Buffer.from(bytes.subarray(0, 16)).toString("latin1");
  if (magic !== "SQLite format 3\u0000") throw new Error(`not a SQLite 3 file: ${JSON.stringify(magic)}`);
  const rawPageSize = u16(bytes, 16);
  return {
    magic: magic.replace("\u0000", "\\0"),
    pageSize: rawPageSize === 1 ? 65536 : rawPageSize,
    writeVersion: u8(bytes, 18),
    readVersion: u8(bytes, 19),
    reservedSpace: u8(bytes, 20),
    maxPayloadFraction: u8(bytes, 21),
    minPayloadFraction: u8(bytes, 22),
    leafPayloadFraction: u8(bytes, 23),
    changeCounter: u32(bytes, 24),
    pageCount: u32(bytes, 28),
    freelistTrunk: u32(bytes, 32),
    freelistPages: u32(bytes, 36),
    schemaCookie: u32(bytes, 40),
    schemaFormat: u32(bytes, 44),
    textEncoding: u32(bytes, 56),
    versionValidFor: u32(bytes, 88),
    sqliteVersion: u32(bytes, 92),
  };
}

export function varint(bytes: Uint8Array, offset: number): { value: number; bytes: number } {
  let value = 0;
  for (let index = 0; index < 9; index += 1) {
    const byte = bytes[offset + index];
    if (index === 8) return { value: value * 256 + byte, bytes: 9 };
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, bytes: index + 1 };
  }
  throw new Error("varint is longer than nine bytes");
}

const ENCODING_NAMES: Record<number, string> = { 1: "UTF-8", 2: "UTF-16le", 3: "UTF-16be" };

export class PageReader {
  readonly bytes: Uint8Array;
  readonly header: FileHeader;
  readonly usable: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.header = readHeader(bytes);
    this.usable = this.header.pageSize - this.header.reservedSpace;
    if (bytes.length < this.header.pageSize) throw new Error("file is shorter than one page");
  }

  pageStart(pageNumber: number): number {
    return (pageNumber - 1) * this.header.pageSize;
  }

  btree(pageNumber: number): {
    type: number;
    firstFreeblock: number;
    cellCount: number;
    contentStart: number;
    fragmented: number;
    headerSize: number;
    rightMost: number;
  } {
    const start = this.pageStart(pageNumber) + (pageNumber === 1 ? 100 : 0);
    const type = this.bytes[start];
    const cellCount = u16(this.bytes, start + 3);
    const rawContent = u16(this.bytes, start + 5);
    const contentStart = rawContent === 0 ? 65536 : rawContent;
    const interior = type === 2 || type === 5;
    return {
      type,
      firstFreeblock: u16(this.bytes, start + 1),
      cellCount,
      contentStart,
      fragmented: this.bytes[start + 7],
      headerSize: interior ? 12 : 8,
      rightMost: interior ? u32(this.bytes, start + 8) : 0,
    };
  }

  cellPointers(pageNumber: number): number[] {
    const page = this.btree(pageNumber);
    const start = this.pageStart(pageNumber) + (pageNumber === 1 ? 100 : 0) + page.headerSize;
    return Array.from({ length: page.cellCount }, (_, index) => u16(this.bytes, start + index * 2));
  }

  maxLocal(): number {
    return this.usable - 35;
  }

  minLocal(): number {
    return Math.floor(((this.usable - 12) * 32) / 255) - 23;
  }

  localPayloadSize(payloadSize: number): number {
    const maxLocal = this.maxLocal();
    if (payloadSize <= maxLocal) return payloadSize;
    const minLocal = this.minLocal();
    const local = minLocal + ((payloadSize - minLocal) % (this.usable - 4));
    return local > maxLocal ? minLocal : local;
  }

  /** Decode a table-leaf cell: payload size, rowid and the bytes after the local part. */
  leafCell(pageNumber: number, cellOffset: number): { rowid: number; payload: Uint8Array; overflowPage: number } {
    const start = this.pageStart(pageNumber) + cellOffset;
    const size = varint(this.bytes, start);
    const rowid = varint(this.bytes, start + size.bytes);
    const payloadSize = size.value;
    const headerBytes = size.bytes + rowid.bytes;
    const local = this.localPayloadSize(payloadSize);
    const end = start + headerBytes + local;
    const payload = this.bytes.subarray(start + headerBytes, end);
    const overflowPage = payloadSize > this.maxLocal() ? u32(this.bytes, end) : 0;
    return { rowid: rowid.value, payload, overflowPage };
  }

  /** Follow the overflow chain and return the complete payload. */
  payload(pageNumber: number, cellOffset: number): Uint8Array {
    const cell = this.leafCell(pageNumber, cellOffset);
    const size = varint(this.bytes, this.pageStart(pageNumber) + cellOffset).value;
    if (size <= this.maxLocal()) return cell.payload;
    const chunks: Uint8Array[] = [cell.payload];
    let next = cell.overflowPage;
    let visited = 0;
    while (next !== 0) {
      if (next < 2 || next > this.header.pageCount) throw new Error(`overflow page ${next} is out of range`);
      visited += 1;
      if (visited > this.header.pageCount) throw new Error("overflow chain loops");
      const start = this.pageStart(next);
      const take = Math.min(this.usable - 4, size - chunks.reduce((total, chunk) => total + chunk.length, 0));
      chunks.push(this.bytes.subarray(start + 4, start + 4 + take));
      next = u32(this.bytes, start);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  /** Overflow pages visited by a payload, in chain order. */
  overflowPages(pageNumber: number, cellOffset: number): number[] {
    const size = varint(this.bytes, this.pageStart(pageNumber) + cellOffset).value;
    const pages: number[] = [];
    if (size <= this.maxLocal()) return pages;
    let next = this.leafCell(pageNumber, cellOffset).overflowPage;
    while (next !== 0) {
      pages.push(next);
      next = u32(this.bytes, this.pageStart(next));
    }
    return pages;
  }
}

export interface DecodedRecord {
  readonly serialTypes: number[];
  readonly values: Array<number | string | Buffer | null>;
  readonly text: string;
}

export function decodeRecord(payload: Uint8Array, encoding: number): DecodedRecord {
  const size = varint(payload, 0);
  const serialTypes: number[] = [];
  let offset = size.bytes;
  while (offset < size.value) {
    serialTypes.push(varint(payload, offset).value);
    offset = offset + varint(payload, offset).bytes;
  }
  const values: Array<number | string | Buffer | null> = [];
  for (const serial of serialTypes) {
    switch (serial) {
      case 0:
        values.push(null);
        break;
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 8:
      case 9: {
        const widths: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 };
        if (serial === 8) {
          values.push(0);
          break;
        }
        if (serial === 9) {
          values.push(1);
          break;
        }
        const width = widths[serial];
        let value = payload[offset];
        if (payload[offset] & 0x80) value = -1;
        for (let index = 1; index < width; index += 1) value = value * 256 + payload[offset + index];
        values.push(value);
        offset += width;
        break;
      }
      case 7: {
        const view = new DataView(payload.buffer, payload.byteOffset + offset, 8);
        values.push(view.getFloat64(0, false));
        offset += 8;
        break;
      }
      case 10:
      case 11:
        throw new Error(`reserved serial type ${serial}`);
      default: {
        const length = (serial - 12) / 2;
        if (serial % 2 === 0) {
          values.push(Buffer.from(payload.subarray(offset, offset + length)));
        } else if (encoding === 2) {
          values.push(new TextDecoder("utf-16le").decode(payload.subarray(offset, offset + length)));
        } else if (encoding === 3) {
          values.push(new TextDecoder("utf-16be").decode(payload.subarray(offset, offset + length)));
        } else {
          values.push(new TextDecoder("utf-8").decode(payload.subarray(offset, offset + length)));
        }
        offset += length;
        break;
      }
    }
  }
  const text = values.filter((value): value is string => typeof value === "string").join(" | ");
  return { serialTypes, values, text };
}

function engineFacts(path: string, sql: string, params: unknown[] = []): Record<string, unknown> {
  const database = new BetterSqlite(path);
  try {
    return database.prepare(sql).all(...params)[0] ?? {};
  } finally {
    database.close();
  }
}

function engineRows(path: string, sql: string): Record<string, unknown>[] {
  const database = new BetterSqlite(path);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

// Opening a WAL database checkpoints it and deletes `-wal`, so the fixture is
// copied to a scratch directory before an engine touches it.
function withWalCopy<T>(read: (path: string) => T): T {
  const source = fixturePath(FIXTURES, "wal-uncheckpointed.sqlite");
  const root = mkdtempSync(join(tmpdir(), "sqlite-conformance-wal-"));
  const copy = join(root, "copy.sqlite");
  try {
    copyFileSync(source, copy);
    copyFileSync(`${source}-wal`, `${copy}-wal`);
    return read(copy);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may hold the checkpointed file briefly only in rare cases.
    }
  }
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function compare(name: string, expected: unknown, actual: unknown): Check {
  const ok = String(expected) === String(actual);
  return { name, ok, detail: `external ${JSON.stringify(expected)} vs bytes ${JSON.stringify(actual)}` };
}

function headerChecks(name: string, header: FileHeader, path: string): Check[] {
  const facts = engineFacts(
    path,
    "select (select page_size from pragma_page_size) as pageSize, (select encoding from pragma_encoding) as encoding, (select page_count from pragma_page_count) as pageCount, (select freelist_count from pragma_freelist_count) as freelistPages",
  );
  return [
    compare(`${name}: page size`, facts.pageSize, header.pageSize),
    compare(`${name}: text encoding`, facts.encoding, ENCODING_NAMES[header.textEncoding]),
    compare(`${name}: page count`, facts.pageCount, header.pageCount),
    compare(`${name}: freelist pages`, facts.freelistPages, header.freelistPages),
    {
      name: `${name}: header constants`,
      ok:
        header.maxPayloadFraction === 64 &&
        header.minPayloadFraction === 32 &&
        header.leafPayloadFraction === 32 &&
        header.writeVersion >= 1 &&
        header.writeVersion <= 2 &&
        header.readVersion >= 1 &&
        header.readVersion <= 2,
      detail: `payload fractions ${header.maxPayloadFraction}/${header.minPayloadFraction}/${header.leafPayloadFraction}, versions ${header.writeVersion}/${header.readVersion}`,
    },
    {
      name: `${name}: sqlite version stamp`,
      ok: header.sqliteVersion > 0,
      detail: `version stamp ${header.sqliteVersion}, change counter ${header.changeCounter}, version-valid-for ${header.versionValidFor}`,
    },
  ];
}

function runChecks(): { checks: Check[]; fixtures: Array<{ name: string; bytes: number; sha256: string }> } {
  const checks: Check[] = [];
  const fixtures: Array<{ name: string; bytes: number; sha256: string }> = [];
  const names = [
    "blank.sqlite",
    "utf16le.sqlite",
    "utf16be.sqlite",
    "overflow.sqlite",
    "wide-pages.sqlite",
    "wal-uncheckpointed.sqlite",
    "corrupt-bitflip.sqlite",
    "corrupt-truncated.sqlite",
    "corrupt-header.sqlite",
  ];

  for (const name of names) {
    const path = fixturePath(FIXTURES, name);
    const bytes = readFileSync(path);
    fixtures.push({ name, bytes: bytes.length, sha256: sha256(path) });
  }

  // Header layout for every fixture whose header is intact.
  for (const name of ["blank.sqlite", "utf16le.sqlite", "utf16be.sqlite", "overflow.sqlite", "wide-pages.sqlite"]) {
    const path = fixturePath(FIXTURES, name);
    const header = readHeader(readFileSync(path));
    checks.push(...headerChecks(name, header, path));
  }

  const wide = readHeader(readFileSync(fixturePath(FIXTURES, "wide-pages.sqlite")));
  checks.push({
    name: "65536 page size uses the raw value 1",
    ok: readFileSync(fixturePath(FIXTURES, "wide-pages.sqlite"))[16] === 0 && readFileSync(fixturePath(FIXTURES, "wide-pages.sqlite"))[17] === 1,
    detail: `raw ${readFileSync(fixturePath(FIXTURES, "wide-pages.sqlite"))[16] << 8 | readFileSync(fixturePath(FIXTURES, "wide-pages.sqlite"))[17]} decodes to ${wide.pageSize}`,
  });

  // Page 1 b-tree header and the record/serial-type encoding. The `payloads`
  // table root is not page 1 (page 1 holds `sqlite_master`), so the root page
  // comes from the external engine's schema row.
  const overflowPath = fixturePath(FIXTURES, "overflow.sqlite");
  const page1 = new PageReader(readFileSync(overflowPath));
  const root = page1.btree(1);
  const rowCount = engineFacts(overflowPath, "select count(*) as n from payloads").n;
  checks.push({
    name: "page 1 is a table-leaf b-tree page",
    ok: root.type === 13,
    detail: `page type ${root.type}, ${root.cellCount} cells (sqlite_master), content starts at ${root.contentStart}`,
  });
  checks.push(compare("page 1 cell count matches the schema row count", engineFacts(overflowPath, "select count(*) as n from sqlite_master").n, root.cellCount));
  checks.push({
    name: "page 1 cell content stays inside the page",
    ok: root.contentStart >= root.headerSize + root.cellCount * 2 + (100) && root.contentStart <= page1.usable,
    detail: `content start ${root.contentStart}, usable ${page1.usable}`,
  });

  const rootPage = Number(engineFacts(overflowPath, "select rootpage as page from sqlite_master where name = 'payloads'").page);
  const table = page1.btree(rootPage);
  checks.push({
    name: "payloads root page is a table-leaf b-tree page",
    ok: table.type === 13 && table.cellCount === Number(rowCount),
    detail: `root page ${rootPage}, type ${table.type}, ${table.cellCount} cells`,
  });
  const cell = page1.cellPointers(rootPage)[0];
  const leaf = page1.leafCell(rootPage, cell);
  const record = decodeRecord(page1.payload(rootPage, cell), page1.header.textEncoding);
  const engineRow = engineRows(overflowPath, "select id, body from payloads")[0];
  checks.push({
    name: "record serial types decode the same values as the engine",
    ok:
      record.serialTypes[0] === 0 &&
      record.values[0] === null &&
      leaf.rowid === Number(engineRow.id) &&
      typeof record.values[1] === "string" &&
      (record.values[1] as string) === String(engineRow.body),
    detail: `serial types ${record.serialTypes.join(",")} (integer primary key stored as NULL, rowid ${leaf.rowid}), text length ${(record.values[1] as string).length}, engine length ${String(engineRow.body).length}`,
  });
  checks.push({
    name: "text serial type encodes the payload length",
    ok: record.serialTypes[1] === 13 + 2 * Buffer.byteLength(String(engineRow.body), "utf8"),
    detail: `serial ${record.serialTypes[1]} for ${Buffer.byteLength(String(engineRow.body), "utf8")} bytes`,
  });

  const payloadSize = varint(page1.bytes, page1.pageStart(rootPage) + cell).value;
  const overflowPages = page1.overflowPages(rootPage, cell);
  const expectedOverflow = Math.ceil((payloadSize - page1.localPayloadSize(payloadSize)) / (page1.usable - 4));
  checks.push({
    name: "overflow chain length and terminator",
    ok:
      overflowPages.length === expectedOverflow &&
      overflowPages[overflowPages.length - 1] !== undefined &&
      u32(page1.bytes, page1.pageStart(overflowPages[overflowPages.length - 1])) === 0,
    detail: `${overflowPages.length} overflow pages ${overflowPages.join("->")} for a ${payloadSize}-byte payload, last next pointer 0`,
  });

  // WAL header and frames, plus engine recovery of uncheckpointed rows.
  const walPath = `${fixturePath(FIXTURES, "wal-uncheckpointed.sqlite")}-wal`;
  const wal = readFileSync(walPath);
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0, false);
  const version = view.getUint32(4, false);
  const walPageSize = view.getUint32(8, false);
  const frameSize = 24 + walPageSize;
  const frames = Math.floor((wal.length - 32) / frameSize);
  let lastCommit = 0;
  for (let index = 0; index < frames; index += 1) {
    const dbSize = view.getUint32(32 + index * frameSize + 4, false);
    if (dbSize !== 0) lastCommit = dbSize;
  }
  const walRows = withWalCopy((copy) => engineRows(copy, "select id, label from wal_items order by id"));
  checks.push({
    name: "WAL header magic and version",
    ok: (magic === 0x377f0682 || magic === 0x377f0683) && version === 3_007_000,
    detail: `magic 0x${magic.toString(16)}, version ${version}`,
  });
  checks.push({
    name: "WAL frame count and commit size",
    ok: frames >= 1 && lastCommit > 0 && lastCommit <= frames,
    detail: `${frames} frames of ${frameSize} bytes, last commit covers ${lastCommit} pages`,
  });
  checks.push({
    name: "external engine recovers uncheckpointed WAL rows",
    ok: walRows.length === 2 && walRows[0].label === "w1" && walRows[1].label === "w2",
    detail: `${walRows.length} rows: ${walRows.map((row) => `${row.id}=${row.label}`).join(", ")}`,
  });

  // Corrupt fixtures: the external engine must either refuse the file or
  // read different data than the intact `overflow.sqlite` it was derived from.
  const intactBody = String(engineRow.body);
  const damaged = (label: string, path: string): Check => {
    try {
      const rows = engineRows(path, "select body from payloads");
      const body = rows.length === 0 ? null : String(rows[0].body);
      return {
        name: `corrupt fixture is observably damaged (${label})`,
        ok: body !== intactBody,
        detail: body === null ? "no rows remain" : `engine read ${body.length} bytes, intact fixture has ${intactBody.length}`,
      };
    } catch (error) {
      return { name: `corrupt fixture is observably damaged (${label})`, ok: true, detail: `engine refused the file: ${(error as Error).message}` };
    }
  };
  checks.push(damaged("zeroed header", fixturePath(FIXTURES, "corrupt-header.sqlite")));
  checks.push(damaged("truncated", fixturePath(FIXTURES, "corrupt-truncated.sqlite")));
  checks.push(damaged("flipped bit", fixturePath(FIXTURES, "corrupt-bitflip.sqlite")));
  let headerRejected = false;
  try {
    readHeader(readFileSync(fixturePath(FIXTURES, "corrupt-header.sqlite")));
  } catch {
    headerRejected = true;
  }
  checks.push({
    name: "independent header reader rejects a zeroed magic",
    ok: headerRejected,
    detail: headerRejected ? "magic mismatch" : "accepted a zeroed magic",
  });

  return { checks, fixtures };
}

export function commandConformance(options: CliOptions): number {
  let result: { checks: Check[]; fixtures: Array<{ name: string; bytes: number; sha256: string }> };
  try {
    result = runChecks();
  } catch (error) {
    result = {
      checks: [{ name: "conformance crashed", ok: false, detail: (error as Error).message }],
      fixtures: [],
    };
  }
  const ok = result.checks.length > 0 && result.checks.every((check) => check.ok);
  const payload = { command: "conformance", ok, checks: result.checks, fixtures: result.fixtures };
  const text = () => {
    const checkRows = result.checks.map((check) => [check.ok ? "ok" : "FAIL", check.name, check.detail]);
    const fixtureRows = result.fixtures.map((fixture) => [fixture.name, fixture.bytes, fixture.sha256]);
    return [
      renderTable(["status", "check", "detail"], checkRows),
      "",
      renderTable(["fixture", "bytes", "sha256"], fixtureRows),
    ].join("\n");
  };
  emit(options, payload as unknown as Record<string, unknown>, text);
  return ok ? 0 : 1;
}
