"""`NULL` predicate acceptance: a comparison that touches SQL `NULL` is unknown.

Each case runs on its own and every failure message carries the
`three-valued-logic` tag plus the offending SQL, so a single leaked row fails
individually. Expected counts and row order come from CPython's standard
library `sqlite3`, never from this repository's implementation.
"""

import sqlite3
import unittest

from sqlite_format3 import SqliteEngine

TAG = "three-valued-logic"

SEED = [
    "create table nums (id integer primary key, label text, score real)",
    "insert into nums (label, score) values ('a', 1.5)",
]
SEED_TAIL = [
    "insert into nums (label, score) values ('b', null)",
    "insert into nums (label, score) values (null, 2.5)",
    "insert into nums (label, score) values ('d', null)",
]
SEED_ALL = SEED + SEED_TAIL

# `score` has two NULLs, `label` has one, and both columns share four rows.
COMPARISONS = [
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
]


def external(sql):
    connection = sqlite3.connect(":memory:")
    try:
        for statement in SEED_ALL:
            connection.execute(statement)
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


def seeded_engine():
    engine = SqliteEngine.create(4096)
    engine.execute_batch(SEED_ALL)
    return engine


def comparison_case(predicate):
    def case(self):
        rows = seeded_engine().execute(f"select id from nums where {predicate}")["rows"]
        self.assertEqual(
            rows,
            [],
            f"{TAG}: `where {predicate}` treated SQL NULL as TRUE, expected 0 rows but got {rows}",
        )
        self.assertEqual(
            external(f"select id from nums where {predicate}"),
            [],
            f"{TAG}: external sqlite3 agrees that `{predicate}` matches no row",
        )

    case.__name__ = "test_%s" % predicate.replace(" ", "_").replace("=", "eq").replace("<", "lt").replace(">", "gt")
    return case


class ThreeValuedLogicTests(unittest.TestCase):
    def test_not_of_unknown_comparison_stays_unknown(self):
        rows = seeded_engine().execute("select id from nums where not (score = null)")["rows"]
        self.assertEqual(rows, [], f"{TAG}: negating an unknown comparison produced rows {rows}")
        self.assertEqual(external("select id from nums where not (score = null)"), [], f"{TAG}: external sqlite3 also rejects the negation")

    def test_count_of_a_column_equals_count_star_minus_null_rows(self):
        engine = seeded_engine()
        total = engine.execute("select count(*) from nums")["rows"][0][0]
        null_scores = engine.execute("select count(*) from nums where score is null")["rows"][0][0]
        null_labels = engine.execute("select count(*) from nums where label is null")["rows"][0][0]
        expected = external("select count(*), count(score), count(label) from nums")[0]
        self.assertEqual(total - null_scores, expected[1], f"{TAG}: count(score) should be {expected[1]}, got {total - null_scores}")
        self.assertEqual(total - null_labels, expected[2], f"{TAG}: count(label) should be {expected[2]}, got {total - null_labels}")

    def test_is_null_plus_is_not_null_covers_every_row(self):
        engine = seeded_engine()
        total = engine.execute("select count(*) from nums")["rows"][0][0]
        for column in ("score", "label"):
            is_null = engine.execute(f"select count(*) from nums where {column} is null")["rows"][0][0]
            is_not_null = engine.execute(f"select count(*) from nums where {column} is not null")["rows"][0][0]
            expected = external(f"select count(*) from nums where {column} is null")[0][0]
            self.assertEqual(is_null, expected, f"{TAG}: {column} IS NULL should be {expected}, got {is_null}")
            self.assertEqual(is_null + is_not_null, total, f"{TAG}: {column} IS NULL plus IS NOT NULL should be {total}, got {is_null + is_not_null}")

    def test_order_by_places_null_first_ascending_and_last_descending(self):
        engine = seeded_engine()
        ascending = engine.execute("select id, score from nums order by score asc")["rows"]
        descending = engine.execute("select id, score from nums order by score desc")["rows"]
        self.assertIsNone(ascending[0][1], f"{TAG}: ascending order must start with the NULL rows, got {ascending}")
        self.assertIsNone(descending[-1][1], f"{TAG}: descending order must end with the NULL rows, got {descending}")
        self.assertEqual(
            ascending,
            [list(row) for row in external("select id, score from nums order by score asc")],
            f"{TAG}: ascending NULL position disagrees with external sqlite3",
        )
        self.assertEqual(
            descending,
            [list(row) for row in external("select id, score from nums order by score desc")],
            f"{TAG}: descending NULL position disagrees with external sqlite3",
        )


for predicate in COMPARISONS:
    generated = comparison_case(predicate)
    setattr(ThreeValuedLogicTests, generated.__name__, generated)


if __name__ == "__main__":
    unittest.main()
