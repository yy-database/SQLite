// Installs `@yydb/sqlite` and `sqlite-format3` outside the repository, runs the
// TypeScript and Python runners over the SQLLogicTest corpus, and aggregates
// their verdicts.
//
//   node scripts/run.mjs --files select1,select2 --json report.json
//
// Every probe runs in a temporary directory. Temporary directories are left in
// place and printed, so nothing in them can be lost behind a cleanup command.

import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packAndInstall, preparePython, run, stagingDirectory } from "./prepare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const corpusRoot = resolve(here, "../corpus");
const corpusTest = resolve(corpusRoot, "test");

function argument(name, fallback = "") {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

const only = argument("only", "both");
const fileTimeoutMs = Number.parseInt(argument("file-timeout-ms", "180000"), 10);
const caseWarnMs = Number.parseInt(argument("case-warn-ms", "5000"), 10);
const jsonPath = argument("json", "");
const requested = argument("files", "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const files = requested.length > 0 ? requested.map((name) => `${name}.test`) : readdirSync(corpusTest).filter((name) => name.endsWith(".test")).sort();

function corpusCommit() {
  const rev = run("git rev-parse HEAD", corpusRoot, 60_000);
  return rev.status === 0 ? rev.stdout.trim() : "unknown";
}

const staging = stagingDirectory("sqlite-sqllogictest-");
const { install, packed } = packAndInstall(repoRoot, staging);
cpSync(resolve(here, "../runner"), join(install, "runner"), { recursive: true });
const runnerCommit = run("git rev-parse HEAD", repoRoot, 60_000);

function runRunner(file, source) {
  const label = `${source}:${file}`;
  const progress = join(staging, `progress-${source}-${file}.jsonl`);
  const command =
    source === "ts"
      ? `node --experimental-strip-types runner/ts/run.ts --file "${join(corpusTest, file)}" --format json --progress "${progress}" --case-warn-ms ${caseWarnMs}`
      : `"${pythonExe}" runner/py/run.py --file "${join(corpusTest, file)}" --format json --progress "${progress}" --case-warn-ms ${caseWarnMs}`;
  const result = run(command, install, fileTimeoutMs);
  const timedOut = result.error?.code === "ETIMEDOUT" || result.status !== 0;
  if (!timedOut) {
    try {
      return { ok: true, summary: JSON.parse(result.stdout.trim().split("\n").pop() ?? "") };
    } catch {
      return { ok: false, reason: `no JSON on stdout: ${(result.stdout + result.stderr).trim().slice(-800)}` };
    }
  }
  let last = null;
  if (existsSync(progress)) {
    const lines = readFileSync(progress, "utf8").split("\n").filter(Boolean);
    last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  }
  return {
    ok: false,
    reason: result.error?.code === "ETIMEDOUT" ? `file timeout after ${fileTimeoutMs} ms` : `runner exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(-800)}`,
    timedOutLine: last?.line ?? null,
    timedOutIndex: last?.index ?? null,
  };
}

let pythonExe = "python";
if (only !== "ts") {
  pythonExe = preparePython(repoRoot, staging);
}

const PER_FILE_FIELDS = ["records", "pass", "unsupported", "resultMismatch", "errorMismatch", "runnerError", "filtered"];

const summaries = { ts: {}, py: {} };
const parity = [];
for (const file of files) {
  for (const source of ["ts", "py"]) {
    if (only !== "both" && only !== source) {
      continue;
    }
    const outcome = runRunner(file, source);
    summaries[source][file] = outcome.ok
      ? outcome.summary
      : {
          source,
          file,
          records: 0,
          pass: 0,
          unsupported: 0,
          resultMismatch: 0,
          errorMismatch: 0,
          runnerError: 1,
          filtered: 0,
          statements: { total: 0, accepted: 0, rejectedUnsupported: 0, rejectedOther: 0 },
          queries: { total: 0, matched: 0 },
          rejections: {},
          rejectionClauses: {},
          failures: [{ line: outcome.timedOutLine ?? 0, kind: "runner-error", detail: outcome.reason }],
          slow: [],
          haltAt: null,
          parseIssues: [],
          elapsedMs: 0,
        };
  }
  if (summaries.ts[file] && summaries.py[file]) {
    const differing = PER_FILE_FIELDS.filter((field) => summaries.ts[file][field] !== summaries.py[file][field]);
    if (JSON.stringify(summaries.ts[file].rejections) !== JSON.stringify(summaries.py[file].rejections)) {
      differing.push("rejections");
    }
    parity.push({ file, identical: differing.length === 0, differing });
  }
}

const chosen = only === "py" ? summaries.py : summaries.ts;
const aggregate = {
  files: {},
  totals: { records: 0, pass: 0, unsupported: 0, resultMismatch: 0, errorMismatch: 0, runnerError: 0, filtered: 0 },
  statements: { total: 0, accepted: 0 },
  queries: { total: 0, matched: 0 },
  rejections: {},
  rejectionClauses: {},
  fullyPassingFiles: [],
};
for (const file of files) {
  const summary = chosen[file];
  if (!summary) {
    continue;
  }
  aggregate.files[file] = Object.fromEntries(PER_FILE_FIELDS.map((field) => [field, summary[field]]));
  for (const field of Object.keys(aggregate.totals)) {
    aggregate.totals[field] += summary[field] ?? 0;
  }
  aggregate.statements.total += summary.statements.total;
  aggregate.statements.accepted += summary.statements.accepted;
  aggregate.queries.total += summary.queries.total;
  aggregate.queries.matched += summary.queries.matched;
  for (const [code, value] of Object.entries(summary.rejections)) {
    aggregate.rejections[code] = (aggregate.rejections[code] ?? 0) + value;
  }
  for (const [code, value] of Object.entries(summary.rejectionClauses)) {
    aggregate.rejectionClauses[code] = (aggregate.rejectionClauses[code] ?? 0) + value;
  }
  const failed = summary.unsupported + summary.resultMismatch + summary.errorMismatch + summary.runnerError;
  if (failed === 0) {
    aggregate.fullyPassingFiles.push(file);
  }
}
aggregate.statementAcceptance = aggregate.statements.total > 0 ? aggregate.statements.accepted / aggregate.statements.total : 0;
aggregate.queryMatchRate = aggregate.queries.total > 0 ? aggregate.queries.matched / aggregate.queries.total : 0;

const report = {
  corpus: { url: "https://github.com/jzombie/sqlite-sqllogictest-corpus.git", commit: corpusCommit(), files },
  runners: { ts: "runner/ts/run.ts", py: "runner/py/run.py", commit: runnerCommit.status === 0 ? runnerCommit.stdout.trim() : "unknown" },
  install: { staging, tarballs: packed.map((entry) => entry.replace(/^.*[\\/]/, "")) },
  node: process.version,
  parity,
  summaries: only === "both" ? summaries : { [only]: chosen },
  aggregate,
};

if (jsonPath) {
  writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
}

console.log("file            records  pass  unsupported  result-mismatch  error-mismatch  runner-error  filtered");
for (const file of files) {
  const row = aggregate.files[file];
  if (!row) {
    continue;
  }
  console.log(
    `${file.padEnd(15)} ${String(row.records).padStart(7)} ${String(row.pass).padStart(5)} ${String(row.unsupported).padStart(12)} ${String(row.resultMismatch).padStart(16)} ${String(row.errorMismatch).padStart(14)} ${String(row.runnerError).padStart(12)} ${String(row.filtered).padStart(9)}`,
  );
}
console.log(
  `statement acceptance ${(aggregate.statementAcceptance * 100).toFixed(1)}% (${aggregate.statements.accepted}/${aggregate.statements.total})`,
);
console.log(`query match rate ${(aggregate.queryMatchRate * 100).toFixed(1)}% (${aggregate.queries.matched}/${aggregate.queries.total})`);
console.log(`fully passing files: ${aggregate.fullyPassingFiles.length > 0 ? aggregate.fullyPassingFiles.join(", ") : "none"}`);
for (const entry of parity) {
  console.log(`parity ${entry.file}: ${entry.identical ? "identical" : `differs (${entry.differing.join(", ")})`}`);
}
console.log(`staging: ${staging}`);
