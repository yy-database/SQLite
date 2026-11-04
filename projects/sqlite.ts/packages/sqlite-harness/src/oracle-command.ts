// `oracle` subcommand: report which external SQLite implementations are
// reachable and prove that one assertion can be judged by more than one of
// them. Nothing here judges this repository's code. The probes are plain SQL
// that every engine implements, so a disagreement means an adapter problem
// rather than a real semantic difference.

import { compareOutcomes, engineStatus, runOn, type EngineName, type Step } from "./oracle.ts";
import { emit, renderTable, type CliOptions } from "./util.ts";

interface Probe {
  readonly name: string;
  readonly steps: Step[];
}

const PROBES: Probe[] = [
  {
    name: "arithmetic and string functions",
    steps: [{ sql: "select 2 + 3 * 4 as n, upper('ab') || 'c' as s, length('hello') as l" }],
  },
  {
    name: "typeof and cast",
    steps: [{ sql: "select typeof(1) as a, typeof(1.5) as b, typeof('x') as c, cast('12' as integer) as d" }],
  },
  {
    name: "create table and query",
    steps: [
      { sql: "create table t (id integer primary key, label text)" },
      { sql: "select name, type from sqlite_master where name = 't'" },
    ],
  },
  {
    name: "multi-row insert and order",
    steps: [
      { sql: "create table t (id integer primary key, label text)" },
      { sql: "insert into t (id, label) values (1, 'a'), (2, 'b'), (3, 'c')" },
      { sql: "select id, label from t order by id" },
    ],
  },
  {
    name: "in list and descending order",
    steps: [
      { sql: "create table t (id integer primary key)" },
      { sql: "insert into t (id) values (1), (2), (3), (4)" },
      { sql: "select id from t where id in (1, 3, 4) order by id desc" },
    ],
  },
  {
    name: "aggregates",
    steps: [
      { sql: "create table t (id integer primary key, score integer)" },
      { sql: "insert into t (id, score) values (1, 10), (2, 20), (3, 30)" },
      { sql: "select count(*) as n, sum(score) as total, min(score) as lo, max(score) as hi from t" },
    ],
  },
  {
    name: "bound parameters",
    steps: [
      { sql: "create table t (id integer primary key, label text)" },
      { sql: "insert into t (id, label) values (?, ?)", params: [1, "bound"] },
      { sql: "select label from t where id = ?", params: [1] },
    ],
  },
  {
    name: "empty result set",
    steps: [
      { sql: "create table t (id integer primary key)" },
      { sql: "select id from t where id = 99" },
    ],
  },
  {
    name: "error semantics for a missing table",
    steps: [{ sql: "select * from missing_table" }],
  },
];

export async function commandOracle(options: CliOptions): Promise<number> {
  const statuses = await engineStatus();
  const available = statuses.filter((status) => status.available).map((status) => status.name as EngineName);

  const results: Array<{ probe: string; ok: boolean; differences: string[]; engines: string[] }> = [];
  for (const probe of PROBES) {
    const outcomes = await runOn(available, probe.steps);
    const comparison = compareOutcomes(outcomes);
    results.push({ probe: probe.name, ok: comparison.ok, differences: comparison.differences, engines: comparison.engines });
  }

  const ok = available.length >= 2 && results.every((result) => result.ok);
  const payload = { command: "oracle", ok, engines: statuses, probes: results };
  const text = () => {
    const engineRows = statuses.map((status) => [
      status.name,
      status.available ? "available" : "missing",
      status.version ?? "",
      status.reason ?? "",
    ]);
    const probeRows = results.map((result) => [
      result.probe,
      result.engines.length,
      result.ok ? "agree" : "DIFF",
      result.differences.slice(0, 2).join(" / "),
    ]);
    return [
      renderTable(["engine", "state", "version", "reason"], engineRows),
      "",
      renderTable(["probe", "engines", "verdict", "differences"], probeRows),
      "",
      ok
        ? `at least two external engines agree on every probe (${available.join(", ")})`
        : "not enough agreement to treat the external engines as truth",
    ].join("\n");
  };
  emit(options, payload as unknown as Record<string, unknown>, text);
  return ok ? 0 : 1;
}
