//! SQLite 引擎详细正确性矩阵：上游门面 `sqlite::sql::engine::tests` 的内嵌测试整体迁移至此。
//!
//! 测试函数名保留旧身份（旧路径 `sqlite::sql::engine::tests::<名称>`）。唯一未迁移的是
//! `integral_real_keys_match_their_literal_forms`：它读取 `Engine` 的私有字段 `index_probes`，
//! 暂时只能留在上游 src。期望值原样搬运，不重造判定逻辑。

mod tests {
    use sqlite::{
        Cell, Collation, Engine, HostFunctionHandle, HostMicroDefinition, HostRuntimeAdapter, SchemaObjectKind, SqliteWriter,
        TableLimits, UdfError, UdfResult, UdfType, UdfValue, read_freelist_count, read_index_table_with, read_schema,
    };
    use std::sync::Arc;

    #[test]
    fn from_writer_reopens_an_existing_image() {
        let path = std::env::temp_dir().join(format!("sqlite-engine-reopen-{}.db", std::process::id()));
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_batch(&[
                "CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT)".to_string(),
                "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))".to_string(),
                "CREATE INDEX child_parent ON child(parent_id)".to_string(),
                "INSERT INTO parent (id, name) VALUES (1, 'ada')".to_string(),
                "INSERT INTO child (id, parent_id) VALUES (1, 1)".to_string(),
            ])
            .expect("seed image");
        let image = engine.snapshot().expect("image").to_vec();
        std::fs::write(&path, &image).expect("write image");
        drop(engine);

        let writer = SqliteWriter::open(&path).expect("open image");
        let mut reopened = Engine::from_writer(writer).expect("rebuild catalog");
        assert_eq!(
            reopened.execute_one("SELECT id, name FROM parent").expect("parent read").rows,
            vec![vec![Cell::Integer(1), Cell::Text("ada".to_string())]]
        );
        assert_eq!(reopened.execute_one("SELECT count(*) FROM child").expect("child read").rows, vec![vec![Cell::Integer(1)]]);
        // The rebuilt catalog still carries the foreign key, so an orphan is
        // rejected exactly as before the file was closed.
        assert_eq!(
            reopened.execute_one("INSERT INTO child (id, parent_id) VALUES (2, 9)").expect_err("orphan insert").message,
            "FOREIGN KEY constraint failed"
        );
        // Reading a reopened image never rewrites it.
        assert_eq!(reopened.snapshot().expect("image"), image.as_slice());
        std::fs::remove_file(&path).expect("cleanup image");
    }

