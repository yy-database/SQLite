// Builds and checks the divergence ledger.
//
//   node scripts/gen-divergences.mjs --write     # fill `direction`, `sqlite`, `ours`, `evidence`
//   node scripts/gen-divergences.mjs --verify    # replay both sides and fail on any drift
//
// The real SQLite side comes from `scripts/oracle-divergences.py` (CPython
// `sqlite3`), the engine side from `runner/ts/divergences.ts` running against
// the packed `@yydb/sqlite` artifact. Nothing is executed inside the repository
// tree; temporary directories are left in place and printed.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packAndInstall, requireOk, run, stagingDirectory } from "./prepare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const ledgerDirectory = resolve(here, "../divergences");
const ledgerPath = join(ledgerDirectory, "ledger.json");
const markdownPath = join(ledgerDirectory, "ledger.md");

function argument(name, fallback = "") {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const writeMode = process.argv.includes("--write");
const verifyMode = process.argv.includes("--verify");
if (writeMode === verifyMode) {
  throw new Error("pass exactly one of --write or --verify");
}
const caseTimeoutMs = Number.parseInt(argument("timeout-ms", "120000"), 10);

function sameValue(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    if (Number.isInteger(left) && Number.isInteger(right)) {
      return left === right;
    }
    return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    return String(left.$blob ?? "").toLowerCase() === String(right.$blob ?? "").toLowerCase();
  }
  return left === right;
}

function sameRows(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((row, index) => {
    const other = right[index];
    return row.length === other.length && row.every((cell, column) => sameValue(cell, other[column]));
  });
}

function directionOf(sqlite, ours) {
  const sqliteRows = sqlite.kind === "rows";
  const oursRows = ours.kind === "rows";
  if (sqliteRows && !oursRows) {
    return "sqlite-accepts-ours-rejects";
  }
  if (!sqliteRows && oursRows) {
    return "ours-accepts-sqlite-rejects";
  }
  if (sqliteRows && oursRows) {
    return sameRows(sqlite.rows, ours.rows) ? "none" : "same-statement-different-result";
  }
  return "none";
}

function shortOutcome(outcome) {
  if (outcome.kind === "rows") {
    const text = JSON.stringify(outcome.rows);
    return text.length > 140 ? `${text.slice(0, 140)}...` : text;
  }
  const prefix = outcome.code ? `${outcome.code}: ` : "";
  const text = `${prefix}${outcome.message ?? ""}`;
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function evidenceFor(sqlite, ours) {
  return {
    sqlite: `CPython ${sqlite.python} sqlite3 ${sqlite.sqliteVersion}`,
    ours: `${ours.module} engine ${ours.engineVersion} on Node ${ours.node} from packed tarballs`,
  };
}

function markdownFor(ledger, sqlite, ours) {
  const cases = ledger.cases;
  const byDirection = {};
  const byClass = {};
  const byPair = {};
  for (const entry of cases) {
    byDirection[entry.direction] = (byDirection[entry.direction] ?? 0) + 1;
    byClass[entry.class] = (byClass[entry.class] ?? 0) + 1;
    const key = `${entry.direction}|${entry.class}`;
    byPair[key] = (byPair[key] ?? 0) + 1;
  }
  const lines = [
    "# 分歧台账",
    "",
    "本文件由 `node scripts/gen-divergences.mjs --write` 生成，`--verify` 会重跑两侧并逐条比对。不要手改。",
    "",
    "`direction` 取值：`ours-accepts-sqlite-rejects`、`sqlite-accepts-ours-rejects`、`same-statement-different-result`，以及 `none`（两侧一致，用于证明某条覆盖项不是分歧）。",
    "",
    `- 真实 SQLite：CPython ${sqlite.python} 的 \`sqlite3\` ${sqlite.sqliteVersion}`,
    `- 本仓产物：${ours.module} 引擎 ${ours.engineVersion}（Node ${ours.node}），安装态运行`,
    `- 用例：${cases.length} 条，\`status\` 一律为 \`open\``,
    "",
    "## 按 direction 计数",
    "",
    "| direction | 条数 |",
    "|-----------|------|",
  ];
  for (const [key, value] of Object.entries(byDirection).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| \`${key}\` | ${value} |`);
  }
  lines.push("", "## 按 class 计数", "", "| class | 条数 |", "|-------|------|");
  for (const [key, value] of Object.entries(byClass).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| \`${key}\` | ${value} |`);
  }
  lines.push("", "## 按 direction × class 计数", "", "| direction | class | 条数 |", "|-----------|-------|------|");
  for (const [key, value] of Object.entries(byPair).sort()) {
    const [direction, klass] = key.split("|");
    lines.push(`| \`${direction}\` | \`${klass}\` | ${value} |`);
  }
  lines.push("", "## 明细", "");
  const ordered = [...cases].sort(
    (left, right) => left.direction.localeCompare(right.direction) || left.class.localeCompare(right.class) || left.id.localeCompare(right.id),
  );
  for (const entry of ordered) {
    lines.push(
      `### \`${entry.id}\``,
      "",
      `- direction：\`${entry.direction}\``,
      `- class：\`${entry.class}\``,
      `- setup：${entry.setup.length === 0 ? "无" : entry.setup.map((statement) => `\`${statement}\``).join("，")}`,
      `- sql：\`${entry.sql}\``,
      `- SQLite：\`${shortOutcome(entry.sqlite)}\``,
      `- 本仓：\`${shortOutcome(entry.ours)}\``,
      ...(entry.note ? [`- 备注：${entry.note}`] : []),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const staging = stagingDirectory("sqlite-divergences-");
