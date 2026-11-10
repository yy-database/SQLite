// `fuzz` subcommand: grammar-driven random inputs through the harness `fuzz` engine.
//
// The grammar content below (SQL vocabulary, schema-fact pools) is product-side
// data. The generation engine, the repro envelope and the shrink state machine
// live in `database.harness` and are reached through the napi primitives
// (`harnessFuzzGenerate` / `harnessFuzzRender` / `harnessFuzzShrink*`). This
// file never produces an expected value: the two external oracles decide it.
// A case the oracles disagree on is discarded, never compared with this
// repository. A case where the oracles agree but this repository differs is a
// finding; the shrink session minimizes the statement sequence while the
// predicate "still a finding" holds, and the repro envelope is recorded so the
// exact same sequence can be replayed byte-for-byte later.
//
// Findings flow through the same known-difference ledger as the corpus:
// `harnessCheckBaseline` judges them against `corpus/fuzz-baseline.json`.
// `--check` gates, `--update-baseline` records.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEngine, type ExecValue } from "../../../sqlite/src/index.ts";
import { openEngine, type Cell, type Engine, type StepOutcome } from "../conformance/oracle.ts";
import { harnessAddon as loadHarnessAddon, renderTable } from "../cli/util.ts";

// fuzz 生成/重放/收缩与 baseline 判定走上游 `database.harness` 标准面（与产品共用
// `.node`），不在本地重写随机、收缩或台账判定。
const harnessAddon = loadHarnessAddon();

// Product-side grammar data. Rule alternatives follow the harness convention
// "simplest first": the shrink state machine prefers lower indices.
const GRAMMAR = {
  version: 1,
  start: "stmt",
  rules: [
    {
      id: "select_simple",
      type_tag: "stmt",
      alternatives: [
        [{ literal: "select" }, { slot: { pool: "cols" } }, { literal: "from" }, { slot: { pool: "tbl" } }],
        [{ literal: "select" }, { slot: { pool: "cols" } }, { literal: "from" }, { slot: { pool: "tbl" } }, { literal: "order by" }, { slot: { pool: "col" } }],
      ],
    },
    {
      id: "select_where",
      type_tag: "stmt",
      alternatives: [
        [{ literal: "select" }, { slot: { pool: "cols" } }, { literal: "from" }, { slot: { pool: "tbl" } }, { literal: "where" }, { typed: "cond" }],
        [{ literal: "select count ( * )" }, { literal: "from" }, { slot: { pool: "tbl" } }],
      ],
    },
    {
      id: "insert_row",
      type_tag: "stmt",
      alternatives: [
        [{ literal: "insert into" }, { slot: { pool: "tbl" } }, { literal: "values" }, { typed: "pair" }],
      ],
    },
    {
      id: "delete_rows",
      type_tag: "stmt",
      alternatives: [
        [{ literal: "delete from" }, { slot: { pool: "tbl" } }],
        [{ literal: "delete from" }, { slot: { pool: "tbl" } }, { literal: "where" }, { typed: "cond" }],
      ],
    },
    {
      id: "compare",
      type_tag: "cond",
      alternatives: [
        [{ slot: { pool: "col" } }, { literal: "is not null" }],
        [{ slot: { pool: "col" } }, { slot: { pool: "op" } }, { slot: { pool: "val" } }],
        [{ slot: { pool: "col" } }, { literal: "in ( 1 , 2 )" }],
      ],
    },
    {
      id: "value_pair",
      type_tag: "pair",
      alternatives: [
        [{ literal: "( 9 , 'nine' )" }],
        [{ literal: "(" }, { slot: { pool: "num" } }, { literal: "," }, { slot: { pool: "text" } }, { literal: ")" }],
      ],
    },
  ],
  pools: [
    { name: "tbl", values: ["t1", "t2"] },
    { name: "col", values: ["a", "b", "x", "y"] },
    { name: "cols", values: ["*", "a", "b", "x", "y", "a , b"] },
    { name: "op", values: ["=", "<", ">", "!="] },
    { name: "val", values: ["1", "2", "9", "'one'", "'abc'", "1.5", "null"] },
    { name: "num", values: ["1", "2", "9"] },
    { name: "text", values: ["'x'", "'one'", "'abc'"] },
  ],
};

// One fixture for every case; every engine replays exactly these steps first.
const FIXTURE_STEPS = [
  "create table t1 (a integer, b text)",
  "insert into t1 values (1, 'one'), (2, 'two')",
  "create table t2 (x real, y text)",
  "insert into t2 values (1.5, 'abc'), (2.5, 'def')",
];

const BASELINE_PATH = fileURLToPath(new URL("../../corpus/fuzz-baseline.json", import.meta.url));

interface Side {
  readonly rows?: string[][];
  readonly error?: string;
}

