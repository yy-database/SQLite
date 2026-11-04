// External-truth adapters. Every adapter drives a real SQLite build that this
// repository does not implement: `better-sqlite3`, Node's built-in
// `node:sqlite`, the `sql.js` WASM build, and Python's `sqlite3`. They all
// normalize results to the same cell shape so a single assertion can be
// compared across at least two independent implementations.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { execFile, repoPath } from "./util.ts";

export type Cell = null | { i: string } | { r: string } | { t: string } | { b: string };

export interface Step {
  readonly sql: string;
  readonly params?: unknown[];
}

export interface StepOutcome {
  readonly rows?: Cell[][];
  readonly error?: string;
}

export type EngineName = "better-sqlite3" | "node:sqlite" | "sql.js" | "python";

export const ENGINE_NAMES: EngineName[] = ["better-sqlite3", "node:sqlite", "sql.js", "python"];

export interface Engine {
  readonly name: EngineName;
  readonly version: string;
  run(steps: Step[]): Promise<StepOutcome[]>;
}

// The external engines are harness dependencies, so resolve them from the
// harness package instead of relying on a hoisted layout at the repository
// root. Both `better-sqlite3` and `sql.js` live in this package's
// `devDependencies`.
const requireFromTs = createRequire(repoPath("projects", "sqlite.ts", "packages", "sqlite-harness", "package.json"));
const PYTHON = process.platform === "win32" ? "python" : "python3";

type BetterSqliteStatic = new (path: string) => {
  prepare(source: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  defaultSafeIntegers(enabled: boolean): unknown;
  close(): void;
};

function loadBetterSqlite(): BetterSqliteStatic {
  return requireFromTs("better-sqlite3");
}

function cellFromUnknown(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return { i: value.toString() };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { i: String(value) };
    return { r: String(value) };
  }
  if (typeof value === "string") return { t: value };
  if (value instanceof Uint8Array) return { b: Buffer.from(value).toString("hex") };
  if (typeof value === "boolean") return { i: value ? "1" : "0" };
  return { t: String(value) };
}

function rowsFromObjects(rows: unknown[]): Cell[][] {
  return rows.map((row) => {
    const values = Array.isArray(row) ? row : Object.values(row as Record<string, unknown>);
    return values.map(cellFromUnknown);
  });
}

// `better-sqlite3` refuses `.all()` for statements that produce no result set.
// Every other adapter accepts them, so the adapter runs the statement and
// reports an empty result instead of surfacing an engine-specific quirk.
function betterRows(statement: { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }, params: unknown[]): Cell[][] {
  try {
    return rowsFromObjects(statement.all(...params));
  } catch (error) {
    if (!/does not return data/i.test((error as Error).message)) throw error;
    statement.run(...params);
    return [];
  }
}

function betterSqliteEngine(): Engine {
  const BetterSqlite = loadBetterSqlite();
  const probe = new BetterSqlite(":memory:");
  const version = String(
    (probe.prepare("select sqlite_version() as version").all() as Array<{ version: string }>)[0].version,
  );
  probe.close();
  return {
    name: "better-sqlite3",
    version,
    async run(steps) {
      const database = new BetterSqlite(":memory:");
      database.defaultSafeIntegers(true);
      const outcomes: StepOutcome[] = [];
      try {
        for (const step of steps) {
          try {
            outcomes.push({ rows: betterRows(database.prepare(step.sql), step.params ?? []) });
          } catch (error) {
            outcomes.push({ error: (error as Error).message });
          }
        }
      } finally {
        database.close();
      }
      return outcomes;
    },
  };
}

type NodeSqlite = {
  DatabaseSync: new (path: string) => {
    prepare(source: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
      setReadBigInts(enabled: boolean): unknown;
    };
    close(): void;
  };
};

async function nodeSqliteEngine(): Promise<Engine> {
  const sqlite = (await import("node:sqlite")) as unknown as NodeSqlite;
  const probe = new sqlite.DatabaseSync(":memory:");
  const version = String(probe.prepare("select sqlite_version() as version").all()[0].version);
  probe.close();
  return {
    name: "node:sqlite",
    version,
    async run(steps) {
      const database = new sqlite.DatabaseSync(":memory:");
      const outcomes: StepOutcome[] = [];
      try {
        for (const step of steps) {
          try {
            const statement = database.prepare(step.sql);
            statement.setReadBigInts(true);
            outcomes.push({ rows: rowsFromObjects(statement.all(...(step.params ?? []))) });
          } catch (error) {
            outcomes.push({ error: (error as Error).message });
          }
        }
      } finally {
        database.close();
      }
      return outcomes;
    },
  };
}

type SqlJsStatic = {
  Database: new () => {
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
  };
};

let sqlJsModule: Promise<{ module: SqlJsStatic; version: string }> | undefined;

async function sqlJsEngine(): Promise<Engine> {
  if (!sqlJsModule) {
    const entry = requireFromTs.resolve("sql.js");
    const factory = requireFromTs("sql.js") as (options: {
      locateFile(file: string): string;
    }) => Promise<SqlJsStatic>;
    sqlJsModule = factory({ locateFile: (file) => join(entry, "..", file) }).then((module) => {
      const database = new module.Database();
      const version = String(database.exec("select sqlite_version() as version")[0].values[0][0]);
      database.close();
      return { module, version };
    });
  }
  const loaded = await sqlJsModule;
  return {
    name: "sql.js",
    version: loaded.version,
    async run(steps) {
      const database = new loaded.module.Database();
      const outcomes: StepOutcome[] = [];
      try {
        for (const step of steps) {
          try {
            const results = database.exec(step.sql, step.params ?? []);
            const values = results.length > 0 ? results[results.length - 1].values : [];
            outcomes.push({ rows: values.map((row) => row.map(cellFromUnknown)) });
          } catch (error) {
            outcomes.push({ error: (error as Error).message });
          }
        }
      } finally {
        database.close();
      }
      return outcomes;
    },
  };
}