const { install } = packAndInstall(repoRoot, staging);
cpSync(resolve(here, "../runner"), join(install, "runner"), { recursive: true });

const engine = requireOk(
  "engine side",
  run(`node --experimental-strip-types runner/ts/divergences.ts --ledger "${ledgerPath}"`, install, caseTimeoutMs),
);
const oracle = requireOk("sqlite side", run(`python oracle-divergences.py --ledger "${ledgerPath}"`, here, caseTimeoutMs));

const ours = JSON.parse(engine.stdout.trim().split("\n").pop());
const sqlite = JSON.parse(oracle.stdout.trim().split("\n").pop());

const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const evidence = evidenceFor(sqlite, ours);
const nd = [];
for (const entry of ledger.cases) {
  const observedOurs = ours.results[entry.id];
  const observedSqlite = sqlite.results[entry.id];
  if (!observedOurs || !observedSqlite) {
    throw new Error(`no outcome recorded for \`${entry.id}\``);
  }
  entry.direction = directionOf(observedSqlite, observedOurs);
  entry.sqlite = observedSqlite;
  entry.ours = observedOurs;
  entry.evidence = evidence;
  if (entry.direction === "none") {
    nd.push(entry.id);
  }
}
const markdown = markdownFor(ledger, sqlite, ours);

if (writeMode) {
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({ format: ledger.format, cases: ledger.cases }, null, 2)}\n`,
  );
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(markdownPath, markdown);
  const counts = {};
  for (const entry of ledger.cases) {
    counts[entry.direction] = (counts[entry.direction] ?? 0) + 1;
  }
  console.log(`ledger: ${ledger.cases.length} cases`);
  for (const [key, value] of Object.entries(counts).sort()) {
    console.log(`  ${key}: ${value}`);
  }
  if (!existsSync(markdownPath)) {
    throw new Error("markdown summary was not written");
  }
  console.log(`staging: ${staging}`);
  if (nd.length > 0) {
    console.log(`no divergence: ${nd.join(", ")}`);
  }
} else {
  const committed = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const problems = [];
  for (const entry of committed.cases) {
    const observed = ledger.cases.find((candidate) => candidate.id === entry.id);
    if (observed.direction !== entry.direction) {
      problems.push(`${entry.id}: direction ${entry.direction} -> ${observed.direction}`);
    }
    if (JSON.stringify(observed.sqlite) !== JSON.stringify(entry.sqlite)) {
      problems.push(`${entry.id}: sqlite side changed: ${JSON.stringify(entry.sqlite)} -> ${JSON.stringify(observed.sqlite)}`);
    }
    if (JSON.stringify(observed.ours) !== JSON.stringify(entry.ours)) {
      problems.push(`${entry.id}: engine side changed: ${JSON.stringify(entry.ours)} -> ${JSON.stringify(observed.ours)}`);
    }
    if (JSON.stringify(observed.evidence) !== JSON.stringify(entry.evidence)) {
      problems.push(`${entry.id}: evidence changed`);
    }
  }
  if (!existsSync(markdownPath) || readFileSync(markdownPath, "utf8") !== markdown) {
    problems.push("ledger.md is stale");
  }
  console.log(`ledger: ${committed.cases.length} cases`);
  if (problems.length > 0) {
    console.error(`verify failed with ${problems.length} problem(s):`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  console.log("verify: both sides match the committed ledger");
  console.log(`staging: ${staging}`);
}
