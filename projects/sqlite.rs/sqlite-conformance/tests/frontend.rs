//! SQLite SQL 前端详细用例：上游 `sqlite::sql::sql::tests` 的内嵌测试整体迁移至此。
//!
//! 前端（tokenizer、AST、`parse`、参数槽位、读写判定）已归位到 `database.query::sqlite`，
//! 门面经 `sqlite::sql::*` 重导出。测试函数名保留旧身份，期望值原样搬运，不重造判定逻辑。

mod tests {
    use sqlite::sql::{BinaryOp, ColumnRef, CompareOp, Expr, Literal, SelectCore, Statement, parameter_slots, parse};

    fn filter(sql: &str) -> Expr {
        let statements = parse(sql).expect("statement parses");
        match statements.into_iter().next().expect("one statement") {
            Statement::Select { first: SelectCore { filter: Some(filter), .. }, .. } => filter,
            other => panic!("unexpected statement: {other:?}"),
        }
    }

    fn column(name: &str) -> Expr {
        Expr::Column(ColumnRef { qualifier: None, name: name.to_string() })
    }

    fn integer(value: i64) -> Expr {
        Expr::Literal(Literal::Integer(value))
    }

    /// `left >= low AND left <= high`, the lowering `BETWEEN` must produce.
    fn lowered_range(left: Expr, low: Expr, high: Expr) -> Expr {
        Expr::And(
            Box::new(Expr::Compare { left: Box::new(left.clone()), op: CompareOp::GtEq, right: Box::new(low) }),
            Box::new(Expr::Compare { left: Box::new(left), op: CompareOp::LtEq, right: Box::new(high) }),
        )
    }

    #[test]
    fn between_lowers_to_two_comparisons() {
        assert_eq!(filter("SELECT * FROM t WHERE a between 1 and 2"), lowered_range(column("a"), integer(1), integer(2)));
    }

    #[test]
    fn between_accepts_arithmetic_bounds() {
        // `c BETWEEN b-2 AND d+2` keeps both bounds as full expressions.
        let low = Expr::Binary { left: Box::new(column("b")), op: BinaryOp::Subtract, right: Box::new(integer(2)) };
        let high = Expr::Binary { left: Box::new(column("d")), op: BinaryOp::Add, right: Box::new(integer(2)) };
        assert_eq!(filter("SELECT * FROM t WHERE c BETWEEN b-2 AND d+2"), lowered_range(column("c"), low, high));
    }

    #[test]
    fn not_between_is_not_around_the_lowered_range() {
        assert_eq!(
            filter("SELECT * FROM t WHERE a NOT BETWEEN 110 AND 150"),
            Expr::Not(Box::new(lowered_range(column("a"), integer(110), integer(150))))
        );
    }

    #[test]
    fn between_keeps_the_enclosing_conjunction() {
        let expr = filter("SELECT * FROM t WHERE a BETWEEN 1 AND 2 AND b = 3");
        match expr {
            Expr::And(left, right) => {
                assert_eq!(*left, lowered_range(column("a"), integer(1), integer(2)));
                assert!(matches!(*right, Expr::Compare { op: CompareOp::Eq, .. }));
            }
            other => panic!("expected AND, found {other:?}"),
        }
    }

    #[test]
    fn between_without_separator_is_a_syntax_error() {
        let error = parse("SELECT * FROM t WHERE a BETWEEN 1 2").expect_err("missing AND");
        assert_eq!(error.code, "syntax");
        assert_eq!(error.statement, Some("select"));
    }

    #[test]
    fn parses_parenthesized_or_of_comparisons() {
        let expr = filter("SELECT * FROM t WHERE (a = b) OR (c > d)");
        match expr {
            Expr::Or(left, right) => {
                assert!(matches!(*left, Expr::Compare { op: CompareOp::Eq, .. }));
                assert!(matches!(*right, Expr::Compare { op: CompareOp::Gt, .. }));
            }
            other => panic!("expected OR of comparisons, found {other:?}"),
        }
    }

    #[test]
    fn parses_nested_grouping_under_unary_not() {
        let expr = filter("SELECT * FROM t WHERE NOT ((a = 1) OR (b < 2))");
        match expr {
            Expr::Not(inner) => assert!(matches!(*inner, Expr::Or(..))),
            other => panic!("expected NOT around a group, found {other:?}"),
        }
    }

    fn slots_of(sql: &str) -> Vec<(usize, String)> {
        let statements = parse(sql).expect("statement parses");
        let statement = statements.into_iter().next().expect("one statement");
        parameter_slots(&statement)
    }

    #[test]
    fn bare_question_marks_take_consecutive_indexes() {
        assert_eq!(slots_of("SELECT ?, ?, ?"), vec![(0, "?".to_string()), (1, "?".to_string()), (2, "?".to_string())]);
    }

    #[test]
    fn numbered_placeholders_fix_their_slot_and_later_bare_marks_follow() {
        assert_eq!(slots_of("SELECT ?2, ?"), vec![(1, "?2".to_string()), (2, "?".to_string())]);
    }

    #[test]
    fn repeated_named_placeholder_shares_one_slot() {
        assert_eq!(slots_of("SELECT :a + :a"), vec![(0, ":a".to_string())]);
    }

    #[test]
    fn insert_values_mix_literals_and_placeholders() {
        assert_eq!(slots_of("INSERT INTO t VALUES (?, :name, 'x')"), vec![(0, "?".to_string()), (1, ":name".to_string())]);
    }

    #[test]
    fn slots_are_collected_from_subqueries_and_predicates() {
        assert_eq!(
            slots_of("SELECT a FROM t WHERE b IN (SELECT c FROM u WHERE d = ?) AND e > ?"),
            vec![(0, "?".to_string()), (1, "?".to_string())]
        );
    }

    #[test]
    fn writes_classifies_statements_by_ast_kind() {
        let cases = [
            ("SELECT 1", false),
            ("PRAGMA foreign_keys = ON", false),
            ("EXPLAIN SELECT 1", false),
            ("BEGIN", false),
            ("COMMIT", false),
            ("CREATE TABLE t (a INTEGER)", true),
            ("INSERT INTO t VALUES (1)", true),
            ("UPDATE t SET a = 1", true),
            ("DELETE FROM t", true),
            ("DROP TABLE t", true),
            ("ALTER TABLE t ADD COLUMN b TEXT", true),
            ("CREATE INDEX i ON t (a)", true),
        ];
        for (sql, expected) in cases {
            let statement = parse(sql).expect("statement parses").into_iter().next().expect("one statement");
            assert_eq!(statement.writes(), expected, "writes() for {sql}");
        }
    }
}
