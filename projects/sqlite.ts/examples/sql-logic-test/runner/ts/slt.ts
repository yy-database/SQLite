// SQLLogicTest script reader shared by the TypeScript and Python runners.
//
// The format is line oriented: a blank line closes a block, `#` starts a
// comment, and every block starts with one directive. Only the directives the
// corpus actually uses are modelled here.

export type SortMode = "nosort" | "rowsort" | "valuesort";

export interface ScriptRecord {
  /** 1-based line number of the directive. */
  line: number;
  kind: "statement-ok" | "statement-error" | "query";
  sql: string;
  /** Type string such as `III`, one character per result column. */
  types: string;
  mode: SortMode;
  label: string;
  /** Expected value lines (queries only), still in file order. */
  expected: string[];
  /** Optional message regex for `statement error`. */
  errorPattern: string;
  /** Engine gate from a `skipif` / `onlyif` directive. */
  gate: { kind: "skipif" | "onlyif"; engine: string } | null;
  /** Set when the block uses a directive the runner cannot honour. */
  issue: string;
}

export interface ParsedScript {
  records: ScriptRecord[];
  /** Directives that produced no executable record, with their line. */
  issues: { line: number; message: string }[];
  /** True when the script ended with `halt`. */
  haltedAt: number | null;
}

const DEFAULT_HASH_THRESHOLD = 8;

export function parseScript(text: string): ParsedScript {
  const lines = text.split(/\r?\n/);
  const records: ScriptRecord[] = [];
  const issues: { line: number; message: string }[] = [];
  let hashThreshold = DEFAULT_HASH_THRESHOLD;
  let gate: ScriptRecord["gate"] = null;
  let pendingIssue = "";
  let haltedAt: number | null = null;
  let at = 0;

  const readBlock = (): { line: number; header: string; body: string[] } | null => {
    while (at < lines.length) {
      const raw = lines[at];
      if (raw.trim() === "" || raw.startsWith("#")) {
        at += 1;
        continue;
      }
      break;
    }
    if (at >= lines.length) {
      return null;
    }
    const line = at + 1;
    const header = lines[at].trim();
    at += 1;
    const body: string[] = [];
    while (at < lines.length && lines[at].trim() !== "") {
      if (!lines[at].startsWith("#")) {
        body.push(lines[at]);
      }
      at += 1;
    }
    return { line, header, body };
  };

  for (let block = readBlock(); block !== null; block = readBlock()) {
    const { line, header, body } = block;
    const [directive] = header.split(/\s+/);

    if (directive === "halt") {
      haltedAt = line;
      break;
    }
    if (directive === "hash-threshold") {
      const value = Number.parseInt(header.split(/\s+/)[1] ?? "", 10);
      if (Number.isNaN(value)) {
        issues.push({ line, message: `invalid hash-threshold header: ${header}` });
      } else {
        hashThreshold = value;
      }
      continue;
    }
    if (directive === "skipif" || directive === "onlyif") {
      gate = { kind: directive, engine: (header.split(/\s+/)[1] ?? "").toLowerCase() };
      continue;
    }
    if (directive === "require" || directive === "control") {
      pendingIssue = `unsupported directive \`${header}\``;
      issues.push({ line, message: pendingIssue });
      continue;
    }
    if (directive === "statement") {
      const form = (header.split(/\s+/)[1] ?? "").toLowerCase();
      if (form !== "ok" && form !== "error") {
        issues.push({ line, message: `unknown statement form: ${header}` });
        gate = null;
        pendingIssue = "";
        continue;
      }
      records.push({
        line,
        kind: form === "ok" ? "statement-ok" : "statement-error",
        sql: body.join("\n"),
        types: "",
        mode: "nosort",
        label: "",
        expected: [],
        errorPattern: form === "error" ? header.split(/\s+/).slice(2).join(" ") : "",
        gate,
        issue: pendingIssue,
      });
      gate = null;
      pendingIssue = "";
      continue;
    }
    if (directive === "query") {
      const parts = header.split(/\s+/);
      const types = parts[1] ?? "";
      const second = (parts[2] ?? "").toLowerCase();
      const mode: SortMode =
        second === "rowsort" || second === "valuesort" || second === "nosort" ? (second as SortMode) : "nosort";
      const label = second === "rowsort" || second === "valuesort" || second === "nosort" ? parts[3] ?? "" : parts[2] ?? "";
      const separator = body.findIndex((entry) => entry.trim() === "----");
      if (separator < 0) {
        issues.push({ line, message: "query block has no `----` separator" });
        gate = null;
        pendingIssue = "";
        continue;
      }
      const expected = body.slice(separator + 1);
      if (expected.length === 0) {
        issues.push({ line, message: "query block has no expected values" });
      }
      records.push({
        line,
        kind: "query",
        sql: body.slice(0, separator).join("\n"),
        types,
        mode,
        label,
        expected,
        errorPattern: "",
        gate,
        issue: pendingIssue,
      });
      gate = null;
      pendingIssue = "";
      continue;
    }
    issues.push({ line, message: `unknown directive: ${header}` });
    gate = null;
    pendingIssue = "";
  }

  return { records, issues, haltedAt };
}

