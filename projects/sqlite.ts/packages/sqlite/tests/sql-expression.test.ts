import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "../src/index.ts";

function scalarEngine(): ReturnType<typeof createEngine> {
  const engine = createEngine();
  engine.exec(
    "create table v (id integer primary key, a integer, b integer, c real, s text); \
     insert into v (a, b, c, s) values (7, 2, 1.5, 'AbC'); \
     insert into v (a, b, c, s) values (-7, 0, null, 'xyz'); \
     insert into v (a, b, c, s) values (null, 4, 3.0, null);",
  );
  return engine;
}

test("projection arithmetic follows SQLite integer and overflow rules", () => {
  const engine = scalarEngine();

  const arithmetic = engine.execute("select a+b, a-b, a*b, a/b from v where id = 1");
  assert.deepEqual(arithmetic.columns, ["a+b", "a-b", "a*b", "a/b"]);
  assert.deepEqual(arithmetic.rows, [[9, 5, 14, 3]]);

  // Integer division truncates toward zero instead of producing a real.
  assert.deepEqual(engine.execute("select -7/2 from v where id = 1").rows, [[-3]]);

  // Grouping and a prefix minus, including a mixed integer/real sum.
  assert.deepEqual(engine.execute("select (a+b)*2, -a, a+c from v where id = 1").rows, [[18, -7, 8.5]]);

  // Integer overflow falls back to a real.
  assert.deepEqual(engine.execute("select typeof(9223372036854775807 + 1) from v where id = 1").rows, [["real"]]);

  // Division by zero is NULL, not an error and not a zero.
  assert.deepEqual(engine.execute("select a/b from v where id = 3").rows, [[null]]);

  // NULL in any arithmetic operand propagates.
  assert.deepEqual(engine.execute("select a+b, a*b from v where id = 3").rows, [[null, null]]);

  // Comparisons used as projection values yield 1/0/NULL.
  assert.deepEqual(engine.execute("select a>b from v where id = 1").rows, [[1]]);
  assert.deepEqual(engine.execute("select a>b from v where id = 3").rows, [[null]]);
  assert.deepEqual(engine.execute("select a = null from v where id = 1").rows, [[null]]);
  assert.deepEqual(engine.execute("select null = null from v where id = 1").rows, [[null]]);
});

test("scalar functions cover the supported set and reject bad arity", () => {
  const engine = scalarEngine();

  assert.deepEqual(engine.execute("select abs(a), abs(b), abs(c) from v where id = 2").rows, [[7, 0, null]]);
  assert.deepEqual(engine.execute("select coalesce(null, a, b, c, s), coalesce(s, 'fallback') from v where id = 3").rows, [
    [4, "fallback"],
  ]);
  assert.deepEqual(engine.execute("select length(s), length(a), length(null) from v where id = 1").rows, [[3, 1, null]]);
  assert.deepEqual(engine.execute("select typeof(a), typeof(c), typeof(s) from v where id = 1").rows, [
    ["integer", "real", "text"],
  ]);
  assert.deepEqual(engine.execute("select typeof(a) from v where id = 3").rows, [["null"]]);
  assert.deepEqual(engine.execute("select lower(s), upper(s) from v where id = 1").rows, [["abc", "ABC"]]);
  assert.deepEqual(engine.execute("select substr(s, 2, 2), substr(s, -2), substr(s, 3) from v where id = 1").rows, [
    ["bC", "bC", "C"],
  ]);
  assert.deepEqual(engine.execute("select round(c), round(1.2345, 2), round(7) from v where id = 1").rows, [
    [2, 1.23, 7],
  ]);

  const badArity = engine.tryExecute("select abs(1, 2) from v");
  assert.equal(badArity.ok, false);
  assert.equal(badArity.error?.code, "wrong-arguments");
  assert.match(badArity.error?.message ?? "", /wrong number of arguments to function abs\(\)/);

  const missing = engine.tryExecute("select nosuch(a) from v");
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "unknown-function");
  assert.match(missing.error?.message ?? "", /no such function: nosuch/);

  const aggregate = engine.tryExecute("select avg(a) from v");
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.error?.code, "unsupported-clause");
  assert.equal(aggregate.error?.clause, "AVG");

  assert.deepEqual(engine.execute("select count(*) from v").rows, [[3]]);
});

