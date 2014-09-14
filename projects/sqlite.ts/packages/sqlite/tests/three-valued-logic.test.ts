// `NULL` predicate suite: a comparison that touches SQL `NULL` is *unknown*,
// never `TRUE`. Every case asserts on its own and every failure message carries
// the `three-valued-logic` tag plus the offending SQL, so a single leaked row
// fails individually instead of hiding inside a green aggregate.
//
// Expected counts and row order come from the external `better-sqlite3` engine,
// never from this repository's implementation.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { createEngine } from "../src/index.ts";

const TAG = "three-valued-logic";

interface ExternalStatement {
  all(...args: unknown[]): unknown[];
}

interface ExternalDatabase {
  exec(source: string): void;
  prepare(source: string): ExternalStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const BetterSqlite = require("better-sqlite3") as new (path: string) => ExternalDatabase;

const SEED = [
  "create table nums (id integer primary key, label text, score real)",
  "insert into nums (label, score) values ('a', 1.5)",
  "insert into nums (label, score) values ('b', null)",
  "insert into nums (label, score) values (null, 2.5)",
  "insert into nums (label, score) values ('d', null)",
];

// `score` has two NULLs, `label` has one, and both columns share four rows.
const COMPARISONS = [
  "score = null",
  "null = score",
  "score <> null",
  "null <> score",
  "score < null",
  "null < score",
  "score <= null",
  "null <= score",
  "score > null",
  "null > score",
  "score >= null",
  "null >= score",
];

function external(sql: string): unknown[] {
  const database = new BetterSqlite(":memory:");
  try {
    database.exec(SEED.join(";\n"));
    // `better-sqlite3` hands back row objects, so columns become a value array
    // in select order, which is the shape this engine reports.
    return database
      .prepare(sql)
      .all()
      .map((row) => Object.values(row as Record<string, unknown>));
  } finally {
    database.close();
  }
}

function engineWithNulls() {
  const engine = createEngine(4096);
  engine.executeBatch(SEED);
  return engine;
}

for (const predicate of COMPARISONS) {
  test(`${TAG}: \`where ${predicate}\` keeps SQL NULL unknown`, () => {
    const rows = engineWithNulls().execute(`select id from nums where ${predicate}`).rows;
    assert.equal(
      rows.length,
      0,
      `${TAG}: \`where ${predicate}\` treated SQL NULL as TRUE, expected 0 rows but got ${JSON.stringify(rows)}`,
    );
    assert.equal(external(`select id from nums where ${predicate}`).length, 0, `${TAG}: external sqlite3 agrees that \`${predicate}\` matches no row`);
  });
}

test(`${TAG}: \`not (score = null)\` stays unknown instead of flipping to TRUE`, () => {
  const rows = engineWithNulls().execute("select id from nums where not (score = null)").rows;
  assert.equal(rows.length, 0, `${TAG}: negating an unknown comparison produced rows ${JSON.stringify(rows)}`);
  assert.equal(external("select id from nums where not (score = null)").length, 0, `${TAG}: external sqlite3 also rejects the negation`);
});

test(`${TAG}: \`count(col)\` equals \`count(*)\` minus the NULL rows`, () => {
  const engine = engineWithNulls();
  const total = Number(engine.execute("select count(*) from nums").rows[0][0]);
  const nullScores = Number(engine.execute("select count(*) from nums where score is null").rows[0][0]);
  const nullLabels = Number(engine.execute("select count(*) from nums where label is null").rows[0][0]);
  const expected = external("select count(*), count(score), count(label) from nums")[0] as number[];

  assert.equal(total - nullScores, expected[1], `${TAG}: count(score) should be ${expected[1]}, got ${total - nullScores}`);
  assert.equal(total - nullLabels, expected[2], `${TAG}: count(label) should be ${expected[2]}, got ${total - nullLabels}`);
});

test(`${TAG}: IS NULL plus IS NOT NULL covers every row`, () => {
  const engine = engineWithNulls();
  const total = Number(engine.execute("select count(*) from nums").rows[0][0]);
  for (const column of ["score", "label"]) {
    const isNull = Number(engine.execute(`select count(*) from nums where ${column} is null`).rows[0][0]);
    const isNotNull = Number(engine.execute(`select count(*) from nums where ${column} is not null`).rows[0][0]);
    const expected = external(`select count(*) from nums where ${column} is null`)[0] as number[];
    assert.equal(isNull, Number(expected[0]), `${TAG}: ${column} IS NULL should be ${expected[0]}, got ${isNull}`);
    assert.equal(isNull + isNotNull, total, `${TAG}: ${column} IS NULL plus IS NOT NULL should be ${total}, got ${isNull + isNotNull}`);
  }
});

test(`${TAG}: ORDER BY places NULL first ascending and last descending`, () => {
  const engine = engineWithNulls();
  const ascending = engine.execute("select id, score from nums order by score asc").rows;
  const descending = engine.execute("select id, score from nums order by score desc").rows;

  assert.equal(ascending[0][1], null, `${TAG}: ascending order must start with the NULL rows, got ${JSON.stringify(ascending)}`);
  assert.equal(descending[descending.length - 1][1], null, `${TAG}: descending order must end with the NULL rows, got ${JSON.stringify(descending)}`);
  assert.equal(JSON.stringify(ascending), JSON.stringify(external("select id, score from nums order by score asc")), `${TAG}: ascending NULL position disagrees with external sqlite3`);
  assert.equal(JSON.stringify(descending), JSON.stringify(external("select id, score from nums order by score desc")), `${TAG}: descending NULL position disagrees with external sqlite3`);
});