interface FuzzOptions {
  readonly seed: number;
  readonly count: number;
  readonly depth: number;
  readonly stmts: number;
  readonly maxShrink: number;
  readonly check: boolean;
  readonly updateBaseline: boolean;
  readonly json: boolean;
}

interface BaselineEntry {
  readonly key: string;
  readonly signal: readonly string[];
  readonly reason: string;
  readonly repro: readonly string[];
}

interface BaselineFile {
  readonly version: number;
  readonly seed: number;
  readonly count: number;
  readonly depth: number;
  readonly digest: string;
  readonly entries: readonly BaselineEntry[];
}

interface Finding {
  readonly key: string;
  readonly envelope: string;
  readonly repro: readonly string[];
  readonly signal: readonly string[];
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Number.isSafeInteger(value)) return BigInt(value).toString();
  return String(value);
}

function normCell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return `n:${numberText(value)}`;
  if (typeof value === "bigint") return `n:${value.toString()}`;
  if (typeof value === "boolean") return `n:${value ? "1" : "0"}`;
  if (typeof value === "string") return `t:${value}`;
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString("hex")}`;
  const cell = value as Cell | ExecValue;
  if (typeof cell === "object" && cell !== null) {
    if ("i" in cell && typeof cell.i === "string") return `n:${cell.i}`;
    if ("r" in cell && typeof cell.r === "string") return `n:${numberText(Number(cell.r))}`;
    if ("t" in cell && typeof cell.t === "string") return `t:${cell.t}`;
    if ("b" in cell && typeof cell.b === "string") return `b:${cell.b}`;
    if ("$blob" in cell && typeof cell.$blob === "string") return `b:${cell.$blob}`;
  }
  return `t:${String(value)}`;
}

function normRows(rows: readonly unknown[][]): string[][] {
  return rows.map((row) => row.map(normCell));
}

function oracleSide(outcome: StepOutcome | undefined): Side {
  if (!outcome) return { error: "oracle returned no outcome" };
  if (outcome.error) return { error: outcome.error };
  return { rows: normRows(outcome.rows ?? []) };
}

// Both engines rejecting a statement counts as agreement: the fuzz loop hunts
// divergence in accepted behaviour, not differences in error wording.
function sidesEqual(left: Side, right: Side): boolean {
  if (left.error || right.error) return Boolean(left.error) === Boolean(right.error);
  return JSON.stringify(left.rows ?? []) === JSON.stringify(right.rows ?? []);
}

function runOurs(statements: readonly string[]): Side[] {
  const engine = createEngine(4096);
  const sides: Side[] = [];
  try {
    for (const step of [...FIXTURE_STEPS, ...statements]) {
      const result = engine.tryExecute(step);
      if (!result.ok) {
        const error = result.error;
        sides.push({ error: error ? `${error.code} ${error.message}` : "unknown error" });
      }
      else {
        sides.push({ rows: normRows(result.result?.rows ?? []) });
      }
    }
    return sides;
  }
  catch (error) {
    return [...sides, { error: (error as Error).message }];
  }
}

async function runOracle(engine: Engine, statements: readonly string[]): Promise<Side[]> {
  const steps = [...FIXTURE_STEPS, ...statements].map((sql) => ({ sql }));
  const outcomes = await engine.run(steps);
  return statements.map((_statement, index) => oracleSide(outcomes[FIXTURE_STEPS.length + index]));
}

type Verdict = { status: "clean" } | { status: "disagreement"; index: number } | { status: "finding"; index: number };

async function classify(better: Engine, python: Engine, statements: readonly string[]): Promise<Verdict> {
  const betterSides = await runOracle(better, statements);
  const pythonSides = await runOracle(python, statements);
  for (let index = 0; index < statements.length; index += 1) {
    if (!sidesEqual(betterSides[index], pythonSides[index])) return { status: "disagreement", index };
  }
  const oursSides = runOurs(statements);
  for (let index = 0; index < statements.length; index += 1) {
    if (!sidesEqual(oursSides[index], betterSides[index])) return { status: "finding", index };
  }
  return { status: "clean" };
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseFuzzOptions(argv: string[]): FuzzOptions {
  return {
    seed: Number(optionValue(argv, "--seed") ?? 20261109),
    count: Number(optionValue(argv, "--count") ?? 30),
    depth: Number(optionValue(argv, "--depth") ?? 3),
    stmts: Number(optionValue(argv, "--stmts") ?? 8),
    maxShrink: Number(optionValue(argv, "--max-shrink") ?? 120),
    check: argv.includes("--check"),
    updateBaseline: argv.includes("--update-baseline"),
    json: argv.includes("--json"),
  };
}

function loadBaseline(): BaselineFile | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
}

function baselineJson(file: BaselineFile): string {
  return JSON.stringify({
    identity: {
      spec: { version: file.version, seed: file.seed, count: file.count },
      digest: file.digest,
    },
    entries: file.entries.map((entry) => ({ key: entry.key, signal: [...entry.signal], reason: entry.reason })),
  });
}

interface LedgerVerdict {
  readonly matched: number;
  readonly problems: readonly { readonly kind: string; readonly key?: string }[];
}

function runLedger(baseline: BaselineFile, current: { spec: unknown; digest: string }, findings: readonly Finding[]): LedgerVerdict {
  const observed = findings.map((finding) => ({ key: finding.key, signal: [...finding.signal], reason: "fuzz-mismatch" }));
  return JSON.parse(
    harnessAddon.harnessCheckBaseline(baselineJson(baseline), JSON.stringify(current), JSON.stringify(observed)),
  ) as LedgerVerdict;
}

export async function commandFuzz(options: FuzzOptions): Promise<number> {
  const grammarJson = JSON.stringify(GRAMMAR);
  const cases: string[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const plan = JSON.stringify({ seed: options.seed + index, depth: options.depth, count: options.stmts });
    cases.push(harnessAddon.harnessFuzzGenerate(grammarJson, plan));
  }
  const corpusDigest = harnessAddon.harnessDigest(Buffer.from(cases.join("\n")));

  const better = await openEngine("better-sqlite3");
  const python = await openEngine("python");
  let discarded = 0;
  const findings: Finding[] = [];
  for (const envelope of cases) {
    const statements = JSON.parse(harnessAddon.harnessFuzzRender(grammarJson, envelope)) as string[];
    const verdict = await classify(better, python, statements);
    if (verdict.status === "disagreement") {
      discarded += 1;
      continue;
    }
    if (verdict.status !== "finding") continue;

    let session = JSON.parse(harnessAddon.harnessFuzzShrinkStart(grammarJson, envelope)) as Record<string, unknown>;
    for (let step = 0; step < options.maxShrink; step += 1) {
      const probe = JSON.parse(harnessAddon.harnessFuzzShrinkNext(grammarJson, JSON.stringify(session))) as {
        session: Record<string, unknown>;
        candidate: [Record<string, unknown>, string[]] | null;
      };
      session = probe.session;
      if (!probe.candidate) break;
      const failing = (await classify(better, python, probe.candidate[1])).status === "finding";
      session = JSON.parse(harnessAddon.harnessFuzzShrinkReport(JSON.stringify(session), failing)) as Record<string, unknown>;
    }
    const base = JSON.stringify(session.base);
    const repro = JSON.parse(harnessAddon.harnessFuzzRender(grammarJson, base)) as string[];
    const shrunk = await classify(better, python, repro);
    findings.push({
      key: harnessAddon.harnessDigest(Buffer.from(base)),
      envelope: base,
      repro,
      signal: [`step-${shrunk.status === "finding" ? shrunk.index : 0}`, "oracle-vs-ours"],
    });
  }

  const current = { spec: { version: 1, seed: options.seed, count: options.count }, digest: corpusDigest };
  const baseline = loadBaseline();
  let ledger: LedgerVerdict | undefined;
  if (options.updateBaseline) {
    const file: BaselineFile = {
      version: 1,
      seed: options.seed,
      count: options.count,
      depth: options.depth,
      digest: corpusDigest,
      entries: findings.map((finding) => ({ key: finding.key, signal: finding.signal, reason: "fuzz-mismatch", repro: finding.repro })),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
  const effectiveBaseline = options.updateBaseline ? loadBaseline() : baseline;
  if (effectiveBaseline) {
    ledger = runLedger(effectiveBaseline, current, findings);
  }
  const problems = ledger ? ledger.problems : [];
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      seed: options.seed,
      count: options.count,
      depth: options.depth,
      stmts: options.stmts,
      digest: corpusDigest,
      discarded,
      findings: findings.map((finding) => ({ key: finding.key, repro: finding.repro, envelope: JSON.parse(finding.envelope) })),
      ledger: ledger ?? null,
    }, null, 2)}\n`);
  }
  else {
    process.stdout.write(`fuzz gate: seed ${options.seed} count ${options.count} depth ${options.depth} stmts ${options.stmts} digest ${corpusDigest}\n`);
    process.stdout.write(`${options.count} cases: ${discarded} discarded (oracle-disagreement) / ${findings.length} findings\n`);
    for (const finding of findings) {
      process.stdout.write(`\nfinding ${finding.key.slice(0, 12)}\n${renderTable(["repro statements"], finding.repro.map((line) => [line]))}\n`);
      process.stdout.write(`repro envelope: ${finding.envelope}\n`);
    }
    if (ledger) {
      process.stdout.write(`\nledger: ${ledger.matched} matched / ${problems.length} problems\n`);
      for (const problem of problems) {
        process.stdout.write(`  ${problem.kind}${problem.key ? ` ${problem.key.slice(0, 12)}` : ""}\n`);
      }
    }
    else {
      process.stdout.write(`\nledger: no baseline file yet (${BASELINE_PATH})\n`);
    }
  }
  if (options.check && problems.length > 0) return 1;
  return 0;
}