test("CASE supports searched, simple and missing-ELSE forms", () => {
  const engine = scalarEngine();

  const searched = engine.execute(
    "select case when a > 0 then 'pos' when a < 0 then 'neg' else 'unknown' end from v order by id",
  );
  assert.deepEqual(searched.rows, [["pos"], ["neg"], ["unknown"]]);

  // The simple form compares the operand with each WHEN value.
  const simple = engine.execute("select case b when 2 then 'two' when 0 then 'zero' end from v order by id");
  assert.deepEqual(simple.rows, [["two"], ["zero"], [null]]);

  // A NULL operand never equals a WHEN value, so ELSE (or NULL) applies.
  assert.deepEqual(engine.execute("select case a when null then 'n' else 'e' end from v where id = 3").rows, [["e"]]);

  // The same evaluator serves WHERE.
  assert.deepEqual(engine.execute("select id from v where case when a is null then 1 else 0 end = 1").rows, [[3]]);
});

test("IN and NOT IN keep SQL three-valued NULL semantics", () => {
  const engine = scalarEngine();

  // A miss with a NULL candidate is unknown, not false.
  assert.deepEqual(engine.execute("select 5 in (1, 2, null) from v where id = 1").rows, [[null]]);
  // A hit wins even when a later candidate is NULL.
  assert.deepEqual(engine.execute("select 1 in (1, 2, null) from v where id = 1").rows, [[1]]);
  // A NULL probe is always unknown.
  assert.deepEqual(engine.execute("select null in (1, 2) from v where id = 1").rows, [[null]]);
  // NOT IN negates the hit but preserves unknown.
  assert.deepEqual(engine.execute("select 5 not in (1, 2, null) from v where id = 1").rows, [[null]]);
  assert.deepEqual(engine.execute("select 5 not in (1, 2) from v where id = 1").rows, [[1]]);

  // Column probes: 7 matches, -7 misses, NULL is unknown.
  assert.deepEqual(engine.execute("select a in (7, 9) from v order by id").rows, [[1], [0], [null]]);

  // WHERE must discard unknown rows: a NULL a is neither IN nor NOT IN.
  assert.deepEqual(engine.execute("select id from v where a in (7)").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from v where a not in (7)").rows, [[2]]);

  assert.deepEqual(engine.execute("select id from v where a in (7, null)").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from v where a not in (7, null)").rows, []);
});

test("three-valued logic is independent of NULL-as-boolean shortcuts", () => {
  const engine = scalarEngine();

  // AND: the NULL row must stay unknown, never collapse to false.
  assert.deepEqual(engine.execute("select a < 0 and a is null from v order by id").rows, [[0], [0], [null]]);
  // OR: true wins over unknown.
  assert.deepEqual(engine.execute("select a < 0 or a is null from v order by id").rows, [[0], [1], [1]]);
  // NOT: unknown stays unknown.
  assert.deepEqual(engine.execute("select not (a < 0) from v order by id").rows, [[1], [0], [null]]);

  // WHERE must filter unknown, not treat it as true or false.
  assert.deepEqual(engine.execute("select id from v where not (a < 0)").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from v where a < 0 or a is null").rows, [[2], [3]]);

  // A neat in the predicate keeps the NULL row out even though the other
  // conjunct would be true for it.
  assert.deepEqual(engine.execute("select id from v where a is null and a in (7)").rows, []);
});

test("ORDER BY reuses the evaluator and accepts output ordinals", () => {
  const engine = scalarEngine();

  // Expression key, descending.
  assert.deepEqual(engine.execute("select a+b from v where id < 3 order by a+b desc").rows, [[9], [-7]]);
  // Ordinal key points at the second output column.
  assert.deepEqual(engine.execute("select a+b, a-b from v where id < 3 order by 2 desc").rows, [
    [9, 5],
    [-7, -7],
  ]);
  // NULL sorts lowest, so DESC puts it last.
  assert.deepEqual(engine.execute("select id, a from v order by a desc").rows, [
    [1, 7],
    [2, -7],
    [3, null],
  ]);

  const outOfRange = engine.tryExecute("select a from v order by 2");
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error?.code, "order-term-out-of-range");
  assert.match(outOfRange.error?.message ?? "", /ORDER BY term out of range/);
});