/** `hash-threshold` from the parsed script, defaulted to the official 8. */
export function usesHash(expected: string[]): { count: number; digest: string } | null {
  if (expected.length !== 1) {
    return null;
  }
  const match = /^(\d+) values hashing to ([0-9a-f]{32})$/.exec(expected[0].trim());
  return match ? { count: Number.parseInt(match[1], 10), digest: match[2] } : null;
}

export type Cell = null | number | string | { $blob: string };

export function renderCell(type: string, cell: Cell): string {
  if (cell === null || cell === undefined) {
    return "NULL";
  }
  if (typeof cell === "object") {
    return `(blob:${cell.$blob.length / 2}B)`;
  }
  switch (type) {
    case "I":
      return String(cell);
    case "R":
      return typeof cell === "number" ? cell.toFixed(3) : String(cell);
    case "T":
      return cell === "" ? "(empty)" : String(cell);
    default:
      return String(cell);
  }
}

/** Renders every row according to its column type. */
export function renderRows(types: string, rows: Cell[][]): { rows: string[][]; values: string[] } {
  const rendered: string[][] = [];
  const values: string[] = [];
  for (const row of rows) {
    const cells = row.map((cell, index) => renderCell(types[index] ?? "T", cell));
    rendered.push(cells);
    values.push(...cells);
  }
  return { rows: rendered, values };
}

export interface Comparison {
  ok: boolean;
  detail: string;
  expectedLines: number;
  actualLines: number;
  values: number;
}

export function compareQuery(record: ScriptRecord, rows: Cell[][], digest: (text: string) => string): Comparison {
  const rendered = renderRows(record.types, rows);
  const hashed = usesHash(record.expected);
  // The corpus compares one value per line, not one row per line, so the
  // expected block and the rendered sequence have the same flat shape.
  let sequence: string[];
  if (record.mode === "rowsort") {
    const ordered = [...rendered.rows].sort((left, right) => {
      const a = left.join(" ");
      const b = right.join(" ");
      return a < b ? -1 : a > b ? 1 : 0;
    });
    sequence = ordered.flat();
  } else if (record.mode === "valuesort") {
    sequence = [...rendered.values].sort();
  } else {
    sequence = rendered.values;
  }
  if (hashed) {
    const joined = sequence.map((value) => `${value}\n`).join("");
    const actual = digest(joined);
    const ok = sequence.length === hashed.count && actual === hashed.digest;
    return {
      ok,
      detail: ok
        ? "hash matched"
        : `hash mismatch: ${sequence.length} values -> ${actual}, expected ${hashed.count} values -> ${hashed.digest}`,
      expectedLines: 1,
      actualLines: 1,
      values: sequence.length,
    };
  }
  const expectedLines = record.expected.map((line) => line.replace(/\r$/, ""));
  let ok = expectedLines.length === sequence.length;
  let detail = "";
  if (!ok) {
    detail = `value count ${sequence.length}, expected ${expectedLines.length}`;
  }
  for (let index = 0; index < Math.min(expectedLines.length, sequence.length); index += 1) {
    if (expectedLines[index] !== sequence[index]) {
      ok = false;
      detail ||= `first difference at value ${index + 1}: got \`${sequence[index]}\`, expected \`${expectedLines[index]}\``;
      break;
    }
  }
  return { ok, detail, expectedLines: expectedLines.length, actualLines: sequence.length, values: sequence.length };
}