const PYTHON_RUNNER = `
import json, sqlite3, sys

def cell(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return {"i": "1" if value else "0"}
    if isinstance(value, int):
        return {"i": str(value)}
    if isinstance(value, float):
        return {"r": repr(value)}
    if isinstance(value, (bytes, bytearray)):
        return {"b": bytes(value).hex()}
    return {"t": str(value)}

request = json.load(sys.stdin)
database = sqlite3.connect(":memory:")
outcomes = []
for step in request["steps"]:
    try:
        cursor = database.execute(step["sql"], step.get("params", []))
        outcomes.append({"rows": [[cell(value) for value in row] for row in cursor.fetchall()]})
    except Exception as error:
        outcomes.append({"error": str(error)})
database.close()
json.dump({"outcomes": outcomes}, sys.stdout)
`;

function pythonEngine(): Engine {
  const probe = execFile(PYTHON, ["-c", "import sqlite3; print(sqlite3.sqlite_version)"]);
  if (probe.status !== 0) throw new Error(probe.stderr.trim() || "python sqlite3 probe failed");
  return {
    name: "python",
    version: probe.stdout.trim(),
    async run(steps) {
      const result = spawnSync(PYTHON, ["-c", PYTHON_RUNNER], {
        input: JSON.stringify({ steps }),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(result.stderr.trim() || "python sqlite3 run failed");
      return (JSON.parse(result.stdout) as { outcomes: StepOutcome[] }).outcomes;
    },
  };
}

export async function openEngine(name: EngineName): Promise<Engine> {
  switch (name) {
    case "better-sqlite3":
      return betterSqliteEngine();
    case "node:sqlite":
      return nodeSqliteEngine();
    case "sql.js":
      return sqlJsEngine();
    case "python":
      return pythonEngine();
    default:
      throw new Error(`unknown engine ${String(name)}`);
  }
}

export interface EngineStatus {
  readonly name: EngineName;
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export async function engineStatus(): Promise<EngineStatus[]> {
  const statuses: EngineStatus[] = [];
  for (const name of ENGINE_NAMES) {
    try {
      const engine = await openEngine(name);
      statuses.push({ name, available: true, version: engine.version });
    } catch (error) {
      statuses.push({ name, available: false, reason: (error as Error).message });
    }
  }
  return statuses;
}

export async function runOn(names: EngineName[], steps: Step[]): Promise<Record<string, StepOutcome[]>> {
  const record: Record<string, StepOutcome[]> = {};
  for (const name of names) {
    const engine = await openEngine(name);
    record[name] = await engine.run(steps);
  }
  return record;
}

export function cellText(value: Cell): string {
  if (value === null) return "NULL";
  if ("i" in value) return `int ${value.i}`;
  if ("r" in value) return `real ${value.r}`;
  if ("t" in value) return `text ${JSON.stringify(value.t)}`;
  return `blob ${value.b}`;
}

function cellsEqual(left: Cell, right: Cell): boolean {
  if (left === null || right === null) return left === right;
  if ("i" in left && "i" in right) return left.i === right.i;
  if ("r" in left && "r" in right) {
    const a = Number(left.r);
    const b = Number(right.r);
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  if ("t" in left && "t" in right) return left.t === right.t;
  if ("b" in left && "b" in right) return left.b === right.b;
  return false;
}

export interface Comparison {
  readonly ok: boolean;
  readonly differences: string[];
  readonly engines: string[];
}

export function compareOutcomes(outcomes: Record<string, StepOutcome[]>): Comparison {
  const engines = Object.keys(outcomes);
  if (engines.length < 2) {
    return { ok: false, engines, differences: ["fewer than two external engines are available"] };
  }
  const baselineName = engines[0];
  const baseline = outcomes[baselineName];
  const differences: string[] = [];
  for (const engine of engines.slice(1)) {
    const candidate = outcomes[engine];
    if (candidate.length !== baseline.length) {
      differences.push(`${engine}: ${candidate.length} steps vs ${baseline.length} in ${baselineName}`);
      continue;
    }
    baseline.forEach((expected, index) => {
      const actual = candidate[index];
      if (expected.error || actual.error) {
        if (!expected.error || !actual.error) {
          differences.push(
            `${engine} step ${index + 1}: error mismatch (${actual.error ?? "none"} vs ${expected.error ?? "none"})`,
          );
        }
        return;
      }
      const expectedRows = expected.rows ?? [];
      const actualRows = actual.rows ?? [];
      if (expectedRows.length !== actualRows.length) {
        differences.push(`${engine} step ${index + 1}: ${actualRows.length} rows vs ${expectedRows.length} in ${baselineName}`);
        return;
      }
      for (let row = 0; row < expectedRows.length; row += 1) {
        if (expectedRows[row].length !== actualRows[row].length) {
          differences.push(
            `${engine} step ${index + 1} row ${row + 1}: ${actualRows[row].length} columns vs ${expectedRows[row].length}`,
          );
          return;
        }
        for (let column = 0; column < expectedRows[row].length; column += 1) {
          if (!cellsEqual(expectedRows[row][column], actualRows[row][column])) {
            differences.push(
              `${engine} step ${index + 1} row ${row + 1} column ${column + 1}: ${cellText(actualRows[row][column])} vs ${cellText(expectedRows[row][column])} in ${baselineName}`,
            );
            return;
          }
        }
      }
    });
  }
  return { ok: differences.length === 0, engines, differences };
}
