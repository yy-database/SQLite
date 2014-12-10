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
