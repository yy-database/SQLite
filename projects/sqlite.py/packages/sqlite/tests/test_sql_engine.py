"""SQL execution acceptance against the installed `sqlite_format3` wheel.

The cases import the extension module and execute statements through it, so a
build that only exposes storage primitives cannot pass this module.
"""

import unittest

from sqlite_format3 import SqliteEngine


class SqlEngineTests(unittest.TestCase):
    def setUp(self):
        self.engine = SqliteEngine.create(4096)
        self.engine.execute("create table people (id integer primary key, name text not null, score real)")
        self.engine.execute("insert into people (name, score) values ('ada', 9.5)")
        self.engine.execute("insert into people (name) values ('bob')")

    def test_statements_are_accepted(self):
        created = self.engine.execute("create table ledger (id integer primary key, amount real)")
        self.assertEqual(created["statement"], "create-table")
        self.assertEqual(created["affected"], 1)
        inserted = self.engine.execute("insert into ledger (amount) values (2.5)")
        self.assertEqual(inserted["statement"], "insert")
        self.assertEqual(inserted["rows"], [[1]])

    def test_results_expose_columns_and_rows(self):
        selected = self.engine.execute("select * from people")
        self.assertEqual(selected["columns"], ["id", "name", "score"])
        self.assertEqual(selected["rows"], [[1, "ada", 9.5], [2, "bob", None]])
        counted = self.engine.execute("select count(*) from people")
        self.assertEqual(counted["rows"], [[2]])

    def test_where_and_order_by_execute(self):
        filtered = self.engine.execute("select name from people where score >= 9.0 order by score desc")
        self.assertEqual(filtered["rows"], [["ada"]])
        nulls = self.engine.execute("select count(*) from people where score is null")
        self.assertEqual(nulls["rows"], [[1]])

    def test_text_and_null_functions_match_oracle(self):
        selected = self.engine.execute(
            "select trim('  x  '), ltrim('  x'), rtrim('x  '), replace('abcabc', 'b', 'X'), ifnull(null, 7), nullif(1, 1)"
        )
        self.assertEqual(selected["rows"], [["x", "x", "x", "aXcaXc", 7, None]])

    def test_format_and_text_scalars_match_oracle(self):
        selected = self.engine.execute(
            "select printf('%d/%x/%#o', 42, 255, 8), printf('%.2f/%.0e', 1.005, 12345), "
            "printf('%5s|%q', 'ab', null), printf('%n%%'), printf('%y', 42), "
            "char(65, 66), unicode('ABC'), soundex('Robert')"
        )
        self.assertEqual(
            selected["rows"],
            [["42/ff/010", "1.00/1e+04", "   ab|(NULL)", "%", None, "AB", 65, "R163"]],
        )

    def test_multi_argument_min_max_follow_oracle_ties(self):
        selected = self.engine.execute(
            "select min(3, 1, 2), max(3, 1, 2), min(null, 2), "
            "typeof(min(1, 1.0)), typeof(max(1, 1.0)), typeof(min(1.0, 1)), typeof(max(1.0, 1))"
        )
        self.assertEqual(selected["rows"], [[1, 3, None, "real", "integer", "integer", "real"]])

    def test_math_scalars_match_oracle(self):
        selected = self.engine.execute(
            "select abs(-7), abs('-7'), typeof(abs('-7')), "
            "ceil(2.5), ceil(-2.5), floor('3'), trunc(-2.7), "
            "typeof(ceil(2)), typeof(trunc(2)), ceil('2abc')"
        )
        self.assertEqual(selected["rows"], [[7, 7, "real", 3, -2, 3, -2, "integer", "integer", None]])

        selected = self.engine.execute(
            "select sqrt(4), sqrt(-1), pow(2,10), pow(-1,0.5), mod(7,3), mod(-7,3), mod(7,0), "
            "exp(0), ln(1), log(100), log(2,8), log(1,100), sign(-5), sign(0), sign('abc')"
        )
        self.assertEqual(
            selected["rows"],
            [[2.0, None, 1024.0, None, 1.0, -1.0, None, 1.0, 0.0, 2.0, 3.0, None, -1, 0, None]],
        )

        selected = self.engine.execute(
            "select sin(0), cos(0), asin(1), atan2(1,1), degrees(3.141592653589793), radians(180), pi()"
        )
        self.assertEqual(
            selected["rows"],
            [[0.0, 1.0, 1.5707963267948966, 0.7853981633974483, 180.0, 3.141592653589793, 3.141592653589793]],
        )

    def test_date_time_and_strftime_match_oracle(self):
        selected = self.engine.execute(
            "select date('2024-01-02T03:04:05+05:30'), time('03:04:05.678'), time('2024-01-02'), "
            "datetime('2024-01-02 24:00:00'), datetime('2024-02-30 12:00:00')"
        )
        self.assertEqual(
            selected["rows"],
            [["2024-01-01", "03:04:05", "00:00:00", "2024-01-02 24:00:00", "2024-03-01 12:00:00"]],
        )

        selected = self.engine.execute(
            "select julianday('2024-01-02'), unixepoch('2024-01-02'), "
            "unixepoch('2024-01-02 03:04:05.678','subsec')"
        )
        self.assertEqual(selected["rows"], [[2460311.5, 1704153600, 1704164645.678]])

        selected = self.engine.execute(
            "select date('2024-01-31','+1 month'), date('2024-01-31','start of month','+1 month'), "
            "date('2024-01-02','+0.5 years'), date('2024-01-02','weekday 0'), date('2024-01-02','weekday 2')"
        )
        self.assertEqual(
            selected["rows"],
            [["2024-03-02", "2024-02-01", "2024-07-02", "2024-01-07", "2024-01-02"]],
        )

        selected = self.engine.execute(
            "select datetime('2024-01-02 03:04:05','+24:30'), datetime('2024-01-02 03:04:05','+25:00'), "
            "datetime(1700000000,'auto'), datetime('2450000','julianday')"
        )
        self.assertEqual(
            selected["rows"],
            [["2024-01-02 03:34:05", None, "2023-11-14 22:13:20", "1995-10-09 12:00:00"]],
        )

        selected = self.engine.execute(
            "select strftime('%u %w %U %W %V %G %g','2024-12-30'), "
            "strftime('%f','2024-01-02 03:04:05.678'), strftime('%J','2024-01-02'), "
            "strftime('%s','2024-01-02 03:04:05.678'), strftime('%Q','2024-01-02')"
        )
        self.assertEqual(
            selected["rows"],
            [["1 1 52 53 01 2025 25", "05.678", "2460311.5", "1704164645", None]],
        )

        selected = self.engine.execute(
            "select timediff('2024-01-02','2024-01-03'), timediff('2024-01-02 03:04:05','2024-01-02 04:04:05'), "
            "date(' 2024-01-02'), date('2024-01-02 '), date('12'), date('2024-01-02','+ 5 days')"
        )
        self.assertEqual(
            selected["rows"],
            [["-0000-00-01 00:00:00.000", "-0000-00-00 01:00:00.000", None, "2024-01-02", "-4713-12-06", None]],
        )

    def test_rejections_carry_a_code_and_clause(self):
        right_join = self.engine.try_execute("select * from people right join people as p2 on people.id = p2.id")
        self.assertIs(right_join["ok"], True)
        self.assertEqual(len(right_join["result"]["rows"]), 2)
        rejected = self.engine.try_execute("select * from people for update")
        self.assertIs(rejected["ok"], False)
        error = rejected["error"]
        self.assertEqual(error["code"], "unsupported-clause")
        self.assertEqual(error["statement"], "select")
        self.assertEqual(error["clause"], "UPDATE")
        self.assertEqual(error["position"], 25)
        unknown = self.engine.try_execute("select * from missing")
        self.assertEqual(unknown["error"]["code"], "unknown-table")


if __name__ == "__main__":
    unittest.main()
