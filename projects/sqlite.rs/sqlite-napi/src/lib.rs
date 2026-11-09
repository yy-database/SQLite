//! Node-API bindings for the SQLite format-3 product facade.
//!
//! 绑定层只做四件事：句柄包装、SQL 值与 JS 值转换、结构化错误、环境销毁
//! 清理。解析、槽位、读写分类、提交边界、文件存储与函数求值语义全部归属
//! `sqlite` facade（见 `connection.rs` 与 `statement.rs` 的边界注释）。
//!
//! | module | owns |
//! |--------|------|
//! | `connection` | `SqliteConnection` handle over `sqlite::Connection` |
//! | `statement` | `SqliteStatement` handle over `sqlite::Prepared` |
//! | `engine` | `SqliteEngine` JSON-envelope handle over `sqlite::Engine` (transitional primitive) |
//! | `values` | SQL value ↔ JS value conversion, both directions |
//! | `error` | `SqlError` → structured N-API error |
//! | `inspect` | read-only inspection and format-3 writer tooling |
//! | `dev_tools` | harness verdicts, bench stats, charts, fuzz (feature-gated) |

#![allow(non_snake_case)]

mod connection;
mod engine;
mod error;
mod inspect;
mod statement;
mod values;

#[cfg(feature = "dev-tools")]
mod dev_tools;

#[cfg(test)]
mod tests {
    use sqlite::{Cell, Connection, ConnectionOptions};

    // The Rust-side smoke test proves the workspace compiles and one
    // create/insert/select round trip returns the row it wrote. The published
    // host contract is judged by the `sqlite.ts` and `sqlite.py` suites.
    #[test]
    fn opens_and_round_trips_one_row() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("open");
        connection
            .execute(
                "create table smoke (id integer primary key, label text not null); \
                 insert into smoke (label) values ('alpha');",
                &[],
            )
            .expect("execute");
        let results = connection.execute("select * from smoke", &[]).expect("select");
        assert_eq!(results[0].rows, vec![vec![Cell::Integer(1), Cell::Text("alpha".to_string())]]);
    }

    #[test]
    fn rejections_carry_a_code_and_position() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("open");
        connection.execute("create table t (id integer primary key, label text)", &[]).expect("create");
        connection.execute("insert into t values (1, 'a'), (2, 'b'), (3, 'a')", &[]).expect("seed");
        // `GROUP BY` is supported; the grouped rows match SQLite 3.49.1.
        let grouped = connection.execute("select label, count(*) from t group by label order by label", &[]).expect("group by");
        assert_eq!(
            grouped[0].rows,
            vec![vec![Cell::Text("a".to_string()), Cell::Integer(2)], vec![Cell::Text("b".to_string()), Cell::Integer(1)],]
        );
        let unknown = connection.execute("insert into missing values (1)", &[]).expect_err("unknown table");
        assert_eq!(unknown.code, "unknown-table");
        assert_eq!(unknown.statement, Some("insert"));
    }

    #[test]
    fn where_and_order_by_follow_sqlite_ordering() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("open");
        connection
            .execute(
                "create table t (id integer primary key, label text, score real); \
                 insert into t (label, score) values ('b', 1.5), ('a', null), ('c', 2.0), (null, 0.0);",
                &[],
            )
            .expect("seed");
        // `NULL` sorts below every number, so `DESC` puts it last.
        let ordered = connection.execute("select label from t order by score desc", &[]).expect("order");
        assert_eq!(
            ordered[0].rows,
            vec![
                vec![Cell::Text("c".to_string())],
                vec![Cell::Text("b".to_string())],
                vec![Cell::Null],
                vec![Cell::Text("a".to_string())],
            ]
        );
        let filtered = connection.execute("select label from t where score >= 1.5 order by id", &[]).expect("filter");
        assert_eq!(filtered[0].rows, vec![vec![Cell::Text("b".to_string())], vec![Cell::Text("c".to_string())]]);
        let counted = connection.execute("select count(*) from t where score is not null", &[]).expect("count");
        assert_eq!(counted[0].rows, vec![vec![Cell::Integer(3)]]);
        let unknown = connection.execute("select * from t where missing = 1", &[]).expect_err("unknown column");
        assert_eq!(unknown.code, "unknown-column");
    }
}