    /// `DISTINCT` 聚合参数必须使用参数表达式的生效排序规则，而不是二进制比较。
    #[test]
    fn aggregate_distinct_honours_argument_collation() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_batch(&[
                "CREATE TABLE t(s TEXT COLLATE NOCASE)".to_string(),
                "INSERT INTO t VALUES ('a'), ('A'), ('b'), ('B')".to_string(),
            ])
            .expect("seed image");
        let result = engine.execute_one("SELECT count(DISTINCT s), count(s) FROM t").expect("aggregate executes");
        assert_eq!(result.rows, vec![vec![Cell::Integer(2), Cell::Integer(4)]]);
        let joined = engine.execute_one("SELECT group_concat(DISTINCT s) FROM t").expect("group_concat executes");
        assert_eq!(joined.rows, vec![vec![Cell::Text("a,b".to_string())]]);
    }

    /// `PRAGMA integrity_check` walks the image rather than echoing a fixed
    /// answer, so it has to stay `ok` across tables, indexes and freed pages.
    #[test]
    fn integrity_check_reports_ok_for_an_image_with_a_freelist() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_batch(&[
                "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT UNIQUE)".to_string(),
                "CREATE INDEX t_b ON t(b)".to_string(),
                "INSERT INTO t VALUES (1, 'x'), (2, 'y')".to_string(),
                "CREATE TABLE dropped(z TEXT)".to_string(),
                "INSERT INTO dropped VALUES ('z')".to_string(),
                "DROP TABLE dropped".to_string(),
            ])
            .expect("seed image");
        let result = engine.execute_one("PRAGMA integrity_check").expect("check executes");
        assert_eq!(result.columns, vec!["integrity_check".to_string()]);
        assert_eq!(result.rows, vec![vec![Cell::Text("ok".to_string())]]);
    }

    /// 全表 `UPDATE` 会为每一行走一次删除加插入。删除留下的空洞由
    /// `take_freeblock` 复用，剩余 1 到 3 字节记为页内碎片。多轮之后页头
    /// 的 `nFrag`、指针数组与 cell content 边界必须仍然自洽，否则读取侧
    /// 会报 “b-tree header invalid”。
    #[test]
    fn repeated_full_table_updates_keep_the_btree_valid() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT)").expect("create table");
        for id in 1..=400 {
            engine.execute_one(&format!("INSERT INTO t VALUES ({id}, 'aa')")).expect("insert row");
        }
        for round in 0..60u32 {
            engine.execute_one("UPDATE t SET s = CASE WHEN s = 'aa' THEN 'a' ELSE 'aa' END").expect("update row");
            let check = engine.execute_one("PRAGMA integrity_check").expect("check executes");
            assert_eq!(check.rows, vec![vec![Cell::Text("ok".to_string())]], "integrity broke on round {round}");
        }
        let rows = engine.execute_one("SELECT id, s FROM t WHERE id <= 5").expect("read rows");
        assert_eq!(
            rows.rows,
            vec![
                vec![Cell::Integer(1), Cell::Text("aa".to_string())],
                vec![Cell::Integer(2), Cell::Text("aa".to_string())],
                vec![Cell::Integer(3), Cell::Text("aa".to_string())],
                vec![Cell::Integer(4), Cell::Text("aa".to_string())],
                vec![Cell::Integer(5), Cell::Text("aa".to_string())],
            ]
        );
    }

    /// `EXPLAIN` reports the engine's own steps, `EXPLAIN QUERY PLAN` reports
    /// the accesses that will run, and neither executes the statement.
    #[test]
    fn explain_reports_a_program_and_a_scan_plan_without_executing() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_batch(&["CREATE TABLE t(a, b)".to_string(), "INSERT INTO t VALUES (1, 'x')".to_string()])
            .expect("seed image");
        let program = engine.execute_one("EXPLAIN SELECT a FROM t WHERE b = 'x'").expect("explain executes");
        assert_eq!(
            program.columns,
            vec![
                "addr".to_string(),
                "opcode".to_string(),
                "p1".to_string(),
                "p2".to_string(),
                "p3".to_string(),
                "p4".to_string(),
                "p5".to_string(),
                "comment".to_string(),
            ]
        );
        assert!(program.rows.iter().any(|row| matches!(&row[1], Cell::Text(opcode) if opcode == "OpenRead")));

        let plan = engine.execute_one("EXPLAIN QUERY PLAN SELECT a FROM t WHERE b = 'x'").expect("plan executes");
        assert_eq!(plan.columns, vec!["id".to_string(), "parent".to_string(), "notused".to_string(), "detail".to_string()]);
        assert_eq!(
            plan.rows,
            vec![vec![Cell::Integer(1), Cell::Integer(0), Cell::Integer(0), Cell::Text("SCAN t".to_string())]]
        );

        engine.execute_one("EXPLAIN INSERT INTO t VALUES (2, 'y')").expect("explain insert");
        let count = engine.execute_one("SELECT count(*) FROM t").expect("count");
        assert_eq!(count.rows[0][0], Cell::Integer(1));
    }

    /// `EXPLAIN` still rejects a source table that does not exist.
    #[test]
    fn explain_rejects_a_missing_source_table() {
        let mut engine = Engine::new(None).expect("blank engine");
        let error = engine.execute_one("EXPLAIN SELECT * FROM nope").expect_err("missing table");
        assert!(error.to_string().contains("no such table: nope"), "unexpected error: {error}");
    }

    /// Two-column table with one all-`NULL` row, inserted in rowid order.
    fn engine() -> Engine {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER, b INTEGER)").expect("create table");
        engine.execute_one("INSERT INTO t VALUES (1, 1), (2, 2), (3, 3), (NULL, NULL), (5, 0)").expect("insert rows");
        engine
    }

    /// First column of every row the predicate keeps, in rowid order.
    fn first_column(sql: &str) -> Vec<Cell> {
        let mut engine = engine();
        let result = engine.execute_one(sql).expect("select executes");
        result.rows.into_iter().map(|mut row| row.remove(0)).collect()
    }

    #[test]
    fn between_includes_both_bounds() {
        assert_eq!(
            first_column("SELECT a FROM t WHERE a BETWEEN 1 AND 3"),
            vec![Cell::Integer(1), Cell::Integer(2), Cell::Integer(3)]
        );
    }

    #[test]
    fn between_accepts_arithmetic_bounds() {
        assert_eq!(
            first_column("SELECT a FROM t WHERE a BETWEEN b - 2 AND b + 2"),
            vec![Cell::Integer(1), Cell::Integer(2), Cell::Integer(3)]
        );
    }

    #[test]
    fn not_between_excludes_the_range_and_keeps_nulls_out() {
        assert_eq!(first_column("SELECT a FROM t WHERE a NOT BETWEEN 1 AND 3"), vec![Cell::Integer(5)]);
    }

    #[test]
    fn between_with_a_null_bound_follows_and_semantics() {
        // A `NULL` bound leaves the test unknown unless the other bound is
        // already false, exactly like `>= ... AND <= ...`.
        assert_eq!(
            first_column("SELECT a FROM t WHERE a BETWEEN b AND 3"),
            vec![Cell::Integer(1), Cell::Integer(2), Cell::Integer(3)]
        );
        assert_eq!(first_column("SELECT a FROM t WHERE a NOT BETWEEN b AND 3"), vec![Cell::Integer(5)]);
        assert_eq!(first_column("SELECT a FROM t WHERE a NOT BETWEEN NULL AND 3"), vec![Cell::Integer(5)]);
        assert_eq!(first_column("SELECT a FROM t WHERE a BETWEEN NULL AND 3"), Vec::<Cell>::new());
    }

    #[test]
    fn not_of_a_null_comparison_stays_null() {
        // The `NULL` row makes `a = 1` unknown, and `NOT unknown` is still
        // unknown, so it is never returned.
        assert_eq!(
            first_column("SELECT a FROM t WHERE NOT (a = 1)"),
            vec![Cell::Integer(2), Cell::Integer(3), Cell::Integer(5)]
        );
    }

    #[test]
    fn like_matches_sqlite() {
        let mut engine = Engine::new(None).expect("blank engine");
        let like = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("like query").rows[0][0].clone();
        assert_eq!(like(&mut engine, "SELECT 'abc' LIKE 'A%'"), Cell::Integer(1));
        // Only ASCII letters fold case.
        assert_eq!(like(&mut engine, "SELECT 'Ü' LIKE 'ü'"), Cell::Integer(0));
        assert_eq!(like(&mut engine, "SELECT 'ü' LIKE 'Ü'"), Cell::Integer(0));
        assert_eq!(like(&mut engine, "SELECT 'ab' LIKE 'a_'"), Cell::Integer(1));
        assert_eq!(like(&mut engine, "SELECT 'abc' LIKE 'a_'"), Cell::Integer(0));
        assert_eq!(like(&mut engine, "SELECT '' LIKE '%'"), Cell::Integer(1));
        assert_eq!(like(&mut engine, "SELECT '' LIKE ''"), Cell::Integer(1));
        assert_eq!(like(&mut engine, "SELECT NULL LIKE 'a%'"), Cell::Null);
        assert_eq!(like(&mut engine, "SELECT 'x' LIKE NULL"), Cell::Null);
        assert_eq!(like(&mut engine, "SELECT 'x' NOT LIKE 'a%'"), Cell::Integer(1));
        assert_eq!(like(&mut engine, "SELECT 'abc' NOT LIKE 'a%'"), Cell::Integer(0));
        assert_eq!(like(&mut engine, "SELECT 1 LIKE '1'"), Cell::Integer(1));
        // `ESCAPE` quotes the next wildcard character.
        assert_eq!(like(&mut engine, "SELECT 'a%b' LIKE 'a\\%b' ESCAPE '\\'"), Cell::Integer(1));
        assert_eq!(like(&mut engine, "SELECT 'axb' LIKE 'a\\%b' ESCAPE '\\'"), Cell::Integer(0));
        assert_eq!(like(&mut engine, "SELECT 'a_b' LIKE 'a\\_b' ESCAPE '\\'"), Cell::Integer(1));
    }

    #[test]
    fn cast_follows_sqlite_conversions() {
        let mut engine = Engine::new(None).expect("blank engine");
        // Text to integer keeps the leading integer prefix; `1e3` has none
        // beyond `1`, and a value without digits converts to zero.
        assert_eq!(
            engine.execute_one("SELECT CAST('1.5' AS INTEGER)").expect("text integer").rows,
            vec![vec![Cell::Integer(1)]]
        );
        assert_eq!(
            engine.execute_one("SELECT CAST('abc' AS INTEGER)").expect("text without digits").rows,
            vec![vec![Cell::Integer(0)]]
        );
        assert_eq!(
            engine.execute_one("SELECT CAST('1e3' AS INTEGER)").expect("exponent text").rows,
            vec![vec![Cell::Integer(1)]]
        );
        assert_eq!(
            engine.execute_one("SELECT CAST(' 12abc' AS INTEGER)").expect("padded text").rows,
            vec![vec![Cell::Integer(12)]]
        );
        // Real to integer truncates toward zero rather than rounding.
        assert_eq!(engine.execute_one("SELECT CAST(1.9 AS INTEGER)").expect("real integer").rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(
            engine.execute_one("SELECT CAST(-1.9 AS INTEGER)").expect("negative real integer").rows,
            vec![vec![Cell::Integer(-1)]]
        );
        assert_eq!(engine.execute_one("SELECT CAST('3.7' AS REAL)").expect("text real").rows, vec![vec![Cell::Real(3.7)]]);
        // `NULL` stays `NULL` through any cast.
        assert_eq!(engine.execute_one("SELECT CAST(NULL AS INTEGER)").expect("null integer").rows, vec![vec![Cell::Null]]);
        assert_eq!(
            engine.execute_one("SELECT CAST(1 AS TEXT)").expect("integer text").rows,
            vec![vec![Cell::Text("1".to_string())]]
        );
        // A blob cast takes the UTF-8 bytes of the text form.
        assert_eq!(
            engine.execute_one("SELECT CAST(123 AS BLOB)").expect("integer blob").rows,
            vec![vec![Cell::Blob(b"123".to_vec())]]
        );
        // Numeric keeps an integral value as an integer.
        assert_eq!(
            engine.execute_one("SELECT CAST('1e3' AS NUMERIC)").expect("numeric text").rows,
            vec![vec![Cell::Integer(1000)]]
        );
        let unsupported = engine.execute_one("SELECT CAST(1 AS FANCYTYPE)").expect_err("unknown target type");
        assert_eq!(unsupported.code, "unsupported-type");
    }

    #[test]
    fn parenthesized_disjunction_keeps_both_branches() {
        assert_eq!(first_column("SELECT a FROM t WHERE (a = 1) OR (a > 3)"), vec![Cell::Integer(1), Cell::Integer(5)]);
        assert_eq!(
            first_column("SELECT a FROM t WHERE (a = 1 OR a = 2) AND b IS NOT NULL"),
            vec![Cell::Integer(1), Cell::Integer(2)]
        );
    }

    #[test]
    fn negative_limit_means_no_upper_bound() {
        // SQLite: a negative `LIMIT` returns every row, while `-0` returns none.
        assert_eq!(
            first_column("SELECT a FROM t LIMIT -2"),
            vec![Cell::Integer(1), Cell::Integer(2), Cell::Integer(3), Cell::Null, Cell::Integer(5)]
        );
        assert_eq!(first_column("SELECT a FROM t LIMIT -0"), Vec::<Cell>::new());
    }

    #[test]
    fn limit_placeholders_take_bound_values() {
        let mut engine = engine();
        let bound = engine
            .execute_with_parameters("SELECT a FROM t LIMIT ? OFFSET ?", &[Cell::Integer(2), Cell::Integer(1)])
            .expect("positional limit");
        assert_eq!(bound[0].rows, vec![vec![Cell::Integer(2)], vec![Cell::Integer(3)]]);
        let named = engine.execute_with_parameters("SELECT a FROM t LIMIT :n", &[Cell::Integer(2)]).expect("named limit");
        assert_eq!(named[0].rows, vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]);
        // Negative values clamp like SQLite: no upper bound, no skipped rows.
        let unlimited =
            engine.execute_with_parameters("SELECT a FROM t LIMIT ?", &[Cell::Integer(-1)]).expect("negative limit");
        assert_eq!(unlimited[0].rows.len(), 5);
        let offset =
            engine.execute_with_parameters("SELECT a FROM t LIMIT 2 OFFSET ?", &[Cell::Integer(-1)]).expect("negative offset");
        assert_eq!(offset[0].rows, vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]);
        let oversized =
            engine.execute_with_parameters("SELECT a FROM t LIMIT ?", &[Cell::Integer(999)]).expect("oversized limit");
        assert_eq!(oversized[0].rows.len(), 5);
        // An unbound placeholder is NULL, which SQLite rejects as a limit.
        assert_eq!(engine.execute_one("SELECT a FROM t LIMIT ?").expect_err("unbound").code, "datatype-mismatch");
    }

    #[test]
    fn first_value_frame_clamps_to_the_partition() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE f(a INTEGER); INSERT INTO f VALUES (1), (2), (3);").expect("seed");
        let results = engine
            .execute_one(
                "SELECT a, first_value(a) OVER (ORDER BY a ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM f ORDER BY a",
            )
            .expect("frame");
        assert_eq!(
            results.rows,
            vec![
                vec![Cell::Integer(1), Cell::Integer(1)],
                vec![Cell::Integer(2), Cell::Integer(1)],
                vec![Cell::Integer(3), Cell::Integer(2)],
            ]
        );
    }

    #[test]
    fn implicit_rowid_aliases_resolve() {
        let mut engine = engine();
        let result = engine.execute_one("SELECT rowid, _rowid_, oid FROM t").expect("rowid aliases resolve");
        assert_eq!(result.columns, vec!["rowid".to_string(), "_rowid_".to_string(), "oid".to_string()]);
        assert_eq!(result.rows[0], vec![Cell::Integer(1), Cell::Integer(1), Cell::Integer(1)]);
        assert_eq!(result.rows[4], vec![Cell::Integer(5), Cell::Integer(5), Cell::Integer(5)]);
        // `SELECT *` never exposes the hidden rowid slot.
        let star = engine.execute_one("SELECT * FROM t").expect("star runs");
        assert_eq!(star.columns.len(), 2);
    }

    #[test]
    fn compound_select_folds_left_to_right() {
        // SQLite gives every set operator the same precedence: `(A UNION B)
        // INTERSECT C` returns `3`, while `A UNION (B INTERSECT C)` would
        // return `1, 2, 3`.
        assert_eq!(
            first_column(
                "SELECT a FROM t WHERE a <= 2 UNION SELECT a FROM t WHERE a >= 2 INTERSECT SELECT a FROM t WHERE a = 3"
            ),
            vec![Cell::Integer(3)]
        );
    }

    #[test]
    fn select_without_from_projects_literals() {
        let mut engine = Engine::new(None).expect("blank engine");
        assert_eq!(engine.execute_one("SELECT 1").expect("constant select").rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(
            engine.execute_one("SELECT 1, 2 + 3").expect("two constants").rows,
            vec![vec![Cell::Integer(1), Cell::Integer(5)]]
        );
        let aliased = engine.execute_one("SELECT 1 AS a").expect("aliased constant");
        assert_eq!(aliased.columns, vec!["a".to_string()]);
        // `LIMIT` applies to a constant projection too; a negative limit means
        // every row while `-0` still truncates to none.
        assert_eq!(engine.execute_one("SELECT 1 LIMIT 0").expect("zero limit").rows.len(), 0);
        assert_eq!(engine.execute_one("SELECT 1 LIMIT -1").expect("negative limit").rows.len(), 1);
    }

    #[test]
    fn select_without_from_rejects_column_references() {
        let mut engine = Engine::new(None).expect("blank engine");
        // SQLite reports `no such column`; a column name must never resolve to
        // `NULL` just because the projection has no `FROM` clause.
        let error = engine.execute_one("SELECT a").expect_err("no FROM has no columns");
        assert_eq!(error.code, "unknown-column");
        assert!(error.message.contains("unknown column"), "message: {}", error.message);
        assert_eq!(engine.execute_one("SELECT a AS x").expect_err("aliased column").code, "unknown-column");
        // `*` without `FROM` is a different rejection: there are no tables.
        let star = engine.execute_one("SELECT *").expect_err("star needs a table");
        assert_eq!(star.code, "no-tables");
    }

    #[test]
    fn compound_without_from_matches_sqlite() {
        let mut engine = Engine::new(None).expect("blank engine");
        assert_eq!(
            engine.execute_one("SELECT 1 UNION SELECT 2").expect("union").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]
        );
        assert_eq!(engine.execute_one("SELECT 1 UNION ALL SELECT 1").expect("union all").rows.len(), 2);
        assert_eq!(engine.execute_one("SELECT 1 INTERSECT SELECT 1").expect("intersect").rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(engine.execute_one("SELECT 1 EXCEPT SELECT 2").expect("except").rows, vec![vec![Cell::Integer(1)]]);
        // Every set operator shares one precedence and folds left to right:
        // `(1 UNION 2) INTERSECT 2` keeps `2` only.
        assert_eq!(
            engine.execute_one("SELECT 1 UNION SELECT 2 INTERSECT SELECT 2").expect("left-to-right chain").rows,
            vec![vec![Cell::Integer(2)]]
        );
        // SQLite only accepts `ALL` after `UNION`.
        assert!(engine.execute_one("SELECT 1 INTERSECT ALL SELECT 1").is_err());
        assert!(engine.execute_one("SELECT 1 EXCEPT ALL SELECT 1").is_err());
    }

    #[test]
    fn derived_table_without_alias_projects_its_row() {
        let mut engine = Engine::new(None).expect("blank engine");
        let result = engine.execute_one("SELECT * FROM (SELECT 1)").expect("derived table");
        assert_eq!(result.rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(engine.execute_one("SELECT 1 FROM (SELECT 1)").expect("derived with constant").rows.len(), 1);
    }

    #[test]
    fn text_primary_key_keeps_the_table_as_a_rowid_table() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE tp(k TEXT PRIMARY KEY, v INTEGER)").expect("text primary key");
        engine.execute_one("INSERT INTO tp VALUES ('a', 1), ('b', 2)").expect("insert text keys");
        assert_eq!(
            engine.execute_one("SELECT k, v FROM tp").expect("select text keys").rows,
            vec![vec![Cell::Text("a".to_string()), Cell::Integer(1)], vec![Cell::Text("b".to_string()), Cell::Integer(2)]]
        );
        // The key is an automatic unique index, not the rowid.
        assert_eq!(
            engine.execute_one("SELECT rowid FROM tp").expect("rowid").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]
        );
        let error = engine.execute_one("INSERT INTO tp VALUES ('a', 3)").expect_err("duplicate text key");
        assert_eq!(error.code, "unique-constraint");
    }

    #[test]
    fn table_level_primary_key_supports_composite_keys() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE pkab(a INTEGER, b INTEGER, PRIMARY KEY (a, b))").expect("composite key");
        engine.execute_one("INSERT INTO pkab VALUES (1, 1), (2, 2)").expect("insert composite keys");
        assert_eq!(
            engine.execute_one("SELECT a, b FROM pkab").expect("select composite keys").rows,
            vec![vec![Cell::Integer(1), Cell::Integer(1)], vec![Cell::Integer(2), Cell::Integer(2)]]
        );
        let error = engine.execute_one("INSERT INTO pkab VALUES (1, 1)").expect_err("duplicate composite key");
        assert_eq!(error.code, "unique-constraint");
        // A lone declared INTEGER key is still the rowid alias.
        engine.execute_one("CREATE TABLE ta(a INTEGER, PRIMARY KEY (a))").expect("alias key");
        engine.execute_one("INSERT INTO ta VALUES (5)").expect("insert alias");
        assert_eq!(
            engine.execute_one("SELECT rowid, a FROM ta").expect("alias rowid").rows,
            vec![vec![Cell::Integer(5), Cell::Integer(5)]]
        );
        let empty = engine.execute_one("CREATE TABLE pkx(a INTEGER, b INTEGER, PRIMARY KEY (a))").expect("qualified key");
        assert_eq!(empty.affected, 1);
    }

    #[test]
    fn is_truth_uses_sqlite_truthiness_and_never_returns_null() {
        let mut engine = Engine::new(None).expect("blank engine");
        let truth = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("truth query").rows[0][0].clone();
        // `IS TRUE` is truthiness, not equality with 1: any non-zero number matches.
        assert_eq!(truth(&mut engine, "SELECT 1 IS TRUE"), Cell::Integer(1));
        assert_eq!(truth(&mut engine, "SELECT 2 IS TRUE"), Cell::Integer(1));
        assert_eq!(truth(&mut engine, "SELECT -1 IS TRUE"), Cell::Integer(1));
        assert_eq!(truth(&mut engine, "SELECT 0 IS TRUE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT 0.5 IS TRUE"), Cell::Integer(1));
        assert_eq!(truth(&mut engine, "SELECT 0.0 IS TRUE"), Cell::Integer(0));
        // Text converts numerically; non-numeric text and blobs are false.
        assert_eq!(truth(&mut engine, "SELECT '1' IS TRUE"), Cell::Integer(1));
        assert_eq!(truth(&mut engine, "SELECT '0' IS TRUE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT '' IS TRUE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT 'a' IS TRUE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT x'01' IS TRUE"), Cell::Integer(0));
        // `IS FALSE` is the negation of the truthiness test.
        assert_eq!(truth(&mut engine, "SELECT 1 IS FALSE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT 2 IS FALSE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT 0 IS FALSE"), Cell::Integer(1));
        // Neither `IS TRUE` nor `IS FALSE` is ever NULL; `IS NOT ...` just flips it.
        assert_eq!(truth(&mut engine, "SELECT NULL IS TRUE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT NULL IS NOT TRUE"), Cell::Integer(1));
        assert_eq!(truth(&mut engine, "SELECT NULL IS FALSE"), Cell::Integer(0));
        assert_eq!(truth(&mut engine, "SELECT NULL IS NOT FALSE"), Cell::Integer(1));
        // The reported column label spells the operator back out.
        let labelled = engine.execute_one("SELECT 1 IS TRUE, NULL IS NOT FALSE").expect("labels");
        assert_eq!(labelled.columns, vec!["1 IS TRUE".to_string(), "NULL IS NOT FALSE".to_string()]);
        assert_eq!(labelled.rows, vec![vec![Cell::Integer(1), Cell::Integer(1)]]);
    }

    #[test]
    fn insert_default_values_uses_the_declared_defaults() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE dv(a INTEGER DEFAULT 7, b TEXT DEFAULT 'x', c INTEGER)").expect("defaults");
        let inserted = engine.execute_one("INSERT INTO dv DEFAULT VALUES").expect("default values");
        assert_eq!(inserted.affected, 1);
        // `DEFAULT VALUES` reports neither columns nor rows, like SQLite.
        assert!(inserted.columns.is_empty());
        assert!(inserted.rows.is_empty());
        assert_eq!(
            engine.execute_one("SELECT a, b, c FROM dv").expect("row").rows,
            vec![vec![Cell::Integer(7), Cell::Text("x".to_string()), Cell::Null]]
        );
        // A column without a declared default still becomes NULL.
        engine.execute_one("CREATE TABLE plain(a, b)").expect("plain");
        engine.execute_one("INSERT INTO plain DEFAULT VALUES").expect("plain default values");
        assert_eq!(engine.execute_one("SELECT a, b FROM plain").expect("plain row").rows, vec![vec![Cell::Null, Cell::Null]]);
        // An INTEGER primary key is the rowid alias, so the default row gets rowid 1.
        engine.execute_one("CREATE TABLE dvpk(a INTEGER PRIMARY KEY, b DEFAULT 3)").expect("alias defaults");
        engine.execute_one("INSERT INTO dvpk DEFAULT VALUES").expect("alias default values");
        assert_eq!(
            engine.execute_one("SELECT rowid, a, b FROM dvpk").expect("alias row").rows,
            vec![vec![Cell::Integer(1), Cell::Integer(1), Cell::Integer(3)]]
        );
        // `NOT NULL` without a default cannot be satisfied by a default row.
        engine.execute_one("CREATE TABLE nn(a TEXT NOT NULL, b)").expect("not null");
        let failed = engine.execute_one("INSERT INTO nn DEFAULT VALUES").expect_err("not null violation");
        assert_eq!(failed.code, "not-null-constraint");
        // An explicit column list may not be combined with `DEFAULT VALUES`.
        assert_eq!(engine.execute_one("INSERT INTO dv(a) DEFAULT VALUES").expect_err("column list").code, "syntax");
    }

    #[test]
    fn insert_values_accepts_bound_parameters() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)").expect("users");

        let inserted = engine
            .execute_with_parameters(
                "INSERT INTO users (id, name) VALUES (?1, ?2)",
                &[Cell::Integer(1), Cell::Text("ada".to_string())],
            )
            .expect("parameter insert");
        assert_eq!(inserted.len(), 1);
        assert_eq!(inserted[0].affected, 1);
        assert_eq!(inserted[0].rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(
            engine.execute_one("SELECT id, name FROM users").expect("read").rows,
            vec![vec![Cell::Integer(1), Cell::Text("ada".to_string())]]
        );

        // Every tuple of one multi-row statement binds its own placeholders.
        engine
            .execute_with_parameters(
                "INSERT INTO users (id, name) VALUES (?1, ?2), (?3, ?4)",
                &[Cell::Integer(2), Cell::Text("bob".to_string()), Cell::Integer(3), Cell::Text("cy".to_string())],
            )
            .expect("multi-row insert");
        assert_eq!(engine.execute_one("SELECT count(*) FROM users").expect("count").rows, vec![vec![Cell::Integer(3)]]);

        // Named placeholders address the same binding order.
        engine
            .execute_with_parameters(
                "INSERT INTO users (id, name) VALUES (:id, :name)",
                &[Cell::Integer(4), Cell::Text("dee".to_string())],
            )
            .expect("named insert");
        assert_eq!(engine.execute_one("SELECT id FROM users WHERE id = 4").expect("read").rows, vec![vec![Cell::Integer(4)]]);

        // Literal tuples keep working, and `DEFAULT VALUES` still ignores bindings.
        engine.execute_one("INSERT INTO users (id, name) VALUES (5, 'eve')").expect("literal insert");
        engine.execute_one("CREATE TABLE defaults_only(a INTEGER DEFAULT 9)").expect("defaults table");
        engine
            .execute_with_parameters("INSERT INTO defaults_only DEFAULT VALUES", &[Cell::Integer(6)])
            .expect("default values");
        assert_eq!(engine.execute_one("SELECT a FROM defaults_only").expect("default row").rows, vec![vec![Cell::Integer(9)]]);
    }

    #[test]
    fn last_insert_rowid_follows_sqlite_row_by_row() {
        let mut engine = Engine::new(None).expect("blank engine");
        assert_eq!(engine.last_insert_rowid(), 0);
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT NOT NULL CHECK(length(a) > 0))").expect("create t");
        engine.execute_one("CREATE TABLE plain(a TEXT)").expect("create plain");

        engine.execute_one("INSERT INTO t(a) VALUES ('x')").expect("single insert");
        assert_eq!(engine.last_insert_rowid(), 1);
        engine.execute_one("INSERT INTO t(a) VALUES ('y'), ('z')").expect("multi insert");
        assert_eq!(engine.last_insert_rowid(), 3);
        engine.execute_one("INSERT INTO t(id, a) VALUES (99, 'q')").expect("explicit rowid");
        assert_eq!(engine.last_insert_rowid(), 99);

        // Not one row of this statement passes, so the previous value stands.
        assert!(engine.execute_one("INSERT INTO t(a) VALUES ('')").is_err());
        assert_eq!(engine.last_insert_rowid(), 99);

        // The first tuple passes and records rowid 100, the second fails, and
        // the rollback removes the row without undoing that record.
        assert!(engine.execute_one("INSERT INTO t(a) VALUES ('p'), ('')").is_err());
        assert_eq!(engine.last_insert_rowid(), 100);
        assert_eq!(engine.execute_one("SELECT count(*) FROM t").expect("count").rows, vec![vec![Cell::Integer(4)]]);
        assert_eq!(
            engine.execute_one("SELECT id FROM t ORDER BY id").expect("rowids").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(3)], vec![Cell::Integer(99)]]
        );

        // The rolled-back rowid 100 is reused before the statement rolls back
        // again, so the recorded value stays at 100.
        assert!(engine.execute_one("INSERT INTO t(a) VALUES ('p'), (NULL)").is_err());
        assert_eq!(engine.last_insert_rowid(), 100);

        engine.execute_one("INSERT INTO plain(a) VALUES ('k'), ('l')").expect("plain multi insert");
        assert_eq!(engine.last_insert_rowid(), 2);

        // Updates and deletes never move the recorded rowid.
        engine.execute_one("UPDATE t SET a = 'u' WHERE id = 2").expect("update");
        engine.execute_one("DELETE FROM t WHERE id = 2").expect("delete");
        assert_eq!(engine.last_insert_rowid(), 2);

        // A reopened image is a fresh connection, so the value starts over.
        let path = std::env::temp_dir().join(format!("sqlite-engine-rowid-{}.db", std::process::id()));
        std::fs::write(&path, engine.snapshot().expect("image")).expect("write image");
        drop(engine);
        let writer = SqliteWriter::open(&path).expect("open image");
        let reopened = Engine::from_writer(writer).expect("rebuild catalog");
        assert_eq!(reopened.last_insert_rowid(), 0);
        std::fs::remove_file(&path).expect("cleanup image");
    }

    #[test]
    fn concat_binds_tighter_than_arithmetic() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("concat query").rows[0][0].clone();
        assert_eq!(value(&mut engine, "SELECT 1 || 2 * 3"), Cell::Integer(36));
        assert_eq!(value(&mut engine, "SELECT 1 || 2 + 3"), Cell::Integer(15));
        assert_eq!(value(&mut engine, "SELECT 2 + 3 || 4"), Cell::Integer(36));
        assert_eq!(value(&mut engine, "SELECT 'a' || 'b' = 'ab'"), Cell::Integer(1));
        assert_eq!(value(&mut engine, "SELECT 1 << 2 || 3"), Cell::Integer(8388608));
        // `||` is tighter than `/` as well, so the text side is the divisor.
        assert_eq!(value(&mut engine, "SELECT 7 / 2 || 'x'"), Cell::Integer(3));
        // Left-associative, and looser than unary minus.
        assert_eq!(value(&mut engine, "SELECT 1 || 2 || 3"), Cell::Text("123".to_string()));
        assert_eq!(value(&mut engine, "SELECT -1 || 2"), Cell::Text("-12".to_string()));
    }

    #[test]
    fn concat_produces_text_like_sqlite() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("concat query").rows[0][0].clone();
        assert_eq!(value(&mut engine, "SELECT 1 || 2"), Cell::Text("12".to_string()));
        assert_eq!(value(&mut engine, "SELECT 1.5 || 'x'"), Cell::Text("1.5x".to_string()));
        assert_eq!(value(&mut engine, "SELECT 2.0 || ''"), Cell::Text("2.0".to_string()));
        assert_eq!(value(&mut engine, "SELECT 1e300 || ''"), Cell::Text("1.0e+300".to_string()));
        assert_eq!(value(&mut engine, "SELECT 1e-5 || ''"), Cell::Text("1.0e-05".to_string()));
        assert_eq!(value(&mut engine, "SELECT typeof(1 || 2)"), Cell::Text("text".to_string()));
        // `NULL` propagates through concatenation.
        assert_eq!(value(&mut engine, "SELECT NULL || 'x'"), Cell::Null);
        assert_eq!(value(&mut engine, "SELECT 'x' || NULL"), Cell::Null);
        // Blobs concatenate through their text form.
        assert_eq!(value(&mut engine, "SELECT x'6162' || 'c'"), Cell::Text("abc".to_string()));
        assert_eq!(value(&mut engine, "SELECT x'31' || 1"), Cell::Text("11".to_string()));
    }

    #[test]
    fn bitwise_operators_follow_sqlite() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("bitwise query").rows[0][0].clone();
        assert_eq!(value(&mut engine, "SELECT 5 & 3"), Cell::Integer(1));
        // SQLite supports `|` as bitwise or even though it has no `^`.
        assert_eq!(value(&mut engine, "SELECT 1 | 2"), Cell::Integer(3));
        assert_eq!(value(&mut engine, "SELECT typeof(1 | 2)"), Cell::Text("integer".to_string()));
        assert_eq!(value(&mut engine, "SELECT ~1"), Cell::Integer(-2));
        assert_eq!(value(&mut engine, "SELECT ~1 || 2"), Cell::Text("-22".to_string()));
        // One left-associative level, looser than `+` and tighter than `=`.
        assert_eq!(value(&mut engine, "SELECT 1 | 2 & 3"), Cell::Integer(3));
        assert_eq!(value(&mut engine, "SELECT 5 & 3 << 1"), Cell::Integer(2));
        assert_eq!(value(&mut engine, "SELECT 1 + 2 | 4"), Cell::Integer(7));
        assert_eq!(value(&mut engine, "SELECT 1 & 2 = 0"), Cell::Integer(1));
        // Operands convert to 64-bit integers through the numeric prefix.
        assert_eq!(value(&mut engine, "SELECT '2abc' & 3"), Cell::Integer(2));
        assert_eq!(value(&mut engine, "SELECT 1.9 & 3"), Cell::Integer(1));
        assert_eq!(value(&mut engine, "SELECT x'33' & 3"), Cell::Integer(3));
        assert_eq!(value(&mut engine, "SELECT ~'2abc'"), Cell::Integer(-3));
        assert_eq!(value(&mut engine, "SELECT ~x'31'"), Cell::Integer(-2));
        assert_eq!(value(&mut engine, "SELECT ~NULL"), Cell::Null);
        assert_eq!(value(&mut engine, "SELECT NULL & 3"), Cell::Null);
        // `^` is not a SQLite token and stays a syntax error.
        assert_eq!(engine.execute_one("SELECT 5 ^ 3").expect_err("no xor").code, "syntax");
    }

    #[test]
    fn shift_operators_follow_sqlite() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("shift query").rows[0][0].clone();
        assert_eq!(value(&mut engine, "SELECT 1 << 2 + 3"), Cell::Integer(32));
        assert_eq!(value(&mut engine, "SELECT -8 >> 1"), Cell::Integer(-4));
        assert_eq!(value(&mut engine, "SELECT 1 << 63"), Cell::Integer(i64::MIN));
        assert_eq!(value(&mut engine, "SELECT 1 << 64"), Cell::Integer(0));
        assert_eq!(value(&mut engine, "SELECT -8 >> 65"), Cell::Integer(-1));
        // A negative count reverses the direction.
        assert_eq!(value(&mut engine, "SELECT 16 >> -1"), Cell::Integer(32));
        assert_eq!(value(&mut engine, "SELECT 1.9 << 1"), Cell::Integer(2));
        assert_eq!(value(&mut engine, "SELECT x'32' << 1"), Cell::Integer(4));
        assert_eq!(value(&mut engine, "SELECT NULL << 1"), Cell::Null);
    }

    #[test]
    fn numeric_prefix_reaches_casts_truthiness_and_aggregates() {
        let mut engine = engine();
        // Arithmetic takes the longest numeric prefix.
        assert_eq!(engine.execute_one("SELECT '2abc' + 1").expect("text add").rows, vec![vec![Cell::Integer(3)]]);
        assert_eq!(engine.execute_one("SELECT 'abc' + 1").expect("textless add").rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(engine.execute_one("SELECT ' 12abc' * 2").expect("padded multiply").rows, vec![vec![Cell::Integer(24)]]);
        // Blobs convert through their text form everywhere.
        assert_eq!(engine.execute_one("SELECT x'31' + 1").expect("blob add").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(
            engine.execute_one("SELECT CAST(x'31' AS INTEGER)").expect("blob integer").rows,
            vec![vec![Cell::Integer(1)]]
        );
        assert_eq!(
            engine.execute_one("SELECT CAST('2abc' AS NUMERIC)").expect("text numeric").rows,
            vec![vec![Cell::Integer(2)]]
        );
        assert_eq!(
            engine.execute_one("SELECT CAST(x'312e35' AS NUMERIC)").expect("blob numeric").rows,
            vec![vec![Cell::Real(1.5)]]
        );
        // A real becomes text through the same `%!.15g` rendering as `||`.
        assert_eq!(
            engine.execute_one("SELECT CAST(0.30000000000000004 AS TEXT)").expect("real text").rows,
            vec![vec![Cell::Text("0.3".to_string())]]
        );
        assert_eq!(
            engine.execute_one("SELECT CAST(1e300 AS TEXT)").expect("huge real text").rows,
            vec![vec![Cell::Text("1.0e+300".to_string())]]
        );
        // `IS TRUE` runs the same numeric prefix.
        assert_eq!(engine.execute_one("SELECT '2abc' IS TRUE").expect("text truth").rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(engine.execute_one("SELECT '0abc' IS TRUE").expect("zero truth").rows, vec![vec![Cell::Integer(0)]]);
        // Comparisons between a literal and a number keep the storage-class
        // ordering instead of coercing the text.
        assert_eq!(engine.execute_one("SELECT '2abc' = 2").expect("mixed compare").rows, vec![vec![Cell::Integer(0)]]);
        // Aggregates convert with the prefix rule; text and blob inputs switch
        // the sum to a real even when they hold whole numbers.
        engine.execute_one("CREATE TABLE v(x)").expect("create v");
        engine.execute_one("INSERT INTO v VALUES ('2abc'), ('10'), (NULL), (x'31')").expect("insert v");
        assert_eq!(
            engine.execute_one("SELECT sum(x), avg(x), count(x) FROM v").expect("v aggregate").rows,
            vec![vec![Cell::Real(13.0), Cell::Real(13.0 / 3.0), Cell::Integer(3)]]
        );
        // An all-integer column keeps the sum integral.
        assert_eq!(engine.execute_one("SELECT sum(a) FROM t").expect("t sum").rows, vec![vec![Cell::Integer(11)]]);
        assert_eq!(engine.execute_one("SELECT sum(a) FROM t WHERE a > 100").expect("empty sum").rows, vec![vec![Cell::Null]]);
        // `total()` is the real-valued sibling of `sum()` and never returns NULL.
        assert_eq!(
            engine.execute_one("SELECT total(x), typeof(total(x)) FROM v").expect("total").rows,
            vec![vec![Cell::Real(13.0), Cell::Text("real".to_string())]]
        );
        assert_eq!(
            engine.execute_one("SELECT total(x), sum(x) FROM v WHERE 0").expect("empty total").rows,
            vec![vec![Cell::Real(0.0), Cell::Null]]
        );
        assert_eq!(
            engine.execute_one("SELECT total(NULL), total(1), total(' 12abc')").expect("total literals").rows,
            vec![vec![Cell::Real(0.0), Cell::Real(1.0), Cell::Real(12.0)]]
        );
    }

    #[test]
    fn string_and_inspection_functions_follow_sqlite() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("function query").rows[0][0].clone();
        engine.execute_one("CREATE TABLE t(x)").expect("create t");
        engine.execute_one("INSERT INTO t VALUES ('a'), (NULL), ('b'), (3), (x'63')").expect("insert t");
        assert_eq!(value(&mut engine, "SELECT group_concat(x) FROM t"), Cell::Text("a,b,3,c".to_string()));
        assert_eq!(value(&mut engine, "SELECT group_concat(x, '-') FROM t"), Cell::Text("a-b-3-c".to_string()));
        // A present but NULL separator acts like an empty one, not the default.
        assert_eq!(value(&mut engine, "SELECT group_concat(x, NULL) FROM t"), Cell::Text("ab3c".to_string()));
        assert_eq!(value(&mut engine, "SELECT group_concat(x, 1) FROM t"), Cell::Text("a1b131c".to_string()));
        assert_eq!(value(&mut engine, "SELECT typeof(group_concat(x)) FROM t"), Cell::Text("text".to_string()));
        assert_eq!(value(&mut engine, "SELECT group_concat(x) FROM t WHERE 0"), Cell::Null);
        // `hex()` hashes the text form, so numbers are not treated as bytes.
        assert_eq!(value(&mut engine, "SELECT hex(255)"), Cell::Text("323535".to_string()));
        assert_eq!(value(&mut engine, "SELECT hex(-1)"), Cell::Text("2D31".to_string()));
        assert_eq!(value(&mut engine, "SELECT hex('abc')"), Cell::Text("616263".to_string()));
        assert_eq!(value(&mut engine, "SELECT hex(x'0102')"), Cell::Text("0102".to_string()));
        assert_eq!(value(&mut engine, "SELECT hex(1.5)"), Cell::Text("312E35".to_string()));
        assert_eq!(value(&mut engine, "SELECT hex(NULL)"), Cell::Text(String::new()));
        // `quote()` emits a literal per storage class.
        assert_eq!(value(&mut engine, "SELECT quote('It''s')"), Cell::Text("'It''s'".to_string()));
        assert_eq!(value(&mut engine, "SELECT quote(NULL)"), Cell::Text("NULL".to_string()));
        assert_eq!(value(&mut engine, "SELECT quote(x'0102')"), Cell::Text("X'0102'".to_string()));
        assert_eq!(value(&mut engine, "SELECT quote(1.5)"), Cell::Text("1.5".to_string()));
        assert_eq!(value(&mut engine, "SELECT quote(42)"), Cell::Text("42".to_string()));
        assert_eq!(value(&mut engine, "SELECT quote('')"), Cell::Text("''".to_string()));
        // Values whose 15-digit form does not round-trip fall back to 18 digits.
        assert_eq!(value(&mut engine, "SELECT quote(1.0 / 3.0)"), Cell::Text("3.333333333333333148e-01".to_string()));
        // `random()` and `randomblob()` only guarantee their shape.
        assert_eq!(value(&mut engine, "SELECT typeof(random())"), Cell::Text("integer".to_string()));
        assert_eq!(
            engine.execute_one("SELECT length(randomblob(4)), typeof(randomblob(4))").expect("randomblob").rows,
            vec![vec![Cell::Integer(4), Cell::Text("blob".to_string())]]
        );
        assert_eq!(value(&mut engine, "SELECT length(randomblob(NULL))"), Cell::Integer(1));
    }

    #[test]
    fn round_matches_sqlite_fixed_point_rounding() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("round query").rows[0][0].clone();
        // Every expected value below was measured on better-sqlite3 3.53.2 and
        // CPython sqlite3 3.49.1.
        assert_eq!(value(&mut engine, "SELECT round(1.2345, 3)"), Cell::Real(1.234));
        // A negative digit count is clamped to zero instead of scaling down.
        assert_eq!(value(&mut engine, "SELECT round(123.456, -1)"), Cell::Real(123.0));
        assert_eq!(value(&mut engine, "SELECT round(123.456, -5)"), Cell::Real(123.0));
        // Zero digits use the truncating fast path, not ties-to-even.
        assert_eq!(value(&mut engine, "SELECT round(2.5)"), Cell::Real(3.0));
        assert_eq!(value(&mut engine, "SELECT round(-2.5)"), Cell::Real(-3.0));
        assert_eq!(value(&mut engine, "SELECT round(0.5)"), Cell::Real(1.0));
        // Exact decimal ties round away from zero, unlike Rust's own formatting.
        assert_eq!(value(&mut engine, "SELECT round(0.25, 1)"), Cell::Real(0.3));
        assert_eq!(value(&mut engine, "SELECT round(1.25, 1)"), Cell::Real(1.3));
        assert_eq!(value(&mut engine, "SELECT round(-1.25, 1)"), Cell::Real(-1.3));
        // Values just below a tie follow their binary value.
        assert_eq!(value(&mut engine, "SELECT round(2.675, 2)"), Cell::Real(2.67));
        assert_eq!(value(&mut engine, "SELECT round(1.005, 2)"), Cell::Real(1.0));
        assert_eq!(value(&mut engine, "SELECT round(0.615, 2)"), Cell::Real(0.61));
        assert_eq!(value(&mut engine, "SELECT round(0.35, 1)"), Cell::Real(0.3));
        assert_eq!(value(&mut engine, "SELECT round(9.999, 2)"), Cell::Real(10.0));
        // More than 30 digits is the same as 30, and text coerces like SQLite.
        assert_eq!(value(&mut engine, "SELECT round(1.23456, 40)"), Cell::Real(1.23456));
        assert_eq!(value(&mut engine, "SELECT round('1.5', 1)"), Cell::Real(1.5));
        assert_eq!(value(&mut engine, "SELECT round('abc', 1)"), Cell::Real(0.0));
        assert_eq!(value(&mut engine, "SELECT round(1.2345, 3.9)"), Cell::Real(1.234));
        assert_eq!(value(&mut engine, "SELECT round(NULL, 1)"), Cell::Null);
        assert_eq!(value(&mut engine, "SELECT round(1.5, NULL)"), Cell::Null);
        assert_eq!(value(&mut engine, "SELECT typeof(round(2.5, 1))"), Cell::Text("real".to_string()));
    }

    #[test]
    fn instr_returns_one_based_character_positions() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("instr query").rows[0][0].clone();
        // Measured on better-sqlite3 3.53.2 and CPython sqlite3 3.49.1.
        assert_eq!(value(&mut engine, "SELECT instr('abcabc', 'bc')"), Cell::Integer(2));
        assert_eq!(value(&mut engine, "SELECT instr('abc', 'abc')"), Cell::Integer(1));
        assert_eq!(value(&mut engine, "SELECT instr('abc', 'z')"), Cell::Integer(0));
        assert_eq!(value(&mut engine, "SELECT instr('abc', 'abcd')"), Cell::Integer(0));
        // An empty needle matches at the first character, an empty haystack
        // with a non-empty needle does not.
        assert_eq!(value(&mut engine, "SELECT instr('abc', '')"), Cell::Integer(1));
        assert_eq!(value(&mut engine, "SELECT instr('', 'a')"), Cell::Integer(0));
        assert_eq!(value(&mut engine, "SELECT instr('', '')"), Cell::Integer(1));
        // Positions are counted in characters, not bytes; bound text keeps
        // every code point intact.
        let unicode = engine
            .execute_with_parameters("SELECT instr(?1, ?2)", &[Cell::Text("αβγδ".to_string()), Cell::Text("γ".to_string())])
            .expect("bound instr");
        assert_eq!(unicode[0].rows, vec![vec![Cell::Integer(3)]]);
        let han = engine
            .execute_with_parameters(
                "SELECT instr(?1, ?2)",
                &[Cell::Text("你好世界".to_string()), Cell::Text("好".to_string())],
            )
            .expect("bound instr");
        assert_eq!(han[0].rows, vec![vec![Cell::Integer(2)]]);
        // Numeric arguments use their SQLite text form.
        assert_eq!(value(&mut engine, "SELECT instr(12345, 34)"), Cell::Integer(3));
        assert_eq!(value(&mut engine, "SELECT instr(1.5, '.')"), Cell::Integer(2));
        assert_eq!(value(&mut engine, "SELECT typeof(instr('a', 'a'))"), Cell::Text("integer".to_string()));
        assert_eq!(value(&mut engine, "SELECT instr(NULL, 'a')"), Cell::Null);
        assert_eq!(value(&mut engine, "SELECT instr('a', NULL)"), Cell::Null);
        assert_eq!(
            engine.execute_one("SELECT instr('a', 'b', 'c')").expect_err("three arguments").message,
            "wrong number of arguments to function instr()"
        );
    }

    fn text(value: &str) -> Cell {
        Cell::Text(value.to_string())
    }

    #[test]
    fn sqlite_master_reports_creation_order_and_automatic_indexes() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE a(x INTEGER, y TEXT)").expect("create a");
        engine.execute_one("CREATE INDEX ia ON a(x)").expect("create ia");
        engine.execute_one("CREATE TABLE b(z TEXT PRIMARY KEY, w TEXT UNIQUE)").expect("create b");

        let result =
            engine.execute_one("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master").expect("select master");
        assert_eq!(
            result.columns,
            vec!["type".to_string(), "name".to_string(), "tbl_name".to_string(), "rootpage".to_string(), "sql".to_string()]
        );
        let rows = result.rows;
        assert_eq!(rows.len(), 5);
        // Row order is creation order, which is rootpage order here as in
        // upstream SQLite: table, explicit index, table, then its two
        // automatic constraint indexes.
        assert_eq!(rows[0][0..4], [text("table"), text("a"), text("a"), Cell::Integer(2)]);
        assert_eq!(rows[1][0..4], [text("index"), text("ia"), text("a"), Cell::Integer(3)]);
        assert_eq!(rows[2][0..4], [text("table"), text("b"), text("b"), Cell::Integer(4)]);
        assert_eq!(rows[3][0..4], [text("index"), text("sqlite_autoindex_b_1"), text("b"), Cell::Integer(5)]);
        assert_eq!(rows[4][0..4], [text("index"), text("sqlite_autoindex_b_2"), text("b"), Cell::Integer(6)]);
        // SQLite stores the statement as written; the SQL surface passes it
        // through verbatim instead of a re-rendered form.
        assert_eq!(rows[0][4], text("CREATE TABLE a(x INTEGER, y TEXT)"));
        assert_eq!(rows[1][4], text("CREATE INDEX ia ON a(x)"));
        // Automatic indexes have no SQL text, exactly like SQLite.
        assert_eq!(rows[3][4], Cell::Null);
        assert_eq!(rows[4][4], Cell::Null);

        // Filters and the `sqlite_schema` alias resolve to the same rows.
        let tables = engine.execute_one("SELECT name FROM sqlite_master WHERE type = 'table'").expect("filter tables");
        assert_eq!(tables.rows, vec![vec![text("a")], vec![text("b")]]);
        let autoindex =
            engine.execute_one("SELECT sql FROM sqlite_master WHERE name = 'sqlite_autoindex_b_1'").expect("filter autoindex");
        assert_eq!(autoindex.rows, vec![vec![Cell::Null]]);
        let alias = engine.execute_one("SELECT count(*) FROM sqlite_schema").expect("schema alias");
        assert_eq!(alias.rows, vec![vec![Cell::Integer(5)]]);
        // `sqlite_master` is an ordinary rowid table: `rowid` resolves and
        // `SELECT *` still projects only the five stored columns.
        let rowids = engine.execute_one("SELECT rowid, name FROM sqlite_master ORDER BY rowid").expect("master rowids");
        assert_eq!(
            rowids.rows,
            vec![
                vec![Cell::Integer(1), text("a")],
                vec![Cell::Integer(2), text("ia")],
                vec![Cell::Integer(3), text("b")],
                vec![Cell::Integer(4), text("sqlite_autoindex_b_1")],
                vec![Cell::Integer(5), text("sqlite_autoindex_b_2")],
            ]
        );
        let star = engine.execute_one("SELECT * FROM sqlite_master").expect("star");
        assert_eq!(star.columns.len(), 5);
        assert_eq!(star.rows[0].len(), 5);
        let temporary = engine.execute_one("SELECT count(*) FROM sqlite_temp_master").expect("temp master");
        assert_eq!(temporary.rows, vec![vec![Cell::Integer(0)]]);
    }

    #[test]
    fn schema_tables_are_read_only_and_reserved_names_are_rejected() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER)").expect("create t");

        let insert = engine.execute_one("INSERT INTO sqlite_master VALUES ('table', 'x', 'x', 0, 'x')").expect_err("read only");
        assert_eq!(insert.code, "readonly-system-table");
        assert_eq!(insert.statement, Some("insert"));
        let sequence = engine.execute_one("INSERT INTO sqlite_sequence VALUES ('t', 1)").expect_err("read only");
        assert_eq!(sequence.code, "readonly-system-table");

        let table = engine.execute_one("CREATE TABLE sqlite_foo(a INTEGER)").expect_err("reserved table");
        assert_eq!(table.code, "reserved-name");
        assert_eq!(table.message, "object name reserved for internal use: sqlite_foo");
        let index = engine.execute_one("CREATE INDEX sqlite_idx ON t(a)").expect_err("reserved index");
        assert_eq!(index.code, "reserved-name");
        let automatic = engine.execute_one("CREATE INDEX im ON sqlite_master(name)").expect_err("unindexable");
        assert_eq!(automatic.code, "readonly-system-table");
        assert_eq!(automatic.message, "table sqlite_master may not be indexed");
    }

    #[test]
    fn autoincrement_tracks_sqlite_sequence() {
        let mut engine = Engine::new(None).expect("blank engine");
        let value = |engine: &mut Engine, sql: &str| engine.execute_one(sql).expect("query").rows[0][0].clone();
        engine.execute_one("CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)").expect("create c");

        // `sqlite_sequence` is created by CREATE TABLE, immediately after the
        // table and before any later object.
        let master = engine.execute_one("SELECT type, name, rootpage FROM sqlite_master").expect("select master");
        assert_eq!(
            master.rows,
            vec![
                vec![text("table"), text("c"), Cell::Integer(2)],
                vec![text("table"), text("sqlite_sequence"), Cell::Integer(3)]
            ]
        );
        let empty = engine.execute_one("SELECT * FROM sqlite_sequence").expect("empty sequence");
        assert_eq!(empty.columns, vec!["name".to_string(), "seq".to_string()]);
        assert_eq!(empty.rows, Vec::<Vec<Cell>>::new());

        engine.execute_one("INSERT INTO c(v) VALUES ('a'), ('b')").expect("auto insert");
        assert_eq!(
            engine.execute_one("SELECT id FROM c").expect("select ids").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]
        );
        assert_eq!(
            engine.execute_one("SELECT name, seq FROM sqlite_sequence").expect("sequence").rows,
            vec![vec![text("c"), Cell::Integer(2)]]
        );

        // An explicit larger rowid raises the high-water mark, then automatic
        // ids continue above it; a lower explicit rowid never lowers it.
        engine.execute_one("INSERT INTO c(id, v) VALUES (100, 'explicit')").expect("explicit 100");
        assert_eq!(value(&mut engine, "SELECT seq FROM sqlite_sequence"), Cell::Integer(100));
        engine.execute_one("INSERT INTO c(v) VALUES ('auto')").expect("auto after 100");
        assert_eq!(value(&mut engine, "SELECT max(id) FROM c"), Cell::Integer(101));
        engine.execute_one("INSERT INTO c(id, v) VALUES (5, 'low')").expect("explicit 5");
        assert_eq!(value(&mut engine, "SELECT seq FROM sqlite_sequence"), Cell::Integer(101));
        engine.execute_one("INSERT INTO c(id, v) VALUES (NULL, 'null')").expect("null alias");
        assert_eq!(value(&mut engine, "SELECT max(id) FROM c"), Cell::Integer(102));

        // Without an AUTOINCREMENT table the sequence table does not exist.
        let missing =
            Engine::new(None).expect("fresh engine").execute_one("SELECT * FROM sqlite_sequence").expect_err("absent");
        assert_eq!(missing.code, "unknown-table");
        assert_eq!(missing.message, "no such table: sqlite_sequence");
    }

    #[test]
    fn autoincrement_must_decorate_an_integer_primary_key() {
        let mut engine = Engine::new(None).expect("blank engine");
        let text_key = engine.execute_one("CREATE TABLE e(a TEXT PRIMARY KEY AUTOINCREMENT)").expect_err("text key");
        assert_eq!(text_key.code, "autoincrement-integer-primary-key");
        assert_eq!(text_key.message, "AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY");
        let no_key = engine.execute_one("CREATE TABLE f(a INTEGER AUTOINCREMENT)").expect_err("missing key");
        assert_eq!(no_key.code, "syntax");
        assert_eq!(no_key.message, "near \"AUTOINCREMENT\": syntax error");
    }

    /// Builds an engine from a fixed setup script.
    fn joined_engine(statements: &[&str]) -> Engine {
        let mut engine = Engine::new(None).expect("blank engine");
        for statement in statements {
            engine.execute_one(statement).expect("setup statement");
        }
        engine
    }

    const LEFT_RIGHT: &[&str] = &[
        "CREATE TABLE l(id INTEGER, lv TEXT)",
        "INSERT INTO l VALUES (1,'a'),(2,'b')",
        "CREATE TABLE r(id INTEGER, rv TEXT)",
        "INSERT INTO r VALUES (2,'B'),(3,'C')",
    ];

    #[test]
    fn right_join_using_merges_the_column_once() {
        let mut engine = joined_engine(LEFT_RIGHT);
        let merged = engine.execute_one("SELECT id, lv, rv FROM l RIGHT JOIN r USING(id)").expect("merged columns");
        assert_eq!(merged.columns, vec!["id", "lv", "rv"]);
        assert_eq!(
            merged.rows,
            vec![vec![Cell::Integer(2), text("b"), text("B")], vec![Cell::Integer(3), Cell::Null, text("C")]]
        );
        // `*` repeats the `USING` column neither for the left nor the right side.
        let star = engine.execute_one("SELECT * FROM l RIGHT JOIN r USING(id)").expect("star");
        assert_eq!(star.columns, vec!["id", "lv", "rv"]);
        assert_eq!(star.rows, merged.rows);
        assert_eq!(
            engine.execute_one("SELECT id FROM l RIGHT JOIN r USING(id)").expect("merged id").rows,
            vec![vec![Cell::Integer(2)], vec![Cell::Integer(3)]]
        );
        // A table-qualified reference still addresses the original column.
        let qualified = engine.execute_one("SELECT l.id, r.id FROM l RIGHT JOIN r USING(id)").expect("qualified");
        assert_eq!(qualified.columns, vec!["id", "id"]);
        assert_eq!(qualified.rows, vec![vec![Cell::Integer(2), Cell::Integer(2)], vec![Cell::Null, Cell::Integer(3)]]);
    }

    #[test]
    fn inner_join_on_right_rowid_alias_keeps_left_major_order() {
        let mut engine = joined_engine(&[
            "CREATE TABLE l(id INTEGER PRIMARY KEY, v TEXT)",
            "INSERT INTO l VALUES (1,'a'),(2,'b'),(3,'c')",
            "CREATE TABLE r(id INTEGER PRIMARY KEY, w TEXT)",
            "INSERT INTO r VALUES (1,'X'),(2,'Y')",
        ]);
        // `r.id` is the right source's rowid alias, so the hash fast path
        // probes by rowid. The emitted pairs and their left-major order match
        // what the nested scan produces; the unmatched left row (id 3) drops.
        let joined = engine.execute_one("SELECT l.v, r.w FROM l JOIN r ON r.id = l.id").expect("rowid join");
        assert_eq!(joined.rows, vec![vec![text("a"), text("X")], vec![text("b"), text("Y")]]);
        // The implicit `rowid` name hits the same fast path.
        assert_eq!(
            engine.execute_one("SELECT l.v, r.w FROM l JOIN r ON r.rowid = l.id").expect("implicit rowid join").rows,
            vec![vec![text("a"), text("X")], vec![text("b"), text("Y")]]
        );
        // A non-integer probe (real via arithmetic) falls back to the nested
        // scan but still yields the identical result.
        assert_eq!(
            engine.execute_one("SELECT l.v, r.w FROM l JOIN r ON r.id = l.id * 1.0").expect("real probe join").rows,
            vec![vec![text("a"), text("X")], vec![text("b"), text("Y")]]
        );
        // A compound `ON` is not a single equality, so the generic path runs.
        assert_eq!(
            engine.execute_one("SELECT l.v, r.w FROM l JOIN r ON r.id = l.id AND r.w <> 'Y'").expect("compound on join").rows,
            vec![vec![text("a"), text("X")]]
        );
    }

    #[test]
    fn count_star_join_counts_without_materializing_rows() {
        let mut engine = joined_engine(&[
            "CREATE TABLE l(id INTEGER PRIMARY KEY, v TEXT)",
            "INSERT INTO l VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')",
            "CREATE TABLE r(id INTEGER PRIMARY KEY, w TEXT)",
            "INSERT INTO r VALUES (1,'X'),(2,'Y'),(4,'Z')",
        ]);
        // 裸 `count(*)` 的内连接走计数路径,不物化匹配行。
        assert_eq!(
            engine.execute_one("SELECT count(*) AS n FROM l JOIN r ON r.id = l.id").expect("count join").rows,
            vec![vec![Cell::Integer(3)]]
        );
        // `WHERE` 合取仍在完整行上生效。
        assert_eq!(
            engine.execute_one("SELECT count(*) AS n FROM l JOIN r ON r.id = l.id WHERE r.w <> 'Y'").expect("filtered").rows,
            vec![vec![Cell::Integer(2)]]
        );
        // 逗号乘积走计数路径,行数与通用路径一致。
        assert_eq!(engine.execute_one("SELECT count(*) AS n FROM l, r").expect("product").rows, vec![vec![Cell::Integer(12)]]);
        assert!(engine.execute_one("SELECT count(*) AS n FROM l, r LIMIT 0").expect("limit zero").rows.is_empty());
        // 外连接不走计数路径,但结果仍按通用路径计算。
        assert_eq!(
            engine.execute_one("SELECT count(*) AS n FROM l LEFT JOIN r ON r.id = l.id").expect("left join").rows,
            vec![vec![Cell::Integer(4)]]
        );
    }

    #[test]
    fn count_star_product_and_subquery_count_without_materializing_rows() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, score REAL)",
            "INSERT INTO t VALUES (1,1.0),(2,2.0),(3,3.0)",
        ]);
        assert_eq!(
            engine.execute_one("SELECT count(*) AS n FROM t WHERE score > 1.5").expect("count filter").rows,
            vec![vec![Cell::Integer(2)]]
        );
        // 同表内外层共享一次扫描,行集仍按 `IN` 子查询的结果计算。
        assert_eq!(
            engine
                .execute_one("SELECT count(*) AS n FROM t WHERE id IN (SELECT id FROM t WHERE score > 1.5)")
                .expect("in subquery")
                .rows,
            vec![vec![Cell::Integer(2)]]
        );
    }

    #[test]
    fn same_table_subqueries_reuse_a_covering_decode_and_redecode_narrower_masks() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL)",
            "INSERT INTO t VALUES (1,'a',1.0),(2,'b',2.0),(3,'c',3.0)",
        ]);
        // 外层掩码为全量解码,内层只要 `score`:内层复用外层已解码的行。
        assert_eq!(
            engine
                .execute_one("SELECT id, label, score FROM t WHERE id IN (SELECT id FROM t WHERE score > 1.5) ORDER BY id")
                .expect("covering reuse")
                .rows,
            vec![
                vec![Cell::Integer(2), Cell::Text("b".to_string()), Cell::Real(2.0)],
                vec![Cell::Integer(3), Cell::Text("c".to_string()), Cell::Real(3.0)],
            ]
        );
        // 两个互不覆盖的窄掩码各自解码,先落缓存的那份不能让后者读到 NULL 占位。
        assert_eq!(
            engine
                .execute_one("SELECT (SELECT count(*) FROM t WHERE score > 1.5), (SELECT count(*) FROM t WHERE label = 'a')")
                .expect("incomparable masks")
                .rows,
            vec![vec![Cell::Integer(2), Cell::Integer(1)]]
        );
        // 窄掩码先落缓存后,同一语句里更宽的同表请求仍要重新解码。
        assert_eq!(
            engine
                .execute_one(
                    "SELECT (SELECT count(*) FROM t WHERE score > 1.5) + (SELECT count(*) FROM t WHERE id IN (SELECT id FROM t WHERE label = 'a'))"
                )
                .expect("wider after narrower")
                .rows,
            vec![vec![Cell::Integer(3)]]
        );
        // 同表相关子查询:内层按外层当前行求值,共享行集不改变结果。
        assert_eq!(
            engine
                .execute_one("SELECT id FROM t AS o WHERE EXISTS (SELECT 1 FROM t AS u WHERE u.score = o.score + 1.0)")
                .expect("correlated same table")
                .rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]
        );
    }

    #[test]
    fn index_range_reads_sparse_candidates_like_the_full_scan() {
        let mut plain = Engine::new(None).expect("blank");
        let mut indexed = Engine::new(None).expect("blank");
        for engine in [&mut plain, &mut indexed] {
            engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)").expect("create");
            for row in 1..=64i64 {
                let label = if row % 8 == 0 { "hit".to_string() } else { format!("row-{row}") };
                engine.execute_one(&format!("INSERT INTO t VALUES ({row}, '{label}')")).expect("insert");
            }
        }
        indexed.execute_one("CREATE INDEX tl ON t (label)").expect("index");
        for sql in [
            "SELECT id FROM t WHERE label = 'hit'",
            "SELECT id FROM t WHERE label BETWEEN 'hit' AND 'hit' ORDER BY label",
            "SELECT id FROM t WHERE label >= 'hit'",
        ] {
            assert_eq!(plain.execute_one(sql).expect("plain").rows, indexed.execute_one(sql).expect("indexed").rows, "{sql}");
        }
    }

    /// 事务内的索引重建推迟到提交或读镜像时执行,读镜像前必须先落下。
    ///
    /// 这里在事务内取镜像并直接重开索引树,确认写语句本身没有把半成品的
    /// 索引页交出去,提交也不再改动镜像。
    #[test]
    fn deferred_index_rebuilds_land_before_the_image_is_read() {
        let mut engine = Engine::new(None).expect("blank");
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)").expect("create");
        engine.execute_one("CREATE INDEX tl ON t (label)").expect("index");
        engine.execute_one("BEGIN").expect("begin");
        for row in 1..=32i64 {
            engine.execute_one(&format!("INSERT INTO t VALUES ({row}, 'row-{row}')")).expect("insert");
        }
        let image = engine.snapshot().expect("image").to_vec();
        let objects = read_schema(&image, TableLimits::default()).expect("schema");
        let index = objects.iter().find(|object| object.kind == SchemaObjectKind::Index).expect("index object");
        let root = u32::try_from(index.root_page.expect("index root")).expect("root page");
        let entries = read_index_table_with(&image, root, TableLimits::default(), &[Collation::Binary]).expect("index tree");
        assert_eq!(entries.len(), 32, "the index tree must already hold the inserts made so far");
        engine.execute_one("COMMIT").expect("commit");
        assert_eq!(engine.snapshot().expect("image"), image.as_slice(), "commit must not add work of its own");
    }

    /// 整事务回滚丢掉推迟的重建,镜像退回事务前的索引树。
    #[test]
    fn deferred_index_rebuilds_are_dropped_on_rollback() {
        let mut engine = Engine::new(None).expect("blank");
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)").expect("create");
        engine.execute_one("CREATE INDEX tl ON t (label)").expect("index");
        engine.execute_one("INSERT INTO t VALUES (1, 'kept')").expect("seed");
        let before = engine.snapshot().expect("image").to_vec();
        engine.execute_one("BEGIN").expect("begin");
        engine.execute_one("INSERT INTO t VALUES (2, 'dropped')").expect("insert");
        engine.execute_one("ROLLBACK").expect("rollback");
        assert_eq!(engine.snapshot().expect("image"), before.as_slice(), "rollback restores the pre-transaction image");
        // autocommit 仍然立即重建,事务外的镜像不进入待重建状态。
        engine.execute_one("INSERT INTO t VALUES (3, 'later')").expect("autocommit insert");
        assert_eq!(engine.execute_one("SELECT count(*) FROM t").expect("rows").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(engine.execute_one("PRAGMA integrity_check").expect("check").rows, vec![vec![text("ok")]]);
    }

    #[test]
    fn select_rowid_alias_equality_fetches_the_single_row() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)",
            "INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')",
        ]);
        // A hit on the rowid alias is bounded to the one candidate row.
        assert_eq!(engine.execute_one("SELECT label FROM t WHERE id = 2").expect("point hit").rows, vec![vec![text("b")]]);
        // A miss yields no rows, exactly like the full scan.
        assert!(engine.execute_one("SELECT label FROM t WHERE id = 99").expect("point miss").rows.is_empty());
        // The implicit `rowid` name is pinned too.
        assert_eq!(engine.execute_one("SELECT label FROM t WHERE rowid = 3").expect("rowid hit").rows, vec![vec![text("c")]]);
        // Reversed operand order pins as well.
        assert_eq!(engine.execute_one("SELECT label FROM t WHERE 1 = id").expect("reversed pin").rows, vec![vec![text("a")]]);
        // An `OR` of two rowid equalities is not a top-level conjunct, so both
        // rows come back through the full scan.
        assert_eq!(
            engine.execute_one("SELECT label FROM t WHERE id = 1 OR id = 3").expect("or scan").rows,
            vec![vec![text("a")], vec![text("c")]]
        );
        // A pinned equality combined with another conjunct keeps the filter.
        assert!(
            engine.execute_one("SELECT label FROM t WHERE id = 2 AND label = 'zzz'").expect("pin plus filter").rows.is_empty()
        );
    }

    #[test]
    fn select_indexed_equality_matches_the_full_scan() {
        // Duplicate labels make the index non-unique, so the probe returns
        // more than one rowid and their order must stay the full scan's rowid
        // order.
        let statements: &[&str] = &[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL)",
            "INSERT INTO t VALUES (5,'a',1.5),(2,'b',2.5),(9,'a',3.5),(4,'c',NULL)",
        ];
        let mut plain = joined_engine(statements);
        let mut indexed = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL)",
            "INSERT INTO t VALUES (5,'a',1.5),(2,'b',2.5),(9,'a',3.5),(4,'c',NULL)",
            "CREATE INDEX tl ON t (label)",
        ]);
        for sql in [
            "SELECT id, label FROM t WHERE label = 'a'",
            "SELECT id FROM t WHERE label = 'b'",
            "SELECT id FROM t WHERE label = 'zzz'",
            "SELECT id FROM t WHERE label = 'a' AND score > 2",
            "SELECT id, label, score FROM t WHERE label = 'a' ORDER BY id DESC",
        ] {
            assert_eq!(plain.execute_one(sql).expect("plain").rows, indexed.execute_one(sql).expect("indexed").rows, "{sql}");
        }
        // Affinity mismatch keeps the full scan but never changes the answer.
        assert_eq!(
            indexed.execute_one("SELECT id FROM t WHERE label = 5").expect("text affinity").rows,
            plain.execute_one("SELECT id FROM t WHERE label = 5").expect("plain affinity").rows
        );
    }

    #[test]
    fn unique_index_point_lookup_and_multi_column_probe() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b INTEGER)",
            "CREATE UNIQUE INDEX tu ON t (a)",
            "CREATE INDEX tab ON t (a, b)",
            "INSERT INTO t VALUES (3,'x',1),(1,'y',2),(7,'z',3)",
        ]);
        // The unique index probe finds the single row.
        assert_eq!(engine.execute_one("SELECT id FROM t WHERE a = 'x'").expect("unique").rows, vec![vec![Cell::Integer(3)]]);
        // The multi-column probe covers both key columns.
        assert_eq!(
            engine.execute_one("SELECT id FROM t WHERE a = 'x' AND b = 1").expect("multi").rows,
            vec![vec![Cell::Integer(3)]]
        );
        // A partial multi-column key falls back to the full scan.
        assert!(engine.execute_one("SELECT id FROM t WHERE a = 'x' AND b = 99").expect("miss").rows.is_empty());
        // A predicate on a non-leading column keeps the full scan.
        assert_eq!(engine.execute_one("SELECT id FROM t WHERE b = 2").expect("non-leading").rows, vec![vec![Cell::Integer(1)]]);
    }

    #[test]
    fn index_probe_follows_writes() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)",
            "CREATE INDEX tl ON t (label)",
            "INSERT INTO t VALUES (1,'a'),(2,'b')",
        ]);
        assert_eq!(engine.execute_one("SELECT id FROM t WHERE label = 'b'").expect("b").rows, vec![vec![Cell::Integer(2)]]);
        engine.execute_one("UPDATE t SET label = 'c' WHERE id = 2").expect("update");
        assert!(engine.execute_one("SELECT id FROM t WHERE label = 'b'").expect("stale miss").rows.is_empty());
        assert_eq!(
            engine.execute_one("SELECT id FROM t WHERE label = 'c'").expect("new key").rows,
            vec![vec![Cell::Integer(2)]]
        );
        engine.execute_one("DELETE FROM t WHERE id = 1").expect("delete");
        assert!(engine.execute_one("SELECT id FROM t WHERE label = 'a'").expect("deleted").rows.is_empty());
    }

    #[test]
    fn upsert_updates_in_place_and_keeps_unassigned_columns() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL)",
            "INSERT INTO t VALUES (1,'a',1.5),(2,'b',2.5)",
        ]);
        // Two supplied rows conflict with the same stored row inside one
        // statement: the second one must see the first one's write.
        engine
            .execute_one("INSERT INTO t (id,label,score) VALUES (2,'bee',20),(2,'boo',30) ON CONFLICT(id) DO UPDATE SET score = excluded.score")
            .expect("multi upsert");
        assert_eq!(
            engine.execute_one("SELECT id, label, score FROM t ORDER BY id").expect("rows").rows,
            vec![vec![Cell::Integer(1), text("a"), Cell::Real(1.5)], vec![Cell::Integer(2), text("b"), Cell::Real(30.0)]]
        );
        // A fresh INSERT attaches a new row, and a later upsert still finds it.
        engine.execute_one("INSERT INTO t (id,label,score) VALUES (3,'c',3.5)").expect("insert");
        engine
            .execute_one(
                "INSERT INTO t (id,label,score) VALUES (3,'x',4.5) ON CONFLICT(id) DO UPDATE SET score = excluded.score",
            )
            .expect("upsert new");
        assert_eq!(
            engine.execute_one("SELECT label, score FROM t WHERE id = 3").expect("new row").rows,
            vec![vec![text("c"), Cell::Real(4.5)]]
        );
        // A trigger on the table keeps the reload path honest.
        engine.execute_one("CREATE TABLE audit(score REAL)").expect("audit");
        engine
            .execute_one("CREATE TRIGGER t_audit AFTER UPDATE ON t BEGIN INSERT INTO audit VALUES (NEW.score); END")
            .expect("trigger");
        engine
            .execute_one(
                "INSERT INTO t (id,label,score) VALUES (3,'x',9.5) ON CONFLICT(id) DO UPDATE SET score = excluded.score",
            )
            .expect("upsert with trigger");
        assert_eq!(engine.execute_one("SELECT score FROM audit").expect("audit rows").rows, vec![vec![Cell::Real(9.5)]]);
    }

    #[test]
    fn rowid_keyed_upsert_honors_do_nothing_and_the_update_predicate() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL)",
            "INSERT INTO t VALUES (1,'a',1.5),(2,'b',2.5)",
        ]);
        engine.execute_one("INSERT INTO t (id,label,score) VALUES (1,'a',9) ON CONFLICT(id) DO NOTHING").expect("do nothing");
        engine
            .execute_one("INSERT INTO t (id,label,score) VALUES (2,'b',8) ON CONFLICT(id) DO UPDATE SET score = excluded.score WHERE excluded.score > score")
            .expect("predicate true");
        engine
            .execute_one("INSERT INTO t (id,label,score) VALUES (1,'a',1) ON CONFLICT(id) DO UPDATE SET score = excluded.score WHERE excluded.score > score")
            .expect("predicate false");
        engine
            .execute_one(
                "INSERT INTO t (id,label,score) VALUES (3,'c',3.5) ON CONFLICT(id) DO UPDATE SET score = excluded.score",
            )
            .expect("insert");
        assert_eq!(
            engine.execute_one("SELECT id, label, score FROM t ORDER BY id").expect("rows").rows,
            vec![
                vec![Cell::Integer(1), text("a"), Cell::Real(1.5)],
                vec![Cell::Integer(2), text("b"), Cell::Real(8.0)],
                vec![Cell::Integer(3), text("c"), Cell::Real(3.5)],
            ]
        );
    }

    #[test]
    fn rowid_keyed_upsert_still_reports_other_unique_conflicts() {
        let mut engine =
            joined_engine(&["CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT UNIQUE)", "INSERT INTO t VALUES (1,'a')"]);
        let error = engine
            .execute_one("INSERT INTO t (id,label) VALUES (2,'a') ON CONFLICT(id) DO UPDATE SET label = excluded.label")
            .expect_err("a column UNIQUE constraint outside the conflict target must still abort");
        assert_eq!(error.code, "unique-constraint");
    }

    #[test]
    fn real_bound_rowid_upsert_takes_integer_affinity_before_conflict_detection() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL)",
            "INSERT INTO t VALUES (1,'a',1.5),(2,'b',2.5)",
        ]);
        // SQLite applies the column affinity to a bound value before conflict
        // detection: `2.0` into the rowid alias becomes the integer `2`, so the
        // upsert rewrites row 2 instead of colliding and surfacing `UNIQUE`.
        engine
            .execute_with_parameters(
                "INSERT INTO t (id,label,score) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET score = excluded.score",
                &[Cell::Real(2.0), text("bee"), Cell::Real(30.0)],
            )
            .expect("real rowid upsert");
        assert_eq!(
            engine.execute_one("SELECT id, label, score FROM t ORDER BY id").expect("rows").rows,
            vec![vec![Cell::Integer(1), text("a"), Cell::Real(1.5)], vec![Cell::Integer(2), text("b"), Cell::Real(30.0)]]
        );
    }

    #[test]
    fn lean_upsert_uses_defaults_for_excluded_columns_outside_the_insert_list() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT DEFAULT 'd', score REAL)",
            "INSERT INTO t VALUES (1,'a',1.5)",
        ]);
        // `excluded.label` is the would-be-inserted row, so an unsupplied column
        // reads its default: the rewrite sets `label` to the default `'d'`.
        engine
            .execute_one("INSERT INTO t (id,score) VALUES (1,9.5) ON CONFLICT(id) DO UPDATE SET label = excluded.label, score = excluded.score")
            .expect("excluded default");
        assert_eq!(
            engine.execute_one("SELECT label, score FROM t WHERE id = 1").expect("row").rows,
            vec![vec![text("d"), Cell::Real(9.5)]]
        );
    }

    #[test]
    fn bound_point_lookups_return_the_same_rows_as_their_literal_forms() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, n INTEGER)",
            "INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'c',30),(4,'d',40)",
            "CREATE INDEX tl ON t (label)",
            "CREATE INDEX tn ON t (n)",
        ]);
        // 下推键既可以是字面量，也可以是执行期已知的参数；两条路径必须给出同一行集，
        // 只是参数形态不再退化成整表扫描。
        for (literal, bound) in [
            ("SELECT label FROM t WHERE id = 3", "SELECT label FROM t WHERE id = ?"),
            ("SELECT id FROM t WHERE label = 'c'", "SELECT id FROM t WHERE label = ?"),
            ("SELECT id FROM t WHERE n >= 20 AND n <= 30", "SELECT id FROM t WHERE n >= ? AND n <= ?"),
        ] {
            let expected = engine.execute_one(literal).expect("literal form").rows;
            let parameters: &[Cell] = if literal.contains("id = 3") {
                &[Cell::Integer(3)]
            }
            else if literal.contains("label") {
                &[text("c")]
            }
            else {
                &[Cell::Integer(20), Cell::Integer(30)]
            };
            let actual = engine.execute_with_parameters(bound, parameters).expect("bound form").remove(0).rows;
            assert_eq!(actual, expected, "`{bound}` must match `{literal}`");
        }
    }

    #[test]
    fn bound_lookup_keeps_the_full_scan_result_for_a_mixed_storage_class() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)",
            "INSERT INTO t VALUES (1,'5'),(2,'6')",
            "CREATE INDEX tl ON t (label)",
        ]);
        // 文本列与整数比较时亲和类不符，探针必须放弃下推。此处只锁定「下推不改变
        // 结果」：字面量形态与绑定形态必须给出同一行集，具体行集由全表谓词决定。
        let literal = engine.execute_one("SELECT id FROM t WHERE label = 5").expect("literal form").rows;
        let bound = engine
            .execute_with_parameters("SELECT id FROM t WHERE label = ?", &[Cell::Integer(5)])
            .expect("bound form")
            .remove(0)
            .rows;
        assert_eq!(bound, literal, "the probe must not narrow a mixed storage-class comparison");
    }

    #[test]
    fn narrowed_update_still_sees_conflicts_outside_the_pinned_row() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT UNIQUE)",
            "INSERT INTO t VALUES (1,'a'),(2,'b')",
        ]);
        // 收窄只对「唯一键仅 rowid」生效；带额外唯一键的表保留整表判定，冲突照常报出。
        let error = engine
            .execute_with_parameters("UPDATE t SET label = ? WHERE id = ?", &[text("b"), Cell::Integer(1)])
            .expect_err("a UNIQUE conflict outside the narrowed row must still abort");
        assert_eq!(error.code, "unique-constraint");
    }

    #[test]
    fn narrowed_update_never_applies_when_the_rowid_changes() {
        let mut engine =
            joined_engine(&["CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT)", "INSERT INTO t VALUES (1,'a'),(2,'b')"]);
        let error = engine
            .execute_with_parameters("UPDATE t SET id = ? WHERE id = ?", &[Cell::Integer(2), Cell::Integer(1)])
            .expect_err("moving a rowid onto an existing row must conflict");
        assert_eq!(error.code, "unique-constraint");
    }

    #[test]
    fn narrowed_delete_only_narrows_a_rowid_equality() {
        let mut engine =
            joined_engine(&["CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)", "INSERT INTO t VALUES (1,5),(2,5),(3,6)"]);
        // 非 rowid 谓词必须删掉全部匹配行，不能被单行候选截断。
        engine.execute_one("DELETE FROM t WHERE n = 5").expect("delete every match");
        assert_eq!(engine.execute_one("SELECT id FROM t").expect("rows").rows, vec![vec![Cell::Integer(3)]]);
    }

    #[test]
    fn indexed_delete_reads_only_the_probed_rows() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, n INTEGER)",
            "INSERT INTO t VALUES (1,'a',5),(2,'a',6),(3,'b',7),(4,'c',8),(5,'c',9)",
            "CREATE INDEX tl ON t (label)",
        ]);
        // 非唯一索引等值:两行同键都要删掉,不能只删候选里的第一行。
        assert_eq!(engine.execute_one("DELETE FROM t WHERE label = 'a'").expect("delete by index").affected, 2);
        assert_eq!(
            engine.execute_one("SELECT id FROM t").expect("rows").rows,
            vec![vec![Cell::Integer(3)], vec![Cell::Integer(4)], vec![Cell::Integer(5)]]
        );
        // 首列范围同样走索引候选,并且只删命中范围的行。
        assert_eq!(engine.execute_one("DELETE FROM t WHERE label >= 'c'").expect("delete range").affected, 2);
        assert_eq!(engine.execute_one("SELECT id FROM t").expect("rows").rows, vec![vec![Cell::Integer(3)]]);
        // 索引列之外的谓词没有候选,仍按整表判定正确。
        assert_eq!(engine.execute_one("DELETE FROM t WHERE n > 0").expect("delete by column").affected, 1);
        assert!(engine.execute_one("SELECT id FROM t").expect("rows").rows.is_empty());
    }

    #[test]
    fn indexed_update_narrows_only_when_rowid_is_the_only_key() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, n INTEGER)",
            "INSERT INTO t VALUES (1,'a',1),(2,'a',2),(3,'b',3)",
            "CREATE INDEX tl ON t (label)",
        ]);
        // 唯一键只有 rowid 且不改 rowid:按索引谓词收窄,两个同键行都更新。
        assert_eq!(engine.execute_one("UPDATE t SET n = 9 WHERE label = 'a'").expect("update by index").affected, 2);
        assert_eq!(
            engine.execute_one("SELECT id, n FROM t").expect("rows").rows,
            vec![
                vec![Cell::Integer(1), Cell::Integer(9)],
                vec![Cell::Integer(2), Cell::Integer(9)],
                vec![Cell::Integer(3), Cell::Integer(3)]
            ]
        );
        // 带额外唯一键的表不收窄,冲突判定仍然看得到整表。
        let mut unique = joined_engine(&[
            "CREATE TABLE u(id INTEGER PRIMARY KEY, label TEXT UNIQUE, n INTEGER)",
            "INSERT INTO u VALUES (1,'a',1),(2,'b',2)",
            "CREATE INDEX ul ON u (label)",
        ]);
        let error = unique.execute_one("UPDATE u SET label = 'b' WHERE label = 'a'").expect_err("unique conflict");
        assert_eq!(error.code, "unique-constraint");
        // 不冲突的按索引更新照常生效。
        assert_eq!(unique.execute_one("UPDATE u SET n = 5 WHERE label = 'b'").expect("plain update").affected, 1);
        assert_eq!(unique.execute_one("SELECT n FROM u WHERE id = 2").expect("row").rows, vec![vec![Cell::Integer(5)]]);
    }

    #[test]
    fn index_range_probe_matches_the_full_scan() {
        let base: &[&str] = &[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, n INTEGER)",
            "INSERT INTO t VALUES (5,'e',5),(2,'b',2),(9,'i',9),(1,'a',1),(4,'d',4),(3,'c',3)",
        ];
        let mut plain = joined_engine(base);
        let mut indexed = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, n INTEGER)",
            "INSERT INTO t VALUES (5,'e',5),(2,'b',2),(9,'i',9),(1,'a',1),(4,'d',4),(3,'c',3)",
            "CREATE INDEX tl ON t (label)",
            "CREATE INDEX tn ON t (n)",
        ]);
        for sql in [
            "SELECT id, label FROM t WHERE label > 'b'",
            "SELECT id FROM t WHERE label >= 'b' AND label < 'd'",
            "SELECT id FROM t WHERE label <= 'c'",
            // The literal on the left must flip the comparison.
            "SELECT id FROM t WHERE 'c' < label",
            "SELECT id FROM t WHERE label BETWEEN 'b' AND 'd'",
            "SELECT id, label FROM t WHERE label > 'a' ORDER BY label DESC",
            // Integer affinity goes through the same probe.
            "SELECT id FROM t WHERE n > 2 AND n <= 4",
            // A range the probe cannot use (affinity mismatch, OR) still matches.
            "SELECT id FROM t WHERE label > 2",
            "SELECT id FROM t WHERE label < 'c' OR n = 9",
        ] {
            assert_eq!(plain.execute_one(sql).expect("plain").rows, indexed.execute_one(sql).expect("indexed").rows, "{sql}");
        }
        // Writes invalidate the cached entries, exactly like the equality probe.
        assert!(indexed.execute_one("SELECT id FROM t WHERE label > 'y'").expect("primed miss").rows.is_empty());
        indexed.execute_one("UPDATE t SET label = 'zz' WHERE id = 1").expect("update");
        assert_eq!(
            indexed.execute_one("SELECT id FROM t WHERE label > 'y'").expect("new key hit").rows,
            vec![vec![Cell::Integer(1)]]
        );
        indexed.execute_one("DELETE FROM t WHERE id = 1").expect("delete");
        assert!(indexed.execute_one("SELECT id FROM t WHERE label > 'y'").expect("deleted").rows.is_empty());
    }

    #[test]
    fn subquery_memo_keeps_results_and_invalidates_per_statement() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)",
            "INSERT INTO t VALUES (1,10),(2,20),(3,30)",
            "CREATE TABLE u(id INTEGER PRIMARY KEY, keep INTEGER)",
            "INSERT INTO u VALUES (1,1),(3,0)",
        ]);
        // Uncorrelated `IN`: the memo is built once and reused for every row.
        assert_eq!(
            engine.execute_one("SELECT id FROM t WHERE n IN (SELECT n FROM t WHERE n > 10)").expect("in").rows,
            vec![vec![Cell::Integer(2)], vec![Cell::Integer(3)]]
        );
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM t WHERE id IN (SELECT id FROM t WHERE n > 10)").expect("in count").rows,
            vec![vec![Cell::Integer(2)]]
        );
        // Correlated `EXISTS` must not be memoized across outer rows.
        assert_eq!(
            engine
                .execute_one("SELECT id FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id AND u.keep = 1)")
                .expect("correlated")
                .rows,
            vec![vec![Cell::Integer(1)]]
        );
        // A later statement sees the new rows: the memo never survives a statement.
        engine.execute_one("INSERT INTO t VALUES (4,40)").expect("insert");
        assert_eq!(
            engine.execute_one("SELECT id FROM t WHERE n IN (SELECT n FROM t WHERE n > 10)").expect("in again").rows,
            vec![vec![Cell::Integer(2)], vec![Cell::Integer(3)], vec![Cell::Integer(4)]]
        );
        // `IN` with a NULL on both sides keeps SQLite's three-valued result.
        engine.execute_one("CREATE TABLE m(id INTEGER, v INTEGER)").expect("create m");
        engine.execute_one("INSERT INTO m VALUES (1,NULL),(2,5),(3,NULL)").expect("insert m");
        assert_eq!(
            engine.execute_one("SELECT id FROM m WHERE v IN (SELECT v FROM m WHERE id = 1)").expect("null in").rows,
            Vec::<Vec<Cell>>::new()
        );
        assert_eq!(
            engine.execute_one("SELECT id FROM m WHERE v NOT IN (SELECT v FROM m WHERE id = 2)").expect("null not in").rows,
            Vec::<Vec<Cell>>::new()
        );
    }

    #[test]
    fn correlated_exists_index_probe_matches_the_full_scan() {
        let setup = [
            "CREATE TABLE a(id INTEGER PRIMARY KEY, label TEXT)",
            "INSERT INTO a VALUES (1,'x'),(2,'y'),(3,'x'),(4,'z')",
            "CREATE TABLE b(id INTEGER PRIMARY KEY, label TEXT)",
            "INSERT INTO b VALUES (1,'x'),(2,'y'),(3,'y'),(4,'w')",
        ];
        let mut plain = joined_engine(&setup);
        let mut indexed = joined_engine(&setup);
        indexed.execute_one("CREATE INDEX b_label ON b(label)").expect("index");
        for sql in [
            "SELECT count(*) FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.label = a.label)",
            "SELECT count(*) FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.label = a.label AND b.id <= 2)",
            "SELECT id FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.label = a.label AND b.id > 1) ORDER BY id",
            "SELECT count(*) FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.label = a.label)",
        ] {
            let expected = plain.execute_one(sql).expect("plain").rows;
            let actual = indexed.execute_one(sql).expect("indexed").rows;
            assert_eq!(actual, expected, "{sql}");
        }
    }

    #[test]
    fn correlated_exists_rechecks_equality_under_the_predicate_collation() {
        let mut engine = joined_engine(&[
            "CREATE TABLE outer_t(id INTEGER PRIMARY KEY, label TEXT)",
            "INSERT INTO outer_t VALUES (1,'b')",
            "CREATE TABLE inner_t(id INTEGER PRIMARY KEY, label TEXT)",
            "INSERT INTO inner_t VALUES (1,'B')",
            // 探针按索引的 `NOCASE` 折叠会命中 `'B'`，但列比较是 `BINARY`，
            // 复核必须按谓词的排序规则拒绝它。
            "CREATE INDEX inner_t_label ON inner_t(label COLLATE NOCASE)",
        ]);
        assert_eq!(
            engine
                .execute_one(
                    "SELECT count(*) FROM outer_t WHERE EXISTS (SELECT 1 FROM inner_t WHERE inner_t.label = outer_t.label)"
                )
                .expect("exists")
                .rows,
            vec![vec![Cell::Integer(0)]]
        );
        assert_eq!(
            engine
                .execute_one(
                    "SELECT count(*) FROM outer_t WHERE EXISTS (SELECT 1 FROM inner_t WHERE inner_t.label = outer_t.label COLLATE NOCASE)"
                )
                .expect("nocase")
                .rows,
            vec![vec![Cell::Integer(1)]]
        );
    }

    #[test]
    fn distinct_and_union_keep_first_occurrence_with_hash_signatures() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, n INTEGER, r REAL)",
            "INSERT INTO t VALUES (1,'b',1,1.5),(2,'a',2,2.0),(3,'b',2,NULL),(4,'a',2,2.0),(5,'c',3,3.5)",
        ]);
        assert_eq!(
            engine.execute_one("SELECT DISTINCT k FROM t").expect("distinct text").rows,
            vec![vec![text("b")], vec![text("a")], vec![text("c")]]
        );
        // A whole-valued real compares equal to the same integer, so `2.0` and
        // `2` collapse into one output row.
        assert_eq!(
            engine.execute_one("SELECT DISTINCT n FROM t").expect("distinct numbers").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(3)]]
        );
        assert_eq!(
            engine.execute_one("SELECT DISTINCT r FROM t").expect("distinct real").rows,
            vec![vec![Cell::Real(1.5)], vec![Cell::Real(2.0)], vec![Cell::Null], vec![Cell::Real(3.5)]]
        );
        // `UNION` deduplicates the same way and keeps first-seen order.
        assert_eq!(
            engine.execute_one("SELECT k FROM t WHERE id < 3 UNION SELECT k FROM t WHERE id > 2").expect("union").rows,
            vec![vec![text("b")], vec![text("a")], vec![text("c")]]
        );
        // `INTERSECT` and `EXCEPT` still use the same equality.
        assert_eq!(
            engine.execute_one("SELECT k FROM t INTERSECT SELECT k FROM t WHERE n = 2").expect("intersect").rows,
            vec![vec![text("b")], vec![text("a")]]
        );
    }

    #[test]
    fn order_by_rowid_limit_reads_only_the_prefix() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)",
            "INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')",
        ]);
        // The rowid-alias order with a limit is the scan prefix itself.
        assert_eq!(
            engine.execute_one("SELECT id, v FROM t ORDER BY id LIMIT 2").expect("head").rows,
            vec![vec![Cell::Integer(1), text("a")], vec![Cell::Integer(2), text("b")]]
        );
        assert_eq!(
            engine.execute_one("SELECT id, v FROM t ORDER BY rowid LIMIT 1 OFFSET 3").expect("offset head").rows,
            vec![vec![Cell::Integer(4), text("d")]]
        );
        // `count(*)` over an ordered limit still counts the whole table.
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM t ORDER BY id LIMIT 2").expect("count").rows,
            vec![vec![Cell::Integer(5)]]
        );
        // A `WHERE` can drop prefix rows, so the bounded read must not apply.
        assert_eq!(
            engine.execute_one("SELECT id FROM t WHERE v <> 'a' ORDER BY id LIMIT 2").expect("filtered").rows,
            vec![vec![Cell::Integer(2)], vec![Cell::Integer(3)]]
        );
        // An aliased projection re-points the order name at another column.
        assert_eq!(
            engine.execute_one("SELECT v AS id FROM t ORDER BY id LIMIT 2").expect("alias order").rows,
            vec![vec![text("a")], vec![text("b")]]
        );
    }

    #[test]
    fn group_by_hash_keeps_first_appearance_order() {
        let mut engine = joined_engine(&[
            "CREATE TABLE t(id INTEGER PRIMARY KEY, k TEXT, n INTEGER, r REAL)",
            "INSERT INTO t VALUES (1,'b',1,1.5),(2,'a',1,2.5),(3,'b',2,2.0),(4,'a',1,7.0),(5,'c',2,NULL)",
        ]);
        // Text keys: groups appear in first-row order, not sorted.
        assert_eq!(
            engine.execute_one("SELECT k, count(*) FROM t GROUP BY k").expect("text groups").rows,
            vec![vec![text("b"), Cell::Integer(2)], vec![text("a"), Cell::Integer(2)], vec![text("c"), Cell::Integer(1)]]
        );
        // A NULL key forms its own group, and a whole-valued real compares
        // equal to the same integer, so `2.0` and `2` share one group.
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM t GROUP BY COALESCE(r, n)").expect("mixed keys").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(1)]]
        );
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM t GROUP BY r").expect("null group").rows,
            vec![
                vec![Cell::Integer(1)],
                vec![Cell::Integer(1)],
                vec![Cell::Integer(1)],
                vec![Cell::Integer(1)],
                vec![Cell::Integer(1)]
            ]
        );
    }

    #[test]
    fn full_join_using_keeps_matched_pairs_and_unmatched_rows() {
        let mut engine = joined_engine(LEFT_RIGHT);
        let full = engine.execute_one("SELECT * FROM l FULL OUTER JOIN r USING(id)").expect("full");
        assert_eq!(full.columns, vec!["id", "lv", "rv"]);
        assert_eq!(
            full.rows,
            vec![
                vec![Cell::Integer(1), text("a"), Cell::Null],
                vec![Cell::Integer(2), text("b"), text("B")],
                vec![Cell::Integer(3), Cell::Null, text("C")],
            ]
        );
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM l FULL OUTER JOIN r USING(id)").expect("count").rows,
            vec![vec![Cell::Integer(3)]]
        );

        // `FULL` keeps the multiplicity of matched pairs instead of deduplicating rows.
        let mut duplicates = joined_engine(&[
            "CREATE TABLE d1(id INTEGER)",
            "INSERT INTO d1 VALUES (1),(1)",
            "CREATE TABLE d2(id INTEGER)",
            "INSERT INTO d2 VALUES (1),(1)",
        ]);
        assert_eq!(
            duplicates.execute_one("SELECT id FROM d1 FULL JOIN d2 USING(id)").expect("duplicate pairs").rows,
            vec![vec![Cell::Integer(1)]; 4]
        );

        // Unmatched rows from both sides are kept, including left-side duplicates.
        let mut uneven = joined_engine(&[
            "CREATE TABLE e1(id INTEGER)",
            "INSERT INTO e1 VALUES (1),(1)",
            "CREATE TABLE e2(id INTEGER)",
            "INSERT INTO e2 VALUES (2)",
        ]);
        assert_eq!(
            uneven.execute_one("SELECT id FROM e1 FULL JOIN e2 USING(id)").expect("unmatched rows").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(1)], vec![Cell::Integer(2)]]
        );
    }

    #[test]
    fn natural_join_matches_shared_column_names() {
        let mut engine = joined_engine(LEFT_RIGHT);
        let inner = engine.execute_one("SELECT * FROM l NATURAL JOIN r").expect("natural");
        assert_eq!(inner.columns, vec!["id", "lv", "rv"]);
        assert_eq!(inner.rows, vec![vec![Cell::Integer(2), text("b"), text("B")]]);
        assert_eq!(
            engine.execute_one("SELECT * FROM l NATURAL LEFT JOIN r").expect("natural left").rows,
            vec![vec![Cell::Integer(1), text("a"), Cell::Null], vec![Cell::Integer(2), text("b"), text("B")]]
        );
        assert_eq!(
            engine.execute_one("SELECT * FROM l NATURAL RIGHT JOIN r").expect("natural right").rows,
            vec![vec![Cell::Integer(2), text("b"), text("B")], vec![Cell::Integer(3), Cell::Null, text("C")]]
        );

        // With no shared name `NATURAL` degrades to a Cartesian product.
        let mut product = joined_engine(&[
            "CREATE TABLE n1(x INTEGER)",
            "INSERT INTO n1 VALUES (1),(2)",
            "CREATE TABLE n2(y INTEGER)",
            "INSERT INTO n2 VALUES (10),(20)",
        ]);
        let cartesian = product.execute_one("SELECT * FROM n1 NATURAL JOIN n2").expect("natural product");
        assert_eq!(cartesian.columns, vec!["x", "y"]);
        assert_eq!(
            cartesian.rows,
            vec![
                vec![Cell::Integer(1), Cell::Integer(10)],
                vec![Cell::Integer(1), Cell::Integer(20)],
                vec![Cell::Integer(2), Cell::Integer(10)],
                vec![Cell::Integer(2), Cell::Integer(20)],
            ]
        );

        // Name matching folds ASCII case and keeps the left table's spelling.
        let mut folded = joined_engine(&[
            "CREATE TABLE t(a INTEGER, b TEXT)",
            "INSERT INTO t VALUES (1,'x')",
            "CREATE TABLE u(A INTEGER, B TEXT, c TEXT)",
            "INSERT INTO u VALUES (1,'x','y')",
        ]);
        let natural = folded.execute_one("SELECT * FROM t NATURAL JOIN u").expect("natural case fold");
        assert_eq!(natural.columns, vec!["a", "b", "c"]);
        assert_eq!(natural.rows, vec![vec![Cell::Integer(1), text("x"), text("y")]]);
    }

    #[test]
    fn using_columns_follow_left_table_order_and_fold_case() {
        let setup = [
            "CREATE TABLE p(a INTEGER, b INTEGER, c TEXT)",
            "INSERT INTO p VALUES (1,2,'p')",
            "CREATE TABLE q(c TEXT, id INTEGER, b INTEGER, d TEXT)",
            "INSERT INTO q VALUES ('p',9,2,'q')",
        ];
        let mut engine = joined_engine(&setup);
        // The merged column keeps the position of the left table's column, and
        // listing the `USING` columns in another order changes nothing.
        for sql in ["SELECT * FROM p JOIN q USING(b,c)", "SELECT * FROM p JOIN q USING(c,b)"] {
            let result = engine.execute_one(sql).expect("multi-column using");
            assert_eq!(result.columns, vec!["a", "b", "c", "id", "d"]);
            assert_eq!(result.rows, vec![vec![Cell::Integer(1), Cell::Integer(2), text("p"), Cell::Integer(9), text("q")]]);
        }

        let mut folded = joined_engine(&[
            "CREATE TABLE t2(a INTEGER)",
            "INSERT INTO t2 VALUES (1)",
            "CREATE TABLE u2(A INTEGER)",
            "INSERT INTO u2 VALUES (1)",
        ]);
        let result = folded.execute_one("SELECT * FROM t2 JOIN u2 USING(a)").expect("case fold");
        assert_eq!(result.columns, vec!["a"]);
        assert_eq!(result.rows, vec![vec![Cell::Integer(1)]]);
    }

    #[test]
    fn using_and_natural_reject_invalid_clauses() {
        let setup = [
            "CREATE TABLE one(x INTEGER)",
            "INSERT INTO one VALUES (1)",
            "CREATE TABLE two(x INTEGER)",
            "INSERT INTO two VALUES (1)",
        ];
        let mut engine = joined_engine(&setup);

        let empty = engine.execute_one("SELECT * FROM one JOIN two USING()").expect_err("empty using");
        assert_eq!(empty.code, "syntax");
        assert_eq!(empty.message, "near \")\": syntax error");

        let missing = engine.execute_one("SELECT * FROM one JOIN two USING(nope)").expect_err("missing using column");
        assert_eq!(missing.code, "unknown-column");
        assert_eq!(missing.message, "cannot join using column nope - column not present in both tables");

        for sql in ["SELECT * FROM one NATURAL JOIN two ON one.x = two.x", "SELECT * FROM one NATURAL JOIN two USING(x)"] {
            let error = engine.execute_one(sql).expect_err("natural with clause");
            assert_eq!(error.code, "syntax");
            assert_eq!(error.message, "a NATURAL join may not have an ON or USING clause");
        }

        // `USING` compares whole identifiers: `i` is not the column `ID`.
        let mut mismatched = joined_engine(&[
            "CREATE TABLE t(i INTEGER, j TEXT)",
            "INSERT INTO t VALUES (1,'y')",
            "CREATE TABLE u(ID INTEGER, J TEXT, k TEXT)",
            "INSERT INTO u VALUES (1,'y','z')",
        ]);
        let error = mismatched.execute_one("SELECT * FROM t JOIN u USING(i,j)").expect_err("name mismatch");
        assert_eq!(error.code, "unknown-column");
        assert_eq!(error.message, "cannot join using column i - column not present in both tables");

        // A join without `ON` or `USING` still pairs every row like a product;
        // `RIGHT` only changes which unmatched rows SQLite keeps.
        let mut product = joined_engine(LEFT_RIGHT);
        let result = product.execute_one("SELECT * FROM l RIGHT JOIN r").expect("right without on");
        assert_eq!(result.columns, vec!["id", "lv", "id", "rv"]);
        assert_eq!(
            result.rows,
            vec![
                vec![Cell::Integer(1), text("a"), Cell::Integer(2), text("B")],
                vec![Cell::Integer(1), text("a"), Cell::Integer(3), text("C")],
                vec![Cell::Integer(2), text("b"), Cell::Integer(2), text("B")],
                vec![Cell::Integer(2), text("b"), Cell::Integer(3), text("C")],
            ]
        );
    }

    #[test]
    fn chained_using_joins_keep_the_merged_column() {
        let setup = [
            "CREATE TABLE m1(a INTEGER, b INTEGER)",
            "INSERT INTO m1 VALUES (1,2)",
            "CREATE TABLE m2(a INTEGER, c INTEGER)",
            "INSERT INTO m2 VALUES (1,3)",
            "CREATE TABLE m3(b INTEGER, a INTEGER, d INTEGER)",
            "INSERT INTO m3 VALUES (2,1,4)",
        ];
        let mut engine = joined_engine(&setup);
        let expected = vec![vec![Cell::Integer(1), Cell::Integer(2), Cell::Integer(3), Cell::Integer(2), Cell::Integer(4)]];

        let chained = engine.execute_one("SELECT * FROM m1 JOIN m2 USING(a) JOIN m3 USING(a)").expect("chained using");
        assert_eq!(chained.columns, vec!["a", "b", "c", "b", "d"]);
        assert_eq!(chained.rows, expected);

        let right = engine.execute_one("SELECT * FROM m1 JOIN m2 USING(a) RIGHT JOIN m3 USING(a)").expect("chained right");
        assert_eq!(right.columns, vec!["a", "b", "c", "b", "d"]);
        assert_eq!(right.rows, expected);
    }

    #[test]
    fn update_reads_every_right_hand_side_from_the_pre_statement_row() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER, b INTEGER)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,2)").expect("insert");
        engine.execute_one("UPDATE t SET a = b, b = a").expect("swap");
        assert_eq!(
            engine.execute_one("SELECT a, b FROM t").expect("select").rows,
            vec![vec![Cell::Integer(2), Cell::Integer(1)]]
        );

        // A three-step rotation proves the snapshot is taken once per row, not
        // per assignment: `c = a` keeps the original `a`, not the new `b`.
        let mut chain = Engine::new(None).expect("blank engine");
        chain.execute_one("CREATE TABLE t(a INTEGER, b INTEGER, c INTEGER)").expect("create");
        chain.execute_one("INSERT INTO t VALUES (1,2,3)").expect("insert");
        chain.execute_one("UPDATE t SET a = b, b = c, c = a").expect("rotate");
        assert_eq!(
            chain.execute_one("SELECT a, b, c FROM t").expect("select").rows,
            vec![vec![Cell::Integer(2), Cell::Integer(3), Cell::Integer(1)]]
        );
    }

    #[test]
    fn update_keeps_the_last_of_repeated_assignments() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER, b INTEGER)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,2)").expect("insert");
        engine.execute_one("UPDATE t SET a = 1, a = a + 1").expect("duplicate");
        assert_eq!(engine.execute_one("SELECT a FROM t").expect("select").rows, vec![vec![Cell::Integer(2)]]);
        engine.execute_one("UPDATE t SET a = 7, a = b").expect("duplicate");
        assert_eq!(
            engine.execute_one("SELECT a, b FROM t").expect("select").rows,
            vec![vec![Cell::Integer(2), Cell::Integer(2)]]
        );
    }

    #[test]
    fn update_reports_the_exact_affected_count() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER, b TEXT)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,'x'),(2,'y'),(3,'z')").expect("insert");
        assert_eq!(engine.execute_one("UPDATE t SET b = 'q' WHERE a = 99").expect("update").affected, 0);
        assert_eq!(engine.execute_one("UPDATE t SET b = 'q' WHERE a = 2").expect("update").affected, 1);
        assert_eq!(engine.execute_one("UPDATE t SET b = 'q' WHERE 1").expect("update").affected, 3);
        // A same-value assignment still counts as a touched row.
        assert_eq!(engine.execute_one("UPDATE t SET b = b").expect("update").affected, 3);
    }

    #[test]
    fn update_rolls_back_every_row_when_a_check_fails() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER CHECK(v > 0))").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,5),(2,6),(3,7)").expect("insert");
        let before = engine.execute_one("SELECT id, v FROM t").expect("select").rows;
        let error = engine.execute_one("UPDATE t SET v = v - 10").expect_err("check must fail");
        assert_eq!(error.code, "check-constraint");
        assert_eq!(error.clause.as_deref(), Some("CHECK"));
        assert_eq!(engine.execute_one("SELECT id, v FROM t").expect("select").rows, before);
    }

    #[test]
    fn insert_constraint_failures_keep_distinct_codes() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, u TEXT UNIQUE, n TEXT NOT NULL, c INTEGER CHECK(c > 0))")
            .expect("create");
        engine.execute_one("INSERT INTO t VALUES (1, 'a', 'x', 1)").expect("insert");

        assert_eq!(engine.execute_one("INSERT INTO t VALUES (1, 'b', 'y', 2)").expect_err("rowid").code, "unique-constraint");
        assert_eq!(
            engine.execute_one("INSERT INTO t VALUES (2, 'a', 'y', 2)").expect_err("unique column").code,
            "unique-constraint"
        );
        assert_eq!(
            engine.execute_one("INSERT INTO t VALUES (3, 'c', NULL, 3)").expect_err("not null").code,
            "not-null-constraint"
        );
        assert_eq!(engine.execute_one("INSERT INTO t VALUES (4, 'd', 'z', 0)").expect_err("check").code, "check-constraint");

        engine.execute_one("CREATE TABLE parent(id INTEGER PRIMARY KEY)").expect("parent");
        engine.execute_one("CREATE TABLE child(pid INTEGER REFERENCES parent(id))").expect("child");
        assert_eq!(
            engine.execute_one("INSERT INTO child VALUES (7)").expect_err("foreign key").code,
            "SQLITE_CONSTRAINT_FOREIGNKEY"
        );
    }

    #[test]
    fn update_of_a_rowid_alias_runs_in_ascending_order() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')").expect("insert");
        engine.execute_one("UPDATE t SET id = id - 1").expect("shift down");
        assert_eq!(
            engine.execute_one("SELECT id, v FROM t").expect("select").rows,
            vec![vec![Cell::Integer(0), text("a")], vec![Cell::Integer(1), text("b")], vec![Cell::Integer(2), text("c")],]
        );
        let before = engine.execute_one("SELECT id FROM t").expect("select").rows;
        let error = engine.execute_one("UPDATE t SET id = id + 1").expect_err("shift up collides");
        assert_eq!(error.code, "unique-constraint");
        assert_eq!(error.message, "UNIQUE constraint failed: t.id");
        assert_eq!(engine.execute_one("SELECT id FROM t").expect("select").rows, before);
    }

    #[test]
    fn delete_reports_affected_and_recycles_the_maximum_rowid() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(v TEXT)").expect("create");
        engine.execute_one("INSERT INTO t VALUES ('a'),('b'),('c')").expect("insert");
        assert_eq!(engine.execute_one("DELETE FROM t WHERE rowid = 2").expect("delete").affected, 1);
        assert_eq!(
            engine.execute_one("SELECT rowid, v FROM t").expect("select").rows,
            vec![vec![Cell::Integer(1), text("a")], vec![Cell::Integer(3), text("c")]]
        );
        // The next rowid is the largest live rowid plus one, so the vacated
        // maximum is recycled exactly as SQLite does without `AUTOINCREMENT`.
        let inserted = engine.execute_one("INSERT INTO t VALUES ('d')").expect("insert");
        assert_eq!(inserted.rows, vec![vec![Cell::Integer(4)]]);
        assert_eq!(engine.execute_one("DELETE FROM t").expect("delete").affected, 3);
        assert!(engine.execute_one("SELECT v FROM t").expect("select").rows.is_empty());
        let again = engine.execute_one("INSERT INTO t VALUES ('e')").expect("insert");
        assert_eq!(again.rows, vec![vec![Cell::Integer(1)]]);
    }

    #[test]
    fn returning_reports_new_values_for_update_and_old_values_for_delete() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,10),(2,20),(3,30)").expect("insert");
        let updated = engine.execute_one("UPDATE t SET v = v + 1 WHERE id >= 2 RETURNING id, v").expect("update returning");
        assert_eq!(updated.columns, vec!["id", "v"]);
        assert_eq!(updated.affected, 2);
        assert_eq!(updated.rows, vec![vec![Cell::Integer(2), Cell::Integer(21)], vec![Cell::Integer(3), Cell::Integer(31)]]);
        // `RETURNING *` expands to the declared columns only, never the rowid.
        let starred = engine.execute_one("UPDATE t SET v = v WHERE id = 1 RETURNING *").expect("star returning");
        assert_eq!(starred.columns, vec!["id", "v"]);
        assert_eq!(starred.rows, vec![vec![Cell::Integer(1), Cell::Integer(10)]]);
        let removed = engine.execute_one("DELETE FROM t RETURNING id").expect("delete returning");
        assert_eq!(removed.affected, 3);
        assert_eq!(removed.rows, vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(3)]]);
        let empty = engine.execute_one("UPDATE t SET v = 1 WHERE id = 99 RETURNING id").expect("empty returning");
        assert_eq!(empty.affected, 0);
        assert!(empty.rows.is_empty());
    }

    #[test]
    fn update_and_delete_reject_shapes_sqlite_also_rejects() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER, b INTEGER)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1,2)").expect("insert");
        // SQLite accepts a duplicate left-hand column (last one wins) but not a
        // table qualifier on the left of `=`.
        assert_eq!(engine.execute_one("UPDATE t SET t.a = 1").expect_err("qualified lhs").code, "syntax");
        // `DEFAULT` has no meaning in an `UPDATE`; SQLite reports a syntax error
        // and this engine names the clause instead.
        let default = engine.execute_one("UPDATE t SET a = DEFAULT").expect_err("default");
        assert_eq!(default.code, "unsupported-clause");
        assert_eq!(default.clause.as_deref(), Some("DEFAULT"));
        let conflict = engine.execute_one("UPDATE OR REPLACE t SET a = 1").expect_err("conflict clause");
        assert_eq!(conflict.code, "unsupported-clause");
    }

    #[test]
    fn drop_table_clears_catalog_indexes_and_sequence_row() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT UNIQUE)").expect("create c");
        engine.execute_one("CREATE INDEX ix ON c(k)").expect("create ix");
        engine.execute_one("INSERT INTO c(k) VALUES ('x')").expect("insert");
        assert_eq!(
            engine.execute_one("SELECT name, seq FROM sqlite_sequence").expect("sequence").rows,
            vec![vec![text("c"), Cell::Integer(1)]]
        );
        assert_eq!(engine.execute_one("SELECT count(*) FROM sqlite_master").expect("count").rows, vec![vec![Cell::Integer(4)]]);

        let dropped = engine.execute_one("DROP TABLE c").expect("drop c");
        assert_eq!(dropped.statement, "drop-table");
        assert_eq!(dropped.affected, 1);
        // The catalog row, the explicit index row and the automatic `UNIQUE`
        // row all disappear in the same statement; only `sqlite_sequence`
        // remains, plus no sequence row for `c`.
        assert_eq!(
            engine.execute_one("SELECT type, name FROM sqlite_master").expect("master").rows,
            vec![vec![text("table"), text("sqlite_sequence")]]
        );
        assert_eq!(engine.execute_one("SELECT * FROM sqlite_sequence").expect("sequence").rows, Vec::<Vec<Cell>>::new());
        assert_eq!(engine.execute_one("SELECT * FROM c").expect_err("gone").code, "unknown-table");
        assert_eq!(engine.execute_one("DROP TABLE IF EXISTS c").expect("if exists").affected, 0);

        // A second table reuses the freed root page, as SQLite does.
        engine.execute_one("CREATE TABLE d(a INTEGER)").expect("create d");
        assert_eq!(
            engine.execute_one("SELECT rootpage FROM sqlite_master WHERE name = 'd'").expect("root").rows,
            vec![vec![Cell::Integer(2)]]
        );
    }

    #[test]
    fn drop_table_rejects_system_tables_and_missing_names() {
        let mut engine = Engine::new(None).expect("blank engine");
        let master = engine.execute_one("DROP TABLE sqlite_master").expect_err("master");
        assert_eq!(master.code, "readonly-system-table");
        assert_eq!(master.message, "table sqlite_master may not be dropped");
        // `sqlite_sequence` only rejects once it exists; before that SQLite
        // reports an ordinary missing table.
        assert_eq!(engine.execute_one("DROP TABLE sqlite_sequence").expect_err("absent sequence").code, "unknown-table");
        engine.execute_one("CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT)").expect("create c");
        assert_eq!(engine.execute_one("DROP TABLE sqlite_sequence").expect_err("sequence").code, "readonly-system-table");
        assert_eq!(engine.execute_one("DROP TABLE nope").expect_err("missing").code, "unknown-table");
        assert_eq!(engine.execute_one("DROP TABLE nope.c").expect_err("unknown schema").code, "unknown-database");
        engine.execute_one("DROP TABLE main.c").expect("drop main.c");
        assert_eq!(engine.execute_one("SELECT * FROM main.c").expect_err("gone").code, "unknown-table");
    }

    #[test]
    fn drop_index_removes_explicit_indexes_only() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a TEXT UNIQUE, b INTEGER)").expect("create t");
        engine.execute_one("CREATE INDEX ix ON t(b)").expect("create ix");
        let automatic = engine.execute_one("DROP INDEX sqlite_autoindex_t_1").expect_err("autoindex");
        assert_eq!(automatic.code, "autoindex-immutable");
        assert_eq!(automatic.message, "index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped");
        // Even `IF EXISTS` does not soften the refusal, matching SQLite.
        assert_eq!(
            engine.execute_one("DROP INDEX IF EXISTS sqlite_autoindex_t_1").expect_err("autoindex if exists").code,
            "autoindex-immutable"
        );
        assert_eq!(engine.execute_one("DROP INDEX nope").expect_err("missing").code, "unknown-index");
        assert_eq!(engine.execute_one("DROP INDEX IF EXISTS nope").expect("if exists").affected, 0);

        let dropped = engine.execute_one("DROP INDEX ix").expect("drop ix");
        assert_eq!(dropped.statement, "drop-index");
        assert_eq!(
            engine.execute_one("SELECT name FROM sqlite_master WHERE type = 'index'").expect("indexes").rows,
            vec![vec![text("sqlite_autoindex_t_1")]]
        );
        // The automatic index still enforces the `UNIQUE` constraint.
        engine.execute_one("INSERT INTO t VALUES ('a', 1)").expect("insert");
        let duplicate = engine.execute_one("INSERT INTO t VALUES ('a', 2)").expect_err("duplicate key");
        // The writer's automatic-index check names the constraint; the facade
        // surfaces it as a storage rejection, as it did before this change.
        assert!(duplicate.message.contains("UNIQUE constraint failed"), "{}", duplicate.message);
        assert_eq!(engine.execute_one("SELECT count(*) FROM t").expect("count").rows, vec![vec![Cell::Integer(1)]]);
    }

    #[test]
    fn rename_table_rewrites_stored_text_and_automatic_index_names() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t ( a INTEGER , b TEXT UNIQUE )").expect("create");
        engine.execute_one("CREATE INDEX Ix ON t ( b )").expect("index");
        let renamed = engine.execute_one("ALTER TABLE t RENAME TO u").expect("rename");
        assert_eq!(renamed.statement, "alter-table");

        let rows = engine.execute_one("SELECT name, tbl_name, sql FROM sqlite_master").expect("master").rows;
        // SQLite rewrites only the table-name token, quoting the new name and
        // leaving every other byte of the stored DDL untouched.
        assert_eq!(rows[0], vec![text("u"), text("u"), text("CREATE TABLE \"u\" ( a INTEGER , b TEXT UNIQUE )")]);
        // The automatic index follows the table name, keeps its creation order
        // (it predates the explicit index) and has no SQL text.
        assert_eq!(rows[1], vec![text("sqlite_autoindex_u_1"), text("u"), Cell::Null]);
        assert_eq!(rows[2], vec![text("Ix"), text("u"), text("CREATE INDEX Ix ON \"u\" ( b )")]);

        engine.execute_one("INSERT INTO u VALUES (1, 'x')").expect("insert after rename");
        assert_eq!(engine.execute_one("SELECT a FROM u").expect("select").rows, vec![vec![Cell::Integer(1)]]);
        engine.execute_one("INSERT INTO u VALUES (2, 'x')").expect_err("unique survives");
        assert_eq!(engine.execute_one("ALTER TABLE u RENAME TO u").expect_err("exists").code, "table-exists");
        assert_eq!(engine.execute_one("ALTER TABLE u RENAME TO sqlite_x").expect_err("reserved").code, "reserved-name");
        assert_eq!(engine.execute_one("ALTER TABLE nope RENAME TO v").expect_err("missing").code, "unknown-table");
        assert_eq!(
            engine.execute_one("ALTER TABLE sqlite_master RENAME TO v").expect_err("system").code,
            "readonly-system-table"
        );
    }

    #[test]
    fn rename_table_moves_the_sequence_row() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE a(x INTEGER PRIMARY KEY AUTOINCREMENT)").expect("create");
        engine.execute_one("INSERT INTO a DEFAULT VALUES").expect("insert");
        engine.execute_one("ALTER TABLE a RENAME TO b").expect("rename");
        assert_eq!(
            engine.execute_one("SELECT name, seq FROM sqlite_sequence").expect("sequence").rows,
            vec![vec![text("b"), Cell::Integer(1)]]
        );
        // A new insert continues above the high-water mark.
        engine.execute_one("INSERT INTO b DEFAULT VALUES").expect("insert after rename");
        assert_eq!(engine.execute_one("SELECT max(x) FROM b").expect("max").rows, vec![vec![Cell::Integer(2)]]);
    }

    #[test]
    fn rename_column_rewrites_checks_and_index_text() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_one("CREATE TABLE t(t INTEGER, x TEXT DEFAULT 'a', y TEXT, CHECK (t > 0 AND x <> 't'))")
            .expect("create");
        engine.execute_one("CREATE INDEX ix ON t(x, t)").expect("index");
        engine.execute_one("ALTER TABLE t RENAME COLUMN t TO tt").expect("rename column");

        let rows = engine.execute_one("SELECT name, sql FROM sqlite_master").expect("master").rows;
        let table_sql = "CREATE TABLE t(tt INTEGER, x TEXT DEFAULT 'a', y TEXT, CHECK (tt > 0 AND x <> 't'))";
        assert_eq!(rows[0], vec![text("t"), text(table_sql)]);
        // The string literal `'t'` is untouched; the identifier in the index
        // column list is not.
        assert_eq!(rows[1], vec![text("ix"), text("CREATE INDEX ix ON t(x, tt)")]);
        assert_eq!(engine.execute_one("SELECT tt FROM t").expect("select").rows, Vec::<Vec<Cell>>::new());
        engine.execute_one("INSERT INTO t(tt) VALUES (1)").expect("insert");
        assert_eq!(engine.execute_one("INSERT INTO t(tt) VALUES (-1)").expect_err("check").code, "check-constraint");
        assert_eq!(
            engine.execute_one("ALTER TABLE t RENAME COLUMN nope TO x").expect_err("missing col").code,
            "unknown-column"
        );
        assert_eq!(engine.execute_one("ALTER TABLE t RENAME COLUMN tt TO x").expect_err("duplicate").code, "duplicate-column");
    }

    #[test]
    fn add_column_defaults_existing_rows_and_extends_select_order() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1), (2)").expect("insert");
        let added = engine.execute_one("ALTER TABLE t ADD COLUMN c INTEGER NOT NULL DEFAULT 5").expect("add");
        assert_eq!(added.statement, "alter-table");
        assert_eq!(
            engine.execute_one("SELECT * FROM t").expect("select").rows,
            vec![vec![Cell::Integer(1), Cell::Integer(5)], vec![Cell::Integer(2), Cell::Integer(5)]]
        );
        // The stored text gains exactly the definition as written, appended
        // before the closing parenthesis.
        assert_eq!(
            engine.execute_one("SELECT sql FROM sqlite_master WHERE name = 't'").expect("sql").rows,
            vec![vec![text("CREATE TABLE t(a INTEGER, c INTEGER NOT NULL DEFAULT 5)")]]
        );
        // The default applies to later inserts that omit the column too.
        engine.execute_one("INSERT INTO t(a) VALUES (3)").expect("insert");
        assert_eq!(engine.execute_one("SELECT c FROM t WHERE a = 3").expect("default").rows, vec![vec![Cell::Integer(5)]]);
        // Stale rows now update through the new column.
        engine.execute_one("UPDATE t SET c = c + 1 WHERE a = 1").expect("update");
        assert_eq!(engine.execute_one("SELECT c FROM t WHERE a = 1").expect("updated").rows, vec![vec![Cell::Integer(6)]]);
    }

    #[test]
    fn add_column_rejects_shapes_sqlite_also_rejects() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER)").expect("create");
        // An empty table accepts the definition; only a stored row would read
        // back NULL, so the refusal is conditional.
        engine.execute_one("ALTER TABLE t ADD COLUMN b TEXT NOT NULL").expect("empty table accepts");
        engine.execute_one("INSERT INTO t VALUES (1, 'x')").expect("insert");
        let not_null = engine.execute_one("ALTER TABLE t ADD COLUMN c TEXT NOT NULL").expect_err("not null");
        assert_eq!(not_null.code, "invalid-alter");
        assert_eq!(not_null.message, "Cannot add a NOT NULL column with default value NULL");
        let primary = engine.execute_one("ALTER TABLE t ADD COLUMN p INTEGER PRIMARY KEY").expect_err("primary key");
        assert_eq!(primary.message, "Cannot add a PRIMARY KEY column");
        let unique = engine.execute_one("ALTER TABLE t ADD COLUMN q TEXT UNIQUE").expect_err("unique");
        assert_eq!(unique.message, "Cannot add a UNIQUE column");
        let duplicate = engine.execute_one("ALTER TABLE t ADD COLUMN a TEXT").expect_err("duplicate");
        assert_eq!(duplicate.code, "duplicate-column");
        assert_eq!(duplicate.message, "duplicate column name: a");
    }

    #[test]
    fn drop_column_removes_values_and_rewrites_stored_text() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, note TEXT)").expect("create");
        engine.execute("INSERT INTO t (a,b,note) VALUES ('x', 1, 'n'), ('y', 2, NULL)").expect("insert");
        let dropped = engine.execute_one("ALTER TABLE t DROP COLUMN b").expect("drop");
        assert_eq!(dropped.statement, "alter-table");
        assert_eq!(dropped.affected, 1);
        // SQLite removes the definition and the separating comma, leaving every
        // other byte of the stored DDL untouched.
        assert_eq!(
            engine.execute_one("SELECT sql FROM sqlite_master WHERE name = 't'").expect("sql").rows,
            vec![vec![text("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, note TEXT)")]]
        );
        assert_eq!(
            engine.execute_one("SELECT id, a, note FROM t ORDER BY id").expect("rows").rows,
            vec![vec![Cell::Integer(1), text("x"), text("n")], vec![Cell::Integer(2), text("y"), Cell::Null],]
        );
        // The shortened table keeps inserting and updating in place.
        engine.execute_one("INSERT INTO t (a, note) VALUES ('z', 'm')").expect("insert");
        engine.execute_one("UPDATE t SET note = 'q' WHERE id = 1").expect("update");
        assert_eq!(
            engine.execute_one("SELECT a, note FROM t ORDER BY id").expect("rows").rows,
            vec![vec![text("x"), text("q")], vec![text("y"), Cell::Null], vec![text("z"), text("m")]]
        );
        let primary = engine.execute_one("ALTER TABLE t DROP COLUMN id").expect_err("primary key");
        assert_eq!(primary.code, "invalid-alter");
        let missing = engine.execute_one("ALTER TABLE t DROP COLUMN nope").expect_err("missing column");
        assert_eq!(missing.code, "unknown-column");
        engine.execute("CREATE TABLE u (a TEXT UNIQUE, b TEXT)").expect("unique");
        assert_eq!(engine.execute_one("ALTER TABLE u DROP COLUMN a").expect_err("unique").code, "invalid-alter");
        engine.execute("CREATE TABLE v (a TEXT)").expect("single column");
        assert_eq!(engine.execute_one("ALTER TABLE v DROP COLUMN a").expect_err("last column").code, "invalid-alter");
        engine.execute("CREATE TABLE w (a TEXT, b TEXT); CREATE INDEX wx ON w (a)").expect("indexed");
        assert_eq!(engine.execute_one("ALTER TABLE w DROP COLUMN a").expect_err("index").code, "invalid-alter");
        engine.execute("CREATE TABLE x (a TEXT, b TEXT, CHECK (a <> ''))").expect("table check");
        assert_eq!(engine.execute_one("ALTER TABLE x DROP COLUMN a").expect_err("table check").code, "invalid-alter");
        engine.execute("CREATE TABLE y (a TEXT, b TEXT, CHECK (b <> ''))").expect("unrelated check");
        engine.execute_one("ALTER TABLE y DROP COLUMN a").expect("unrelated check survives");
        assert_eq!(
            engine.execute_one("SELECT sql FROM sqlite_master WHERE name = 'y'").expect("sql").rows,
            vec![vec![text("CREATE TABLE y (b TEXT, CHECK (b <> ''))")]]
        );
        engine.execute("CREATE TABLE z (a TEXT CHECK (a <> ''), b TEXT)").expect("column check");
        engine.execute_one("ALTER TABLE z DROP COLUMN a").expect("column check belongs to the column");
    }

    #[test]
    fn temp_tables_shadow_main_and_vanish_with_the_engine() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TEMP TABLE t (a INTEGER PRIMARY KEY, b TEXT)").expect("create temp");
        assert_eq!(
            engine.execute_one("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_temp_master").expect("temp master").rows,
            vec![vec![
                text("table"),
                text("t"),
                text("t"),
                Cell::Integer(2),
                text("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)"),
            ]]
        );
        assert!(engine.execute_one("SELECT name FROM sqlite_master").expect("master").rows.is_empty());
        // Both schemas may own the name, and the temp table answers first.
        engine.execute("CREATE TABLE t (a INTEGER)").expect("main create");
        engine.execute("INSERT INTO t VALUES (9, 'temp')").expect("temp insert");
        assert_eq!(engine.execute_one("SELECT b FROM t").expect("select").rows, vec![vec![text("temp")]]);
        engine.execute_one("UPDATE t SET b = 'changed'").expect("temp update");
        assert_eq!(engine.execute_one("SELECT b FROM t").expect("select").rows, vec![vec![text("changed")]]);
        engine.execute_one("DELETE FROM t").expect("temp delete");
        assert!(engine.execute_one("SELECT a FROM t").expect("select").rows.is_empty());
        // `DROP TABLE` removes the temp object first and leaves main alone.
        engine.execute_one("DROP TABLE t").expect("drop temp");
        assert!(engine.execute_one("SELECT name FROM sqlite_temp_master").expect("temp master").rows.is_empty());
        assert_eq!(engine.execute_one("SELECT name FROM sqlite_master").expect("master").rows, vec![vec![text("t")]]);
        engine.execute("INSERT INTO t VALUES (1)").expect("main insert");
        // The temp schema belongs to the connection: a fresh engine is empty.
        let mut fresh = Engine::new(None).expect("fresh engine");
        assert!(fresh.execute_one("SELECT name FROM sqlite_temp_master").expect("temp master").rows.is_empty());
    }

    #[test]
    fn temp_pages_are_reused_after_a_drop() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TEMP TABLE a (x INTEGER); CREATE TEMP TABLE b (y INTEGER)").expect("create");
        engine.execute_one("DROP TABLE a").expect("drop");
        engine.execute("CREATE TEMP TABLE c (z INTEGER)").expect("create again");
        assert_eq!(
            engine.execute_one("SELECT name, rootpage FROM sqlite_temp_master").expect("temp master").rows,
            vec![vec![text("b"), Cell::Integer(3)], vec![text("c"), Cell::Integer(2)]]
        );
    }

    #[test]
    fn attached_databases_resolve_qualified_names_and_list_themselves() {
        let mut engine = Engine::new(None).expect("blank engine");
        let attached = engine.execute_one("ATTACH DATABASE ':memory:' AS aux").expect("attach");
        assert_eq!(attached.statement, "attach");
        assert_eq!(attached.affected, 0);
        // The temp slot is reserved but only listed once the temp schema exists.
        assert_eq!(
            engine.execute_one("PRAGMA database_list").expect("database list").rows,
            vec![vec![Cell::Integer(0), text("main"), text("")], vec![Cell::Integer(2), text("aux"), text("")],]
        );
        engine.execute("CREATE TEMP TABLE tt (v INTEGER)").expect("temp");
        engine.execute("CREATE TABLE local (v INTEGER)").expect("main");
        engine.execute("INSERT INTO local VALUES (1)").expect("main insert");
        engine.execute("CREATE TABLE aux.remote (v INTEGER)").expect("aux create");
        engine.execute("INSERT INTO aux.remote VALUES (2)").expect("aux insert");
        assert_eq!(engine.execute_one("SELECT * FROM aux.remote").expect("qualified").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(
            engine.execute_one("SELECT type, name FROM aux.sqlite_master").expect("aux master").rows,
            vec![vec![text("table"), text("remote")]]
        );
        // A schema-qualified source joins a main table in the same statement.
        assert_eq!(
            engine
                .execute_one("SELECT r.v, l.v FROM aux.remote AS r JOIN local AS l ON r.rowid = l.rowid")
                .expect("cross-database join")
                .rows,
            vec![vec![Cell::Integer(2), Cell::Integer(1)]]
        );
        // An unqualified name falls through temp and main to the attached
        // database, and inserts there as well.
        assert_eq!(engine.execute_one("SELECT * FROM remote").expect("fallback select").rows, vec![vec![Cell::Integer(2)]]);
        engine.execute("INSERT INTO remote VALUES (3)").expect("fallback insert");
        assert_eq!(engine.execute_one("SELECT count(*) FROM aux.remote").expect("count").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(
            engine.execute_one("PRAGMA database_list").expect("database list").rows,
            vec![
                vec![Cell::Integer(0), text("main"), text("")],
                vec![Cell::Integer(1), text("temp"), text("")],
                vec![Cell::Integer(2), text("aux"), text("")],
            ]
        );
    }

    #[test]
    fn main_and_temp_qualifiers_pin_the_schema() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TEMP TABLE t (v TEXT); CREATE TABLE t (v TEXT)").expect("both schemas");
        engine.execute("INSERT INTO temp.t VALUES ('temp'); INSERT INTO main.t VALUES ('main')").expect("inserts");
        assert_eq!(engine.execute_one("SELECT v FROM t").expect("default").rows, vec![vec![text("temp")]]);
        assert_eq!(engine.execute_one("SELECT v FROM main.t").expect("main").rows, vec![vec![text("main")]]);
        assert_eq!(engine.execute_one("SELECT v FROM temp.t").expect("temp").rows, vec![vec![text("temp")]]);
        engine.execute_one("UPDATE t SET v = 'changed'").expect("update temp");
        assert_eq!(engine.execute_one("SELECT v FROM main.t").expect("main untouched").rows, vec![vec![text("main")]]);
        engine.execute_one("DELETE FROM main.t").expect("delete main");
        assert!(engine.execute_one("SELECT v FROM main.t").expect("main empty").rows.is_empty());
        engine.execute_one("DROP TABLE temp.t").expect("drop temp");
        assert!(engine.execute_one("SELECT v FROM t").expect("main fallback").rows.is_empty());
        assert!(engine.execute_one("SELECT name FROM temp.sqlite_temp_master").expect("temp master").rows.is_empty());
        assert_eq!(engine.execute_one("SELECT * FROM main.missing").expect_err("missing").code, "unknown-table");
        assert_eq!(engine.execute_one("SELECT * FROM temp.missing").expect_err("missing temp").code, "unknown-table");
    }

    #[test]
    fn attached_files_are_created_and_keep_their_rows_across_reattach() {
        let dir = std::env::temp_dir().join(format!("sqlite-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("attached.sqlite3");
        let file_text = file.to_string_lossy().replace('\\', "/");
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one(&format!("ATTACH DATABASE '{file_text}' AS aux")).expect("attach");
        assert!(file.exists(), "attach creates the file");
        assert_eq!(std::fs::metadata(&file).expect("metadata").len(), 0, "sqlite leaves it empty until a write");
        engine.execute("CREATE TABLE aux.t (v INTEGER); INSERT INTO aux.t VALUES (7)").expect("write");
        assert!(std::fs::metadata(&file).expect("metadata").len() > 0, "a write materializes the image");
        engine.execute_one("DETACH DATABASE aux").expect("detach");
        engine.execute_one(&format!("ATTACH DATABASE '{file_text}' AS again")).expect("reattach");
        assert_eq!(engine.execute_one("SELECT * FROM again.t").expect("read").rows, vec![vec![Cell::Integer(7)]]);
        engine.execute_one("DETACH DATABASE again").expect("detach again");
        assert_eq!(engine.execute_one("DETACH DATABASE again").expect_err("gone").code, "unknown-database");
        assert_eq!(engine.execute_one("DETACH DATABASE main").expect_err("main").code, "cannot-detach");
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn attaching_more_than_ten_databases_is_rejected() {
        let mut engine = Engine::new(None).expect("blank engine");
        for index in 0..10 {
            engine.execute_one(&format!("ATTACH ':memory:' AS a{index}")).expect("attach");
        }
        let error = engine.execute_one("ATTACH ':memory:' AS extra").expect_err("limit");
        assert_eq!(error.message, "too many attached databases - max 10");
        assert_eq!(engine.execute_one("ATTACH ':memory:' AS a0").expect_err("duplicate").code, "database-in-use");
        engine.execute_one("DETACH DATABASE a0").expect("detach");
        engine.execute_one("ATTACH ':memory:' AS a10").expect("room again");
    }

    #[test]
    fn order_by_prefers_a_projection_alias() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t(a INTEGER, b INTEGER)").expect("create");
        engine.execute_one("INSERT INTO t VALUES (2, 9), (1, 8), (3, 7)").expect("insert");
        // A bare ORDER BY name resolves to the output label first, exactly like
        // SQLite, so `ORDER BY a` sorts the projected `b` values.
        assert_eq!(
            engine.execute_one("SELECT b AS a FROM t ORDER BY a").expect("alias order").rows,
            vec![vec![Cell::Integer(7)], vec![Cell::Integer(8)], vec![Cell::Integer(9)]]
        );
        assert_eq!(
            engine.execute_one("SELECT a AS z FROM t ORDER BY z DESC").expect("alias descending").rows,
            vec![vec![Cell::Integer(3)], vec![Cell::Integer(2)], vec![Cell::Integer(1)]]
        );
        // A qualified reference still reads the base table column.
        assert_eq!(
            engine.execute_one("SELECT b AS a FROM t ORDER BY t.a").expect("qualified order").rows,
            vec![vec![Cell::Integer(8)], vec![Cell::Integer(9)], vec![Cell::Integer(7)]]
        );
    }

    #[test]
    fn pragma_foreign_keys_reports_and_switches_session_state() {
        let mut engine = Engine::new(None).expect("blank engine");
        // better-sqlite3 opens every connection with foreign keys enabled.
        let queried = engine.execute_one("PRAGMA foreign_keys").expect("query");
        assert_eq!(queried.statement, "pragma");
        assert_eq!(queried.columns, vec!["foreign_keys".to_string()]);
        assert_eq!(queried.rows, vec![vec![Cell::Integer(1)]]);
        let disabled = engine.execute_one("PRAGMA foreign_keys = OFF").expect("disable");
        assert!(disabled.columns.is_empty());
        assert!(disabled.rows.is_empty());
        let queried = engine.execute_one("PRAGMA foreign_keys").expect("query");
        assert_eq!(queried.rows, vec![vec![Cell::Integer(0)]]);
        engine.execute_one("PRAGMA foreign_keys(ON)").expect("parenthesized form");
        let queried = engine.execute_one("PRAGMA foreign_keys").expect("query");
        assert_eq!(queried.rows, vec![vec![Cell::Integer(1)]]);
        engine.execute_one("PRAGMA foreign_keys = 0").expect("set zero");
        let queried = engine.execute_one("PRAGMA foreign_keys").expect("query");
        assert_eq!(queried.rows, vec![vec![Cell::Integer(0)]]);
    }

    #[test]
    fn foreign_keys_reject_orphans_and_removed_references() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)").expect("create parent");
        engine
            .execute_one("CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))")
            .expect("create child");
        engine.execute_one("INSERT INTO parent VALUES (1, 'a'), (2, 'b')").expect("parent rows");
        engine.execute_one("INSERT INTO child VALUES (10, 1)").expect("child row");
        let orphan = engine.execute_one("INSERT INTO child VALUES (11, 99)").expect_err("orphan");
        assert_eq!(orphan.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
        assert_eq!(orphan.message, "FOREIGN KEY constraint failed");
        engine.execute_one("INSERT INTO child VALUES (12, NULL)").expect("null key passes");
        let removed = engine.execute_one("DELETE FROM parent WHERE id = 1").expect_err("referenced delete");
        assert_eq!(removed.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
        let rewritten = engine.execute_one("UPDATE parent SET id = 7 WHERE id = 1").expect_err("referenced update");
        assert_eq!(rewritten.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
        // Assigning an unrelated parent column does not rewrite the key.
        engine.execute_one("UPDATE parent SET name = 'c' WHERE id = 1").expect("non-key update");
        let child_update = engine.execute_one("UPDATE child SET pid = 88 WHERE id = 10").expect_err("child update");
        assert_eq!(child_update.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
        engine.execute_one("UPDATE child SET pid = NULL WHERE id = 10").expect("child update to null");
        // The failed statements left no trace, like SQLite's implicit rollback.
        assert_eq!(engine.execute_one("SELECT count(*) FROM child").expect("count").rows, vec![vec![Cell::Integer(2)]]);
        // Disabling the pragma lets every previously rejected statement pass.
        engine.execute_one("PRAGMA foreign_keys = OFF").expect("disable");
        engine.execute_one("INSERT INTO child VALUES (11, 99)").expect("orphan allowed");
        engine.execute_one("DELETE FROM parent WHERE id = 1").expect("referenced delete allowed");
        engine.execute_one("UPDATE parent SET id = 7 WHERE id = 2").expect("referenced update allowed");
    }

    #[test]
    fn foreign_keys_report_missing_parents_and_mismatched_keys() {
        let mut engine = Engine::new(None).expect("blank engine");
        // A forward reference is legal at DDL time; the DML fails until the
        // parent exists.
        engine
            .execute_one("CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))")
            .expect("forward reference");
        let missing = engine.execute_one("INSERT INTO child VALUES (1, NULL)").expect_err("missing parent");
        assert_eq!(missing.code, "SQLITE_ERROR");
        assert_eq!(missing.message, "no such table: main.parent");
        let invalid = engine
            .execute_one("CREATE TABLE bad (id INTEGER PRIMARY KEY, FOREIGN KEY (ghost) REFERENCES parent(id))")
            .expect_err("bad child column");
        assert_eq!(invalid.code, "SQLITE_ERROR");
        assert_eq!(invalid.message, "unknown column \"ghost\" in foreign key definition");
        engine.execute_one("CREATE TABLE parent (id INTEGER)").expect("parent without a key");
        let mismatch = engine.execute_one("INSERT INTO child VALUES (2, NULL)").expect_err("mismatch");
        assert_eq!(mismatch.code, "SQLITE_ERROR");
        assert_eq!(mismatch.message, "foreign key mismatch - \"child\" referencing \"parent\"");
    }

    #[test]
    fn composite_foreign_keys_use_the_parent_primary_key() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b))").expect("composite parent");
        engine
            .execute_one(
                "CREATE TABLE child (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES parent)",
            )
            .expect("composite child");
        engine.execute_one("INSERT INTO parent VALUES (1, 2)").expect("parent row");
        engine.execute_one("INSERT INTO child VALUES (1, 1, 2)").expect("matching composite");
        let orphan = engine.execute_one("INSERT INTO child VALUES (2, 1, 3)").expect_err("composite orphan");
        assert_eq!(orphan.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
        engine.execute_one("INSERT INTO child VALUES (3, 1, NULL)").expect("partial null passes");
        let partial = engine
            .execute_one("CREATE TABLE single (id INTEGER PRIMARY KEY, x INTEGER, FOREIGN KEY (x) REFERENCES parent(a))")
            .expect("create single");
        assert_eq!(partial.statement, "create-table");
        let mismatch =
            engine.execute_one("INSERT INTO single VALUES (1, 1)").expect_err("single column against a composite key");
        assert_eq!(mismatch.code, "SQLITE_ERROR");
        assert_eq!(mismatch.message, "foreign key mismatch - \"single\" referencing \"parent\"");
    }

    #[test]
    fn self_references_may_point_at_later_rows_of_the_same_statement() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE t (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES t(id))").expect("create");
        engine.execute_one("INSERT INTO t VALUES (1, NULL), (2, 1)").expect("parent first");
        engine.execute_one("INSERT INTO t VALUES (3, 4), (4, NULL)").expect("child first");
        let orphan = engine.execute_one("INSERT INTO t VALUES (5, 9)").expect_err("self orphan");
        assert_eq!(orphan.code, "SQLITE_CONSTRAINT_FOREIGNKEY");
    }

    #[test]
    fn referential_actions_run_and_deferred_keys_wait_for_commit() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE p (id INTEGER PRIMARY KEY)").expect("create parent");
        engine
            .execute_one(
                "CREATE TABLE c1 (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE CASCADE ON UPDATE CASCADE)",
            )
            .expect("cascade");
        engine
            .execute_one(
                "CREATE TABLE c2 (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE SET NULL ON UPDATE SET NULL)",
            )
            .expect("set null");
        engine
            .execute_one(
                "CREATE TABLE c3 (id INTEGER PRIMARY KEY, pid INTEGER DEFAULT 9 REFERENCES p(id) ON DELETE SET DEFAULT ON UPDATE SET DEFAULT)",
            )
            .expect("set default");
        engine.execute_one("INSERT INTO p VALUES (1), (9)").expect("parents");
        engine.execute_one("INSERT INTO c1 VALUES (2, 1)").expect("cascade child");
        engine.execute_one("INSERT INTO c2 VALUES (3, 1)").expect("null child");
        engine.execute_one("INSERT INTO c3 VALUES (4, 1)").expect("default child");
        engine.execute_one("UPDATE p SET id = 5 WHERE id = 1").expect("cascade update");
        assert_eq!(
            engine.execute_one("SELECT id, pid FROM c1").expect("cascade rows").rows,
            vec![vec![Cell::Integer(2), Cell::Integer(5)]]
        );
        assert_eq!(
            engine.execute_one("SELECT id, pid FROM c2").expect("null rows").rows,
            vec![vec![Cell::Integer(3), Cell::Null]]
        );
        assert_eq!(
            engine.execute_one("SELECT id, pid FROM c3").expect("default rows").rows,
            vec![vec![Cell::Integer(4), Cell::Integer(9)]]
        );
        engine.execute_one("DELETE FROM p WHERE id = 5").expect("cascade delete");
        assert_eq!(engine.execute_one("SELECT id FROM c1").expect("cascade delete rows").rows, Vec::<Vec<Cell>>::new());
        assert_eq!(
            engine.execute_one("SELECT id, pid FROM c2").expect("null rows after delete").rows,
            vec![vec![Cell::Integer(3), Cell::Null]]
        );
        assert_eq!(
            engine.execute_one("SELECT id, pid FROM c3").expect("default rows after delete").rows,
            vec![vec![Cell::Integer(4), Cell::Integer(9)]]
        );
        let deferred = engine
            .execute_one("CREATE TABLE c4 (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)")
            .expect("deferred accepted");
        assert_eq!(deferred.statement, "create-table");
        // Autocommit: the statement boundary is also the commit boundary.
        let orphan = engine.execute_one("INSERT INTO c4 VALUES (5, 77)").expect_err("orphan");
        assert_eq!(orphan.message, "FOREIGN KEY constraint failed");
        // In a transaction the reference may be repaired before COMMIT.
        engine.execute_one("BEGIN").expect("begin");
        engine.execute_one("INSERT INTO c4 VALUES (5, 77)").expect("deferred insert");
        engine.execute_one("INSERT INTO p VALUES (77)").expect("repair parent");
        engine.execute_one("COMMIT").expect("commit repaired");
        assert_eq!(engine.execute_one("SELECT pid FROM c4").expect("deferred row").rows, vec![vec![Cell::Integer(77)]]);
        // An unresolvable reference fails COMMIT and keeps the transaction open.
        engine.execute_one("BEGIN").expect("begin again");
        engine.execute_one("INSERT INTO c4 VALUES (6, 88)").expect("deferred insert again");
        let violation = engine.execute_one("COMMIT").expect_err("commit fails");
        assert_eq!(violation.message, "FOREIGN KEY constraint failed");
        assert!(engine.in_transaction(), "a deferred failure must leave the transaction open");
        engine.execute_one("INSERT INTO p VALUES (88)").expect("repair after failure");
        engine.execute_one("COMMIT").expect("second commit");
    }

    #[test]
    fn recursive_ctes_iterate_until_the_working_set_is_empty() {
        let mut engine = Engine::new(None).expect("blank engine");
        let walked = engine
            .execute_one("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5) SELECT x FROM c")
            .expect("recursive walk");
        assert_eq!(
            walked.rows,
            vec![
                vec![Cell::Integer(1)],
                vec![Cell::Integer(2)],
                vec![Cell::Integer(3)],
                vec![Cell::Integer(4)],
                vec![Cell::Integer(5)]
            ]
        );
        // The keyword is not required when the body reads itself.
        let bare = engine
            .execute_one("WITH c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3) SELECT x FROM c")
            .expect("recursive without the keyword");
        assert_eq!(bare.rows, vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(3)]]);
        // `UNION` removes duplicates and therefore terminates a self-cycle.
        let cycle = engine
            .execute_one("WITH RECURSIVE c(x) AS (SELECT 1 UNION SELECT x FROM c) SELECT x FROM c")
            .expect("distinct cycle");
        assert_eq!(cycle.rows, vec![vec![Cell::Integer(1)]]);
        let factorial = engine
            .execute_one(
                "WITH RECURSIVE c(n, f) AS (SELECT 1, 1 UNION ALL SELECT n+1, f*(n+1) FROM c WHERE n < 5) SELECT n, f FROM c",
            )
            .expect("factorial");
        assert_eq!(
            factorial.rows,
            vec![
                vec![Cell::Integer(1), Cell::Integer(1)],
                vec![Cell::Integer(2), Cell::Integer(2)],
                vec![Cell::Integer(3), Cell::Integer(6)],
                vec![Cell::Integer(4), Cell::Integer(24)],
                vec![Cell::Integer(5), Cell::Integer(120)],
            ]
        );
    }

    #[test]
    fn recursive_ctes_keep_duplicates_for_union_all() {
        let mut engine = Engine::new(None).expect("blank engine");
        let duplicated = engine
            .execute_one("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x FROM c LIMIT 3) SELECT x FROM c")
            .expect("duplicates");
        assert_eq!(duplicated.rows, vec![vec![Cell::Integer(1)], vec![Cell::Integer(1)], vec![Cell::Integer(1)]]);
        let seeded = engine
            .execute_one(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3) SELECT x FROM c ORDER BY x",
            )
            .expect("seed duplicates");
        assert_eq!(
            seeded.rows,
            vec![
                vec![Cell::Integer(1)],
                vec![Cell::Integer(1)],
                vec![Cell::Integer(2)],
                vec![Cell::Integer(2)],
                vec![Cell::Integer(3)],
                vec![Cell::Integer(3)]
            ]
        );
    }

    #[test]
    fn infinite_recursion_is_cut_off_by_the_enclosing_limit() {
        let mut engine = Engine::new(None).expect("blank engine");
        let limited = engine
            .execute_one("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c LIMIT 5")
            .expect("bounded recursion");
        assert_eq!(
            limited.rows,
            vec![
                vec![Cell::Integer(1)],
                vec![Cell::Integer(2)],
                vec![Cell::Integer(3)],
                vec![Cell::Integer(4)],
                vec![Cell::Integer(5)]
            ]
        );
        let offset = engine
            .execute_one("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c LIMIT 2 OFFSET 3")
            .expect("bounded recursion with offset");
        assert_eq!(offset.rows, vec![vec![Cell::Integer(4)], vec![Cell::Integer(5)]]);
    }

    #[test]
    fn recursive_ctes_can_read_live_tables_and_earlier_entries() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute_one("CREATE TABLE edges (parent INTEGER, child INTEGER)").expect("create edges");
        engine.execute_one("INSERT INTO edges VALUES (1,2), (1,3), (2,4), (3,5), (5,6)").expect("edge rows");
        let tree = engine
            .execute_one("WITH RECURSIVE d(id, depth) AS (SELECT 1, 0 UNION ALL SELECT e.child, d.depth+1 FROM edges e, d WHERE e.parent = d.id) SELECT id, depth FROM d ORDER BY id")
            .expect("tree walk");
        assert_eq!(
            tree.rows,
            vec![
                vec![Cell::Integer(1), Cell::Integer(0)],
                vec![Cell::Integer(2), Cell::Integer(1)],
                vec![Cell::Integer(3), Cell::Integer(1)],
                vec![Cell::Integer(4), Cell::Integer(2)],
                vec![Cell::Integer(5), Cell::Integer(2)],
                vec![Cell::Integer(6), Cell::Integer(3)],
            ]
        );
        let chained = engine
            .execute_one("WITH a(k) AS (SELECT 2), b(x) AS (SELECT 1 UNION ALL SELECT x+k FROM b, a WHERE x < 9) SELECT x FROM b ORDER BY x")
            .expect("earlier entry");
        assert_eq!(
            chained.rows,
            vec![
                vec![Cell::Integer(1)],
                vec![Cell::Integer(3)],
                vec![Cell::Integer(5)],
                vec![Cell::Integer(7)],
                vec![Cell::Integer(9)]
            ]
        );
    }

    #[test]
    fn malformed_recursive_ctes_report_a_circular_reference() {
        let mut engine = Engine::new(None).expect("blank engine");
        let mixed = engine
            .execute_one(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3 UNION ALL SELECT 9) SELECT x FROM c",
            )
            .expect_err("non-recursive term after a recursive one");
        assert_eq!(mixed.code, "SQLITE_ERROR");
        assert_eq!(mixed.message, "circular reference: c");
        let self_seed = engine.execute_one("WITH c(x) AS (SELECT x FROM c) SELECT x FROM c").expect_err("seed reads itself");
        assert_eq!(self_seed.message, "circular reference: c");
    }

    #[test]
    fn transactions_restore_rows_and_schema() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute("CREATE TABLE t(a INTEGER); BEGIN; INSERT INTO t VALUES (1); CREATE TABLE gone(b INTEGER); ROLLBACK")
            .expect("script");
        assert_eq!(engine.execute_one("SELECT count(*) FROM t").expect("read").rows, vec![vec![Cell::Integer(0)]]);
        assert!(engine.execute_one("SELECT b FROM gone").is_err());

        engine
            .execute("BEGIN; INSERT INTO t VALUES (2); SAVEPOINT s; INSERT INTO t VALUES (3); ROLLBACK TO s; RELEASE s; COMMIT")
            .expect("script");
        assert_eq!(engine.execute_one("SELECT a FROM t").expect("read").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(
            engine.execute_one("COMMIT").expect_err("no transaction").message,
            "cannot commit - no transaction is active"
        );
    }

    #[test]
    fn distinct_collapses_before_limit() {
        let mut engine = engine();
        assert_eq!(
            engine.execute_one("SELECT DISTINCT b FROM t ORDER BY b LIMIT 2").expect("select").rows,
            vec![vec![Cell::Null], vec![Cell::Integer(0)]]
        );
    }

    #[test]
    fn strict_tables_reject_values_outside_the_declared_type() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE s(a INTEGER, b TEXT, c BLOB) STRICT").expect("strict table");
        engine.execute("INSERT INTO s VALUES ('12', 5, X'00')").expect("affinity keeps strict rows valid");
        assert_eq!(
            engine.execute_one("SELECT a, b FROM s").expect("read").rows,
            vec![vec![Cell::Integer(12), Cell::Text("5".to_string())]]
        );
        let real = engine.execute_one("INSERT INTO s(a) VALUES (1.5)").expect_err("real into integer");
        assert_eq!(real.code, "constraint-datatype");
        assert_eq!(real.message, "cannot store REAL value in INTEGER column s.a");
        let text = engine.execute_one("INSERT INTO s(c) VALUES ('z')").expect_err("text into blob");
        assert_eq!(text.message, "cannot store TEXT value in BLOB column s.c");
        let unknown = engine.execute_one("CREATE TABLE bad(a varchar(10)) STRICT").expect_err("bad datatype");
        assert_eq!(unknown.message, "unknown datatype for bad.a: \"varchar(10)\"");
    }

    #[test]
    fn views_rerun_their_query_and_share_the_object_namespace() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE base(a INTEGER, b TEXT)").expect("base");
        engine.execute("INSERT INTO base VALUES (1, 'x'), (2, 'y')").expect("rows");
        engine.execute("CREATE VIEW v(c) AS SELECT a FROM base WHERE a > 1").expect("view");
        assert_eq!(engine.execute_one("SELECT c FROM v ORDER BY c").expect("read view").rows, vec![vec![Cell::Integer(2)]]);
        engine.execute("INSERT INTO base VALUES (3, 'z')").expect("later row");
        assert_eq!(engine.execute_one("SELECT count(*) FROM v").expect("count view").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(
            engine
                .execute_one("SELECT type, name, tbl_name, rootpage FROM sqlite_master WHERE name = 'v'")
                .expect("master")
                .rows,
            vec![vec![
                Cell::Text("view".to_string()),
                Cell::Text("v".to_string()),
                Cell::Text("v".to_string()),
                Cell::Integer(0)
            ]]
        );
        let modify = engine.execute_one("INSERT INTO v VALUES (4)").expect_err("view is read only");
        assert_eq!(modify.code, "readonly-view");
        engine.execute("DROP VIEW v").expect("drop view");
        let missing = engine.execute_one("SELECT * FROM v").expect_err("dropped");
        assert_eq!(missing.code, "unknown-table");
    }

    #[test]
    fn triggers_fire_once_and_keep_catalog_rows() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE scratch(id INTEGER, label TEXT)").expect("scratch");
        engine.execute("CREATE TABLE audit(id INTEGER)").expect("audit");
        engine
            .execute("CREATE TRIGGER probe AFTER INSERT ON scratch BEGIN INSERT INTO audit VALUES (1); END")
            .expect("trigger");
        engine
            .execute("CREATE TRIGGER probe_self AFTER INSERT ON scratch BEGIN INSERT INTO scratch VALUES (9, 'self'); END")
            .expect("self trigger");
        engine.execute("INSERT INTO scratch VALUES (1, 'x')").expect("insert");
        // One user insert plus one body insert. The body insert fires the
        // other trigger but not the one whose body is running, because
        // recursive triggers are off.
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM scratch").expect("count scratch").rows,
            vec![vec![Cell::Integer(2)]]
        );
        assert_eq!(engine.execute_one("SELECT count(*) FROM audit").expect("count audit").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(
            engine.execute_one("SELECT type, name, tbl_name FROM sqlite_master WHERE name = 'probe'").expect("master").rows,
            vec![vec![Cell::Text("trigger".to_string()), Cell::Text("probe".to_string()), Cell::Text("scratch".to_string())]]
        );
        engine.execute("DROP TRIGGER probe").expect("drop trigger");
        engine.execute("INSERT INTO scratch VALUES (2, 'y')").expect("insert after drop");
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM audit").expect("count after drop").rows,
            vec![vec![Cell::Integer(2)]]
        );
    }

    #[test]
    fn trigger_timings_see_new_and_old_rows() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)").expect("t");
        engine.execute("CREATE TABLE log(v)").expect("log");
        engine
            .execute("CREATE TRIGGER bi BEFORE INSERT ON t BEGIN INSERT INTO log VALUES (new.a); END")
            .expect("before insert");
        engine
            .execute("CREATE TRIGGER ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.rowid); END")
            .expect("after insert");
        engine.execute("INSERT INTO t VALUES (5, 'seven', 'x')").expect("insert");
        assert_eq!(
            engine.execute_one("SELECT v FROM log").expect("log rows").rows,
            vec![vec![Cell::Text("seven".to_string())], vec![Cell::Integer(5)]]
        );
        engine
            .execute(
                "CREATE TRIGGER au AFTER UPDATE ON t BEGIN INSERT INTO log VALUES (old.a); INSERT INTO log VALUES (new.a); END",
            )
            .expect("after update");
        engine.execute("UPDATE t SET a = 'nine' WHERE id = 5").expect("update");
        assert_eq!(
            engine.execute_one("SELECT v FROM log WHERE rowid > 2").expect("update log").rows,
            vec![vec![Cell::Text("seven".to_string())], vec![Cell::Text("nine".to_string())]]
        );
        engine
            .execute("CREATE TRIGGER bd BEFORE DELETE ON t BEGIN INSERT INTO log VALUES (old.id); END")
            .expect("before delete");
        engine.execute("DELETE FROM t WHERE id = 5").expect("delete");
        assert_eq!(
            engine.execute_one("SELECT v FROM log WHERE rowid = 5").expect("delete log").rows,
            vec![vec![Cell::Integer(5)]]
        );
    }

    #[test]
    fn trigger_when_clause_filters_rows() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER)").expect("t");
        engine.execute("CREATE TABLE log(v)").expect("log");
        engine
            .execute("CREATE TRIGGER w AFTER INSERT ON t WHEN new.a > 5 BEGIN INSERT INTO log VALUES (new.a); END")
            .expect("when trigger");
        engine.execute("INSERT INTO t VALUES (1, 10), (2, 3)").expect("insert");
        assert_eq!(engine.execute_one("SELECT v FROM log").expect("log").rows, vec![vec![Cell::Integer(10)]]);
        engine
            .execute("CREATE TRIGGER wu AFTER UPDATE ON t WHEN old.a = 10 BEGIN INSERT INTO log VALUES (new.a); END")
            .expect("when update");
        engine.execute("UPDATE t SET a = 11 WHERE id = 1").expect("update");
        assert_eq!(
            engine.execute_one("SELECT v FROM log ORDER BY rowid").expect("log rows").rows,
            vec![vec![Cell::Integer(10)], vec![Cell::Integer(11)]]
        );
    }

    #[test]
    fn trigger_creation_reports_sqlite_diagnostics() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a)").expect("t");
        engine.execute("CREATE VIEW vv AS SELECT id, a FROM t").expect("view");
        engine.execute("CREATE TRIGGER d AFTER INSERT ON t BEGIN SELECT 1; END").expect("first trigger");
        let duplicate = engine.execute_one("CREATE TRIGGER d AFTER INSERT ON t BEGIN SELECT 1; END").expect_err("duplicate");
        assert_eq!(duplicate.code, "trigger-exists");
        assert_eq!(duplicate.message, "trigger d already exists");
        // The trigger namespace is separate from tables: a trigger may carry
        // the name of a table.
        engine.execute("CREATE TRIGGER t AFTER INSERT ON t BEGIN SELECT 1; END").expect("trigger named t");
        engine.execute("DROP TRIGGER t").expect("drop trigger named t");
        let missing = engine.execute_one("CREATE TRIGGER m BEFORE INSERT ON missing BEGIN SELECT 1; END").expect_err("missing");
        assert_eq!(missing.message, "no such table: main.missing");
        let after_view =
            engine.execute_one("CREATE TRIGGER tv AFTER INSERT ON vv BEGIN SELECT 1; END").expect_err("after view");
        assert_eq!(after_view.message, "cannot create AFTER trigger on view: vv");
        let before_view =
            engine.execute_one("CREATE TRIGGER tv2 BEFORE INSERT ON vv BEGIN SELECT 1; END").expect_err("before view");
        assert_eq!(before_view.message, "cannot create BEFORE trigger on view: vv");
        let instead_table =
            engine.execute_one("CREATE TRIGGER tt INSTEAD OF INSERT ON t BEGIN SELECT 1; END").expect_err("instead");
        assert_eq!(instead_table.message, "cannot create INSTEAD OF trigger on table: t");
        let no_timing = engine.execute_one("CREATE TRIGGER nt ON t BEGIN SELECT 1; END").expect_err("no timing");
        assert_eq!(no_timing.code, "syntax");
        assert_eq!(no_timing.message, "near \"ON\": syntax error");
        // `DROP TRIGGER` on an object that is not a trigger keeps SQLite's
        // message instead of pointing at the other object family.
        engine.execute("CREATE TABLE u(id INTEGER)").expect("u");
        let wrong = engine.execute_one("DROP TRIGGER u").expect_err("drop table name");
        assert_eq!(wrong.message, "no such trigger: u");
        let absent = engine.execute_one("DROP TRIGGER nope").expect_err("drop missing");
        assert_eq!(absent.message, "no such trigger: nope");
        engine.execute("DROP TRIGGER IF EXISTS nope").expect("drop if exists");
    }

    #[test]
    fn same_event_triggers_fire_newest_first() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a)").expect("t");
        engine.execute("CREATE TABLE log(v)").expect("log");
        for value in 1..=3 {
            engine
                .execute(&format!("CREATE TRIGGER o{value} AFTER INSERT ON t BEGIN INSERT INTO log VALUES ({value}); END"))
                .expect("trigger");
        }
        engine.execute("INSERT INTO t VALUES (1, 1)").expect("insert");
        assert_eq!(
            engine.execute_one("SELECT v FROM log ORDER BY rowid").expect("log").rows,
            vec![vec![Cell::Integer(3)], vec![Cell::Integer(2)], vec![Cell::Integer(1)]]
        );
    }

    #[test]
    fn trigger_bodies_fire_other_tables_but_skip_active_triggers() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE u(id INTEGER PRIMARY KEY, a)").expect("u");
        engine.execute("CREATE TABLE b(id INTEGER PRIMARY KEY, a)").expect("b");
        engine.execute("CREATE TRIGGER ta AFTER INSERT ON u BEGIN INSERT INTO b VALUES (new.id, new.a); END").expect("ta");
        engine.execute("CREATE TRIGGER tb AFTER INSERT ON b BEGIN INSERT INTO u VALUES (new.id + 100, 1); END").expect("tb");
        engine.execute("INSERT INTO u VALUES (1, 1)").expect("insert");
        assert_eq!(
            engine.execute_one("SELECT id FROM u ORDER BY id").expect("u rows").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(101)]]
        );
        assert_eq!(engine.execute_one("SELECT id FROM b ORDER BY id").expect("b rows").rows, vec![vec![Cell::Integer(1)]]);
    }

    #[test]
    fn recursive_triggers_pragma_allows_loops_until_the_depth_limit() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE s(id INTEGER PRIMARY KEY, a)").expect("s");
        engine
            .execute("CREATE TRIGGER loop AFTER INSERT ON s BEGIN INSERT INTO s VALUES (new.id + 1000, new.a); END")
            .expect("loop");
        engine.execute("INSERT INTO s VALUES (1, 1)").expect("recursive off");
        // The trigger fires once for the user row; its own insert does not
        // re-enter the trigger while `recursive_triggers` is off.
        assert_eq!(
            engine.execute_one("SELECT id FROM s ORDER BY id").expect("count").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(1001)]]
        );
        let query = engine.execute_one("PRAGMA recursive_triggers").expect("pragma read");
        assert_eq!(query.rows, vec![vec![Cell::Integer(0)]]);
        engine.execute("PRAGMA recursive_triggers = ON").expect("pragma write");
        assert_eq!(engine.execute_one("PRAGMA recursive_triggers").expect("pragma read").rows, vec![vec![Cell::Integer(1)]]);
        let runaway = engine.execute_one("INSERT INTO s VALUES (2, 2)").expect_err("depth limit");
        assert_eq!(runaway.code, "trigger-depth");
        assert_eq!(runaway.message, "too many levels of trigger recursion");
        // The failed statement leaves nothing behind.
        assert_eq!(
            engine.execute_one("SELECT id FROM s ORDER BY id").expect("count after").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(1001)]]
        );
    }

    #[test]
    fn instead_of_triggers_run_view_dml_and_report_zero_changes() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE base(id INTEGER PRIMARY KEY, a, b)").expect("base");
        engine.execute("CREATE VIEW v AS SELECT id, a FROM base").expect("view");
        let plain = engine.execute_one("INSERT INTO v VALUES (1, 2)").expect_err("plain view");
        assert_eq!(plain.message, "cannot modify v because it is a view");
        engine
            .execute("CREATE TRIGGER vi INSTEAD OF INSERT ON v BEGIN INSERT INTO base(id, a) VALUES (new.id, new.a); END")
            .expect("instead insert");
        let inserted = engine.execute("INSERT INTO v VALUES (7, 8)").expect("view insert").pop().expect("result");
        assert_eq!(inserted.affected, 0);
        assert_eq!(
            engine.execute_one("SELECT id, a FROM base").expect("base rows").rows,
            vec![vec![Cell::Integer(7), Cell::Integer(8)]]
        );
        engine
            .execute("CREATE TRIGGER vu INSTEAD OF UPDATE ON v BEGIN UPDATE base SET a = new.a WHERE id = old.id; END")
            .expect("instead update");
        let updated = engine.execute("UPDATE v SET a = 20 WHERE id = 7").expect("view update").pop().expect("result");
        assert_eq!(updated.affected, 0);
        assert_eq!(
            engine.execute_one("SELECT id, a FROM base").expect("base after update").rows,
            vec![vec![Cell::Integer(7), Cell::Integer(20)]]
        );
        engine
            .execute("CREATE TRIGGER vd INSTEAD OF DELETE ON v BEGIN DELETE FROM base WHERE id = old.id; END")
            .expect("instead delete");
        let deleted = engine.execute("DELETE FROM v WHERE id = 7").expect("view delete").pop().expect("result");
        assert_eq!(deleted.affected, 0);
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM base").expect("base after delete").rows,
            vec![vec![Cell::Integer(0)]]
        );
    }

    #[test]
    fn a_failing_trigger_row_rolls_the_whole_statement_back() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a)").expect("t");
        engine.execute("CREATE TABLE log(v)").expect("log");
        engine.execute("CREATE TRIGGER bad AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.zzz); END").expect("trigger");
        let failed = engine.execute_one("INSERT INTO t VALUES (1, 1), (2, 2)").expect_err("missing column");
        assert_eq!(failed.code, "unknown-column");
        assert_eq!(failed.message, "no such column: new.zzz");
        assert_eq!(engine.execute_one("SELECT count(*) FROM t").expect("t rows").rows, vec![vec![Cell::Integer(0)]]);
        // `new` and `old` sides do not exist for the events that lack them.
        engine
            .execute("CREATE TRIGGER bad_old AFTER INSERT ON t BEGIN INSERT INTO log VALUES (old.a); END")
            .expect("old trigger");
        let wrong_side = engine.execute_one("INSERT INTO t VALUES (3, 3)").expect_err("old on insert");
        assert_eq!(wrong_side.message, "no such column: old.a");
    }

    #[test]
    fn temp_triggers_live_in_temp_master_and_die_with_the_table() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE m(id INTEGER PRIMARY KEY, a)").expect("m");
        engine.execute("CREATE TEMP TABLE tt(id INTEGER PRIMARY KEY, a)").expect("temp table");
        engine
            .execute("CREATE TRIGGER temp.xt AFTER INSERT ON tt BEGIN INSERT INTO m VALUES (new.id, new.a); END")
            .expect("temp trigger");
        assert_eq!(
            engine.execute_one("SELECT type, name FROM sqlite_temp_master").expect("temp master").rows,
            vec![
                vec![Cell::Text("table".to_string()), Cell::Text("tt".to_string())],
                vec![Cell::Text("trigger".to_string()), Cell::Text("xt".to_string())],
            ]
        );
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM sqlite_master WHERE type = 'trigger'").expect("main master").rows,
            vec![vec![Cell::Integer(0)]]
        );
        engine.execute("INSERT INTO tt VALUES (1, 2)").expect("temp insert");
        assert_eq!(
            engine.execute_one("SELECT id, a FROM m").expect("m rows").rows,
            vec![vec![Cell::Integer(1), Cell::Integer(2)]]
        );
        engine.execute("DROP TABLE tt").expect("drop temp");
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM sqlite_temp_master WHERE type = 'trigger'").expect("temp triggers").rows,
            vec![vec![Cell::Integer(0)]]
        );
    }

    #[test]
    fn update_of_column_list_limits_the_event() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a, b)").expect("t");
        engine.execute("CREATE TABLE log(v)").expect("log");
        engine
            .execute("CREATE TRIGGER uo AFTER UPDATE OF a ON t BEGIN INSERT INTO log VALUES (new.a); END")
            .expect("update of");
        engine.execute("INSERT INTO t VALUES (1, 'start', 'start')").expect("seed");
        engine.execute("UPDATE t SET b = 'x'").expect("update b");
        assert_eq!(engine.execute_one("SELECT count(*) FROM log").expect("log after b").rows, vec![vec![Cell::Integer(0)]]);
        engine.execute("UPDATE t SET a = 'y'").expect("update a");
        assert_eq!(engine.execute_one("SELECT v FROM log").expect("log after a").rows, vec![vec![Cell::Text("y".to_string())]]);
    }

    /// 宿主适配器:把文本转成大写,其余值原样返回。
    struct UpperAdapter;

    impl HostRuntimeAdapter for UpperAdapter {
        fn invoke_scalar(&self, _handle: &HostFunctionHandle, args: &[UdfValue]) -> UdfResult<UdfValue> {
            Ok(match &args[0] {
                UdfValue::Text(text) => UdfValue::Text(text.to_ascii_uppercase()),
                other => other.clone(),
            })
        }

        fn invoke_batch(&self, _handle: &HostFunctionHandle, _batches: &[Vec<UdfValue>]) -> UdfResult<Vec<UdfValue>> {
            Err(UdfError::UnsupportedEffect)
        }
    }

    fn scalar_definition(name: &str, args: Vec<UdfType>, returns: UdfType) -> HostMicroDefinition {
        HostMicroDefinition::from_scalar(name, 1, args, returns, 7, format!("host/{name}"), 1, [0u8; 32])
            .expect("definition is valid")
    }

    /// 未注册的宿主名保持 `unknown-function`;注册后按折叠名解析并求值,
    /// 元数不符在执行前拒绝。
    #[test]
    fn host_function_registration_dispatches_and_folds_the_name() {
        let mut engine = Engine::new(None).expect("blank engine");
        let missing = engine.execute_one("SELECT shout('x')").expect_err("unregistered host function");
        assert_eq!(missing.code, "unknown-function");

        engine
            .register_host_function(scalar_definition("shout", vec![UdfType::Text], UdfType::Text), Arc::new(UpperAdapter))
            .expect("register host function");
        assert_eq!(engine.host_function_names(), vec!["shout".to_string()]);
        assert_eq!(engine.execute_one("SELECT SHOUT('x')").expect("host call").rows, vec![vec![Cell::Text("X".to_string())]]);
        let wrong = engine.execute_one("SELECT shout('x', 'y')").expect_err("arity mismatch");
        assert_eq!(wrong.code, "wrong-arguments");
    }

    /// 折叠名与内建函数同名同元数时宿主实现优先;`count(*)` 特殊形态仍走内建。
    #[test]
    fn host_function_replaces_a_builtin_of_the_same_arity() {
        struct Constant;
        impl HostRuntimeAdapter for Constant {
            fn invoke_scalar(&self, _handle: &HostFunctionHandle, _args: &[UdfValue]) -> UdfResult<UdfValue> {
                Ok(UdfValue::I64(7))
            }

            fn invoke_batch(&self, _handle: &HostFunctionHandle, _batches: &[Vec<UdfValue>]) -> UdfResult<Vec<UdfValue>> {
                Err(UdfError::UnsupportedEffect)
            }
        }
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(a)").expect("t");
        engine.execute("INSERT INTO t VALUES ('abc'), ('de')").expect("seed");
        engine
            .register_host_function(scalar_definition("length", vec![UdfType::Any], UdfType::I64), Arc::new(Constant))
            .expect("register host function");
        let rows = engine.execute_one("SELECT length(a) FROM t").expect("host call").rows;
        assert_eq!(rows, vec![vec![Cell::Integer(7)], vec![Cell::Integer(7)]]);
        assert_eq!(
            engine.execute_one("SELECT count(*) FROM t").expect("count stays builtin").rows,
            vec![vec![Cell::Integer(2)]]
        );
    }

    /// 一次完整的 `VACUUM`:重建后 freelist 清空、镜像变小,schema 与行不变。
    #[test]
    fn vacuum_rebuilds_the_image_and_clears_the_freelist() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute(
                "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);
                 CREATE INDEX t_v ON t(v);
                 CREATE TABLE wo(k TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
                 CREATE TABLE ex(a INT, b TEXT);
                 CREATE INDEX ex_lower ON ex(lower(b));
                 CREATE TABLE col(c TEXT COLLATE NOCASE);
                 CREATE TABLE ai(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
                 CREATE TABLE orphan(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
                 CREATE VIEW vv AS SELECT id, v FROM t;
                 CREATE TABLE log(x);
                 CREATE TABLE dropped(z);
                 INSERT INTO dropped VALUES ('z');
                 DROP TABLE orphan",
            )
            .expect("schema");
        for value in 1..=200 {
            engine.execute(&format!("INSERT INTO t VALUES ({value}, 'v{value}')")).expect("row");
            engine.execute(&format!("INSERT INTO ex VALUES ({value}, 'B{value}')")).expect("expression row");
        }
        engine.execute("INSERT INTO wo VALUES ('k', 1); INSERT INTO col VALUES ('Q')").expect("side tables");
        engine
            .execute("INSERT INTO ai(v) VALUES ('a'), ('b'), ('c'); DELETE FROM ai WHERE id = 3")
            .expect("autoincrement high-water mark");
        engine.execute("DELETE FROM t WHERE id % 2 = 0; DROP TABLE dropped").expect("free pages");
        engine
            .execute("PRAGMA user_version = 7; PRAGMA application_id = 42; CREATE TEMP TABLE tt(x); INSERT INTO tt VALUES (1)")
            .expect("session state");
        engine.execute("CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.v); END").expect("trigger");
        let before = engine.snapshot().expect("image").to_vec();
        assert!(read_freelist_count(&before) > 0, "the drop must leave freelist pages");

        engine.execute_one("VACUUM").expect("vacuum");
        let after = engine.snapshot().expect("image").to_vec();
        assert_eq!(read_freelist_count(&after), 0);
        assert!(after.len() < before.len(), "vacuum must compact the image: {} -> {}", before.len(), after.len());
        assert_eq!(engine.execute_one("PRAGMA integrity_check").expect("check").rows, vec![vec![text("ok")]]);
        assert_eq!(engine.execute_one("SELECT count(*) FROM t").expect("rows").rows, vec![vec![Cell::Integer(100)]]);
        assert_eq!(
            engine.execute_one("SELECT * FROM wo").expect("without rowid").rows,
            vec![vec![text("k"), Cell::Integer(1)]]
        );
        assert_eq!(
            engine.execute_one("SELECT a FROM ex WHERE lower(b) = 'b7'").expect("expression index").rows,
            vec![vec![Cell::Integer(7)]]
        );
        assert_eq!(engine.execute_one("SELECT c FROM col WHERE c = 'q'").expect("collation").rows, vec![vec![text("Q")]]);
        assert_eq!(engine.execute_one("SELECT count(*) FROM vv").expect("view").rows, vec![vec![Cell::Integer(100)]]);
        assert_eq!(engine.execute_one("PRAGMA user_version").expect("version").rows, vec![vec![Cell::Integer(7)]]);
        assert_eq!(engine.execute_one("PRAGMA application_id").expect("application").rows, vec![vec![Cell::Integer(42)]]);
        // 临时对象跟随会话,不参与主库重建。
        assert_eq!(engine.execute_one("SELECT * FROM tt").expect("temp table").rows, vec![vec![Cell::Integer(1)]]);
        // AUTOINCREMENT 高水位跨重建保留,下一行继续从 4 开始。
        assert_eq!(
            engine.execute_one("SELECT seq FROM sqlite_sequence WHERE name = 'ai'").expect("sequence").rows,
            vec![vec![Cell::Integer(3)]]
        );
        // 最后一个 AUTOINCREMENT 表被删后留下的空 `sqlite_sequence` 也照旧存在。
        let sequence_tables = engine.execute_one("SELECT count(*) FROM sqlite_sequence").expect("sequence table kept").rows;
        assert_eq!(sequence_tables, vec![vec![Cell::Integer(1)]]);
        engine.execute("INSERT INTO ai(v) VALUES ('d')").expect("next autoincrement row");
        assert_eq!(engine.execute_one("SELECT max(id) FROM ai").expect("id").rows, vec![vec![Cell::Integer(4)]]);
        // 触发器在重建后照常触发。
        engine.execute("INSERT INTO t VALUES (201, 'after')").expect("insert after vacuum");
        assert_eq!(engine.execute_one("SELECT x FROM log").expect("log").rows, vec![vec![text("after")]]);
        // `CREATE` 文本与表名逐字节保留。
        let master = engine
            .execute_one(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('t','wo','ex','col') ORDER BY name",
            )
            .expect("master");
        assert_eq!(
            master.rows,
            vec![
                vec![text("col"), text("CREATE TABLE col(c TEXT COLLATE NOCASE)")],
                vec![text("ex"), text("CREATE TABLE ex(a INT, b TEXT)")],
                vec![text("t"), text("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")],
                vec![text("wo"), text("CREATE TABLE wo(k TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID")],
            ]
        );
    }

    /// `VACUUM INTO` 写出重建副本,源镜像逐字节不变。
    #[test]
    fn vacuum_into_writes_a_rebuilt_copy_without_touching_the_source() {
        let directory = temp_directory("vacuum-into");
        let target = directory.join("copy.db");
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute(
                "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);
                 CREATE INDEX t_v ON t(v);
                 CREATE TABLE wo(k TEXT PRIMARY KEY) WITHOUT ROWID;
                 CREATE TABLE discarded(z)",
            )
            .expect("schema");
        for value in 1..=50 {
            engine.execute(&format!("INSERT INTO t VALUES ({value}, 'v{value}')")).expect("row");
        }
        engine.execute("INSERT INTO wo VALUES ('a'); DROP TABLE discarded").expect("free pages");
        let before = engine.snapshot().expect("image").to_vec();
        engine.execute_one(&format!("VACUUM INTO '{}'", target.display())).expect("vacuum into");
        assert_eq!(engine.snapshot().expect("image"), before.as_slice(), "VACUUM INTO must leave the source image alone");

        let bytes = std::fs::read(&target).expect("target written");
        assert_eq!(read_freelist_count(&bytes), 0);
        let mut copy = Engine::from_writer(SqliteWriter::from_pages(bytes).expect("open copy")).expect("copy catalog");
        assert_eq!(copy.execute_one("PRAGMA integrity_check").expect("check").rows, vec![vec![text("ok")]]);
        assert_eq!(copy.execute_one("SELECT count(*) FROM t").expect("rows").rows, vec![vec![Cell::Integer(50)]]);
        assert_eq!(copy.execute_one("SELECT * FROM wo").expect("without rowid").rows, vec![vec![text("a")]]);

        // `INTO` 目标可以是参数,槽位与绑定规则和其他语句一致。
        let bound = directory.join("bound.db");
        engine.execute_with_parameters("VACUUM INTO ?", &[Cell::Text(bound.display().to_string())]).expect("bound target");
        assert!(bound.exists(), "a bound target writes the same rebuilt copy");
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// 目标已存在(含与源同路径)、父目录缺失与非文本目标按上游拒绝。
    #[test]
    fn vacuum_into_rejects_an_existing_or_unusable_target() {
        let directory = temp_directory("vacuum-into-errors");
        let target = directory.join("taken.db");
        std::fs::write(&target, b"occupied").expect("seed target");
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(a)").expect("table");

        let existing = engine.execute_one(&format!("VACUUM INTO '{}'", target.display())).expect_err("existing target");
        assert_eq!(existing.code, "SQLITE_ERROR");
        assert_eq!(existing.message, "output file already exists");
        assert_eq!(std::fs::read(&target).expect("target kept"), b"occupied");

        let missing = engine
            .execute_one(&format!("VACUUM INTO '{}'", directory.join("missing").join("x.db").display()))
            .expect_err("missing parent");
        assert_eq!(missing.code, "SQLITE_CANTOPEN");
        assert!(missing.message.starts_with("unable to open database: "), "unexpected message: {}", missing.message);

        let directory_target =
            engine.execute_one(&format!("VACUUM INTO '{}'", directory.display())).expect_err("directory target");
        assert_eq!(directory_target.code, "SQLITE_CANTOPEN");

        let not_text = engine.execute_one("VACUUM INTO 5").expect_err("numeric target");
        assert_eq!(not_text.code, "SQLITE_ERROR");
        assert_eq!(not_text.message, "non-text filename");

        // 与源同路径同样按“已存在”拒绝,源文件一个字节都不改。
        let source = directory.join("source.db");
        let original = engine.snapshot().expect("image").to_vec();
        std::fs::write(&source, &original).expect("seed source");
        let same = engine.execute_one(&format!("VACUUM INTO '{}'", source.display())).expect_err("same source");
        assert_eq!(same.message, "output file already exists");
        assert_eq!(std::fs::read(&source).expect("source kept"), original);

        // 空文件名与 `:memory:` 与上游一样成功且不落盘。
        engine.execute_one("VACUUM INTO ''").expect("empty target");
        engine.execute_one("VACUUM INTO ':memory:'").expect("memory target");
        assert_eq!(std::fs::read_dir(&directory).expect("list").count(), 2);
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// `VACUUM` 在事务里(含只有 `SAVEPOINT` 的作用域)被拒绝。
    #[test]
    fn vacuum_is_rejected_inside_a_transaction() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(a)").expect("table");
        engine.execute("BEGIN").expect("transaction");
        for statement in ["VACUUM", "VACUUM INTO 'ignored.db'"] {
            let error = engine.execute_one(statement).expect_err("transaction blocks vacuum");
            assert_eq!(error.code, "SQLITE_ERROR");
            assert_eq!(error.message, "cannot VACUUM from within a transaction");
        }
        engine.execute("ROLLBACK").expect("rollback");

        engine.execute("SAVEPOINT s").expect("savepoint");
        assert_eq!(
            engine.execute_one("VACUUM").expect_err("savepoint scope").message,
            "cannot VACUUM from within a transaction"
        );
        engine.execute("RELEASE s").expect("release");
        engine.execute_one("VACUUM").expect("autocommit vacuum");
    }

    /// `VACUUM temp` 是空操作,`VACUUM temp INTO` 写出空库。
    #[test]
    fn vacuum_temp_is_a_no_op_and_vacuum_temp_into_writes_an_empty_database() {
        let directory = temp_directory("vacuum-temp");
        let target = directory.join("empty.db");
        let mut engine = Engine::new(None).expect("blank engine");
        engine.execute("CREATE TABLE t(a); CREATE TEMP TABLE tt(x); INSERT INTO tt VALUES (1)").expect("schema");
        engine.execute_one("VACUUM temp").expect("temp vacuum");
        assert_eq!(engine.execute_one("SELECT * FROM tt").expect("temp table").rows, vec![vec![Cell::Integer(1)]]);
        engine.execute_one(&format!("VACUUM temp INTO '{}'", target.display())).expect("temp into");
        let mut copy = Engine::from_writer(SqliteWriter::open(&target).expect("open empty copy")).expect("copy catalog");
        assert_eq!(
            copy.execute_one("SELECT count(*) FROM sqlite_master").expect("schema rows").rows,
            vec![vec![Cell::Integer(0)]]
        );
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// `VACUUM aux` 重建附加库并落回它自己的文件。
    #[test]
    fn vacuum_rebuilds_an_attached_database() {
        let directory = temp_directory("vacuum-attached");
        let file = directory.join("aux.db");
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute(&format!(
                "ATTACH DATABASE '{}' AS aux;
                 CREATE TABLE aux.t(id INTEGER PRIMARY KEY, v TEXT);
                 CREATE TABLE aux.discarded(z);
                 INSERT INTO aux.t VALUES (1, 'a'), (2, 'b');
                 DROP TABLE aux.discarded",
                file.display()
            ))
            .expect("attached schema");
        engine.execute_one("VACUUM aux").expect("vacuum attached");
        assert_eq!(
            engine.execute_one("SELECT id, v FROM aux.t ORDER BY id").expect("attached rows").rows,
            vec![vec![Cell::Integer(1), text("a")], vec![Cell::Integer(2), text("b")]]
        );
        let mut reopened =
            Engine::from_writer(SqliteWriter::open(&file).expect("open attached file")).expect("attached catalog");
        assert_eq!(reopened.execute_one("SELECT count(*) FROM t").expect("file rows").rows, vec![vec![Cell::Integer(2)]]);
        assert_eq!(reopened.execute_one("PRAGMA integrity_check").expect("check").rows, vec![vec![text("ok")]]);
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// `VACUUM INTO` 的产物由真实 SQLite 打开并通过 `integrity_check`。
    #[test]
    fn vacuum_into_is_readable_by_upstream_sqlite() {
        let Some(python) = reference_python()
        else {
            eprintln!("skipped: no python3/python with the sqlite3 module");
            return;
        };
        let directory = temp_directory("vacuum-upstream");
        let target = directory.join("upstream.db");
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute(
                "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);
                 CREATE INDEX t_v ON t(v);
                 CREATE TABLE wo(k TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
                 CREATE TABLE ex(a INT, b TEXT);
                 CREATE INDEX ex_lower ON ex(lower(b));
                 CREATE TABLE col(c TEXT COLLATE NOCASE);
                 CREATE VIEW vv AS SELECT id, v FROM t;
                 CREATE TABLE log(x);
                 CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.v); END",
            )
            .expect("schema");
        for value in 1..=40 {
            engine.execute(&format!("INSERT INTO t VALUES ({value}, 'v{value}')")).expect("row");
            engine.execute(&format!("INSERT INTO ex VALUES ({value}, 'B{value}')")).expect("expression row");
        }
        engine.execute("INSERT INTO wo VALUES ('k', 7); INSERT INTO col VALUES ('Q')").expect("side tables");
        engine.execute(&format!("VACUUM INTO '{}'", target.display())).expect("vacuum into");

        let script = r#"
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "integrity_check"
assert db.execute("SELECT count(*) FROM t").fetchone() == (40,), "rows"
assert db.execute("SELECT count(*) FROM ex WHERE lower(b) = 'b7'").fetchone() == (1,), "expression index"
assert db.execute("SELECT c FROM col WHERE c = 'q'").fetchone() == ("Q",), "collation"
assert db.execute("SELECT count(*) FROM vv").fetchone() == (40,), "view"
assert db.execute("SELECT name FROM sqlite_master WHERE name = 'tr'").fetchone() == ("tr",), "trigger"
db.execute("INSERT INTO t VALUES (41, 'upstream')")
assert db.execute("SELECT count(*) FROM log WHERE x = 'upstream'").fetchone() == (1,), "trigger body"
db.close()
"#;
        let output = std::process::Command::new(python)
            .args(["-c", script, target.to_str().expect("utf-8 path")])
            .output()
            .expect("spawn upstream sqlite");
        assert!(
            output.status.success(),
            "upstream SQLite rejected the vacuum image: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// 每次调用生成一个唯一的临时目录,由调用方负责删除。
    fn temp_directory(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock is ahead of unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "sqlite-{label}-{}-{stamp}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        directory
    }

    /// 只读一列的投影必须与整行解码得到同一批行:未读列的掩码只是不构造
    /// `Cell`,不能改变 WHERE、ORDER BY、DISTINCT 或聚合看到的值。
    #[test]
    fn column_masks_preserve_projected_rows() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_batch(&[
                "CREATE TABLE t(id INTEGER PRIMARY KEY, label TEXT, score REAL, payload BLOB, note TEXT)".to_string(),
                "INSERT INTO t VALUES (1, 'alpha', 1.5, x'0102', NULL), (2, 'beta', NULL, NULL, 'x'), (3, NULL, 2.25, x'ff', 'y')".to_string(),
            ])
            .expect("seed");
        let full = engine.execute_one("SELECT id, label, score, payload, note FROM t").expect("full decode").rows;
        assert_eq!(
            engine.execute_one("SELECT id FROM t").expect("id projection").rows,
            full.iter().map(|row| vec![row[0].clone()]).collect::<Vec<_>>()
        );
        assert_eq!(
            engine.execute_one("SELECT label FROM t ORDER BY id DESC").expect("label projection").rows,
            full.iter().rev().map(|row| vec![row[1].clone()]).collect::<Vec<_>>()
        );
        assert_eq!(
            engine.execute_one("SELECT count(*), sum(score), min(score), max(score) FROM t").expect("aggregate").rows,
            vec![vec![Cell::Integer(3), Cell::Real(3.75), Cell::Real(1.5), Cell::Real(2.25)]]
        );
        // An unprojected column still filters and sorts by its decoded value.
        assert_eq!(
            engine.execute_one("SELECT id FROM t WHERE label = 'beta'").expect("filter").rows,
            vec![vec![Cell::Integer(2)]]
        );
        assert_eq!(
            engine.execute_one("SELECT id FROM t ORDER BY label DESC").expect("sort").rows,
            vec![vec![Cell::Integer(2)], vec![Cell::Integer(1)], vec![Cell::Integer(3)]]
        );
        assert_eq!(
            engine.execute_one("SELECT DISTINCT label FROM t ORDER BY label").expect("distinct").rows,
            vec![vec![Cell::Null], vec![Cell::Text("alpha".to_string())], vec![Cell::Text("beta".to_string())]]
        );
        // A short record from `ALTER TABLE ADD COLUMN` reads its default through
        // the same mask when the new column is the only projection.
        engine.execute_one("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'd'").expect("add column");
        assert_eq!(
            engine.execute_one("SELECT extra FROM t ORDER BY id").expect("default").rows,
            vec![vec![Cell::Text("d".to_string())]; 3]
        );
    }

    /// 连接计数走裁剪后的行集与 rowid 探针时,行数必须与非连接的全扫描
    /// `WHERE` 路径逐行一致。
    #[test]
    fn pruned_join_count_matches_nested_scan() {
        let mut engine = Engine::new(None).expect("blank engine");
        let mut batch = vec!["CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT, score REAL)".to_string()];
        for row in 1..=200 {
            batch.push(format!("INSERT INTO items VALUES ({row}, 'row-{row}', {})", row as f64 / 4.0));
        }
        engine.execute_batch(&batch).expect("seed");
        let joined =
            engine.execute_one("SELECT count(*) FROM items JOIN items AS b ON b.id = items.id % 7").expect("join").rows;
        let nested =
            engine.execute_one("SELECT count(*) FROM items, items AS b WHERE b.id = items.id % 7").expect("nested").rows;
        assert_eq!(joined, nested);
        // Rowids 7, 14, ..., 196 probe key 0, which has no row, so 200 - 28 remain.
        assert_eq!(joined, vec![vec![Cell::Integer(172)]]);
        // Materializing the join keeps the left-major order and both columns.
        assert_eq!(
            engine
                .execute_one(
                    "SELECT items.id, b.label FROM items JOIN items AS b ON b.id = items.id % 7 WHERE items.id <= 20 ORDER BY items.id"
                )
                .expect("join projection")
                .rows,
            engine
                .execute_one("SELECT items.id, b.label FROM items, items AS b WHERE b.id = items.id % 7 AND items.id <= 20 ORDER BY items.id")
                .expect("nested projection")
                .rows
        );
    }

    /// 索引区间读取只解码投影与谓词需要的列时,行集和按索引首列的顺序都
    /// 必须与去掉索引后的全扫描一致。
    #[test]
    fn masked_index_range_matches_full_scan() {
        let mut engine = Engine::new(None).expect("blank engine");
        engine
            .execute_batch(&[
                "CREATE TABLE words(id INTEGER PRIMARY KEY, label TEXT, score REAL)".to_string(),
                "CREATE UNIQUE INDEX words_label ON words(label)".to_string(),
                "INSERT INTO words VALUES (1, 'b', 1.0), (2, 'a', 2.0), (3, 'aa', 3.0), (4, 'ab', 4.0), (5, 'a10', 5.0), (6, 'b0', 6.0)"
                    .to_string(),
            ])
            .expect("seed");
        let sql = "SELECT id FROM words WHERE label BETWEEN 'a' AND 'b' ORDER BY label";
        let indexed = engine.execute_one(sql).expect("index range").rows;
        engine.execute_one("DROP INDEX words_label").expect("drop index");
        let scanned = engine.execute_one(sql).expect("full scan").rows;
        assert_eq!(indexed, scanned);
        assert_eq!(
            indexed,
            vec![
                vec![Cell::Integer(2)],
                vec![Cell::Integer(5)],
                vec![Cell::Integer(3)],
                vec![Cell::Integer(4)],
                vec![Cell::Integer(1)]
            ]
        );
    }

    /// 第一个装有 `sqlite3` 模块的解释器,与互操作用例同一探测口径。
    fn reference_python() -> Option<String> {
        ["python3", "python"].into_iter().find_map(|candidate| {
            std::process::Command::new(candidate)
                .args(["-c", "import sqlite3"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
                .then(|| candidate.to_string())
        })
    }
}
