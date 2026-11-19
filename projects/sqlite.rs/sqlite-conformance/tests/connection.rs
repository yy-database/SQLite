//! SQLite 门面 `Connection` 行为矩阵(自上游 `sqlite::connection` 内嵌测试模块
//! 下移,测试名保留原身份)。故障注入、journal 与跨进程锁只走公开面:
//! `sqlite` 门面、`database_storage::sqlite::journal` 与 Python 参考引擎。

use sqlite::{Cell, Connection, ConnectionOptions, JournalMode};

mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    /// 每次调用生成唯一临时目录,返回其中的数据库路径。
    fn temp_path(label: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock is ahead of unix epoch").as_nanos();
        let directory = std::env::temp_dir().join(format!("sqlite-connection-{label}-{stamp}-{}", SEQUENCE.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&directory).expect("temp directory");
        directory.join("db.sqlite")
    }

    /// 当前进程的常驻内存字节数,用于对照物化与惰性扫描的内存增量。
    ///
    /// 测试只在能读到真实 RSS 的平台上比较;其他平台返回 `None`,行数与
    /// 顺序断言仍然执行。
    fn resident_bytes() -> Option<u64> {
        #[cfg(windows)]
        {
            #[repr(C)]
            struct ProcessMemoryCounters {
                cb: u32,
                page_fault_count: u32,
                peak_working_set_size: usize,
                working_set_size: usize,
                quota_peak_paged_pool_usage: usize,
                quota_paged_pool_usage: usize,
                quota_peak_non_paged_pool_usage: usize,
                quota_non_paged_pool_usage: usize,
                pagefile_usage: usize,
                peak_pagefile_usage: usize,
            }
            #[link(name = "psapi")]
            unsafe extern "system" {
                fn GetCurrentProcess() -> isize;
                fn GetProcessMemoryInfo(process: isize, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
            }
            let mut counters = ProcessMemoryCounters {
                cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
                page_fault_count: 0,
                peak_working_set_size: 0,
                working_set_size: 0,
                quota_peak_paged_pool_usage: 0,
                quota_paged_pool_usage: 0,
                quota_peak_non_paged_pool_usage: 0,
                quota_non_paged_pool_usage: 0,
                pagefile_usage: 0,
                peak_pagefile_usage: 0,
            };
            // SAFETY: `counters` is a valid, correctly sized writable buffer and
            // `GetCurrentProcess` returns a pseudo handle for this process.
            let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
            return (ok != 0).then_some(counters.working_set_size as u64);
        }
        #[cfg(target_os = "linux")]
        {
            let status = fs::read_to_string("/proc/self/status").ok()?;
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    let kib = rest.trim().trim_end_matches("kB").trim().parse::<u64>().ok()?;
                    return Some(kib * 1024);
                }
            }
            None
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            None
        }
    }

    /// 以只读连接重新打开文件,返回 `SELECT` 的行,验证磁盘上的真实内容。
    fn rows_on_disk(path: &Path, sql: &str) -> Vec<Vec<Cell>> {
        let mut reader = Connection::open(ConnectionOptions { filename: Some(path.to_path_buf()), read_only: true, ..Default::default() })
            .expect("reopen file");
        let results = reader.execute(sql, &[]).expect("read committed image");
        results.last().expect("at least one result").rows.clone()
    }

    #[test]
    fn opening_a_missing_file_creates_and_publishes_it() {
        let path = temp_path("create");
        assert!(!path.exists());
        let mut connection = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("create opens");
        assert!(path.exists(), "a created file database carries its initial image");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t").len(), 0);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn missing_file_without_create_is_not_found() {
        let path = temp_path("missing");
        let error = Connection::open(ConnectionOptions { filename: Some(path.join("absent.sqlite")), create: false, ..Default::default() })
            .expect_err("file is absent");
        assert_eq!(error.code, "not-found");
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn prepare_reports_authoritative_slots() {
        let connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        let prepared = connection.prepare("INSERT INTO t VALUES (?, :name, ?)").expect("parses");
        assert_eq!(prepared.slots(), &[(0, "?".to_string()), (1, ":name".to_string()), (2, "?".to_string())]);
        assert_eq!(prepared.parameter_count(), 3);
        assert!(prepared.is_write());
        assert_eq!(prepared.statement_name(), "insert");

        // `VACUUM INTO` 的目标是普通参数槽位;只有不带 `INTO` 的 `VACUUM` 写镜像。
        let into = connection.prepare("VACUUM INTO ?").expect("vacuum parses");
        assert_eq!(into.slots(), &[(0, "?".to_string())]);
        assert_eq!(into.statement_name(), "vacuum");
        assert!(!into.is_write(), "VACUUM INTO reads the source and writes another file");
        assert!(connection.prepare("VACUUM").expect("plain vacuum parses").is_write());
        assert!(connection.prepare("VACUUM").expect("plain vacuum parses").columns().is_none());
    }

    #[test]
    fn prepare_enforces_exactly_one_statement() {
        let connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        assert_eq!(connection.prepare("").expect_err("empty input").code, "empty-statement");
        assert_eq!(connection.prepare("SELECT 1; SELECT 2").expect_err("two statements").code, "multiple-statements");
    }

    /// 连接层注册的宿主函数在 `prepare` 与 `execute` 两条路径上都可解析求值。
    #[test]
    fn host_functions_registered_on_the_connection_reach_prepare_and_execute() {
        use sqlite::{HostFunctionHandle, HostMicroDefinition, HostRuntimeAdapter, UdfError, UdfResult, UdfType, UdfValue};

        struct Constant;
        impl HostRuntimeAdapter for Constant {
            fn invoke_scalar(&self, _handle: &HostFunctionHandle, _args: &[UdfValue]) -> UdfResult<UdfValue> {
                Ok(UdfValue::I64(42))
            }

            fn invoke_batch(&self, _handle: &HostFunctionHandle, _batches: &[Vec<UdfValue>]) -> UdfResult<Vec<UdfValue>> {
                Err(UdfError::UnsupportedEffect)
            }
        }

        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        let definition =
            HostMicroDefinition::from_scalar("answer", 1, Vec::new(), UdfType::I64, 7, "host/answer", 1, [0u8; 32]).expect("definition");
        connection.register_host_function(definition, Arc::new(Constant)).expect("register host function");
        let prepared = connection.prepare("SELECT answer()").expect("host function parses");
        assert_eq!(connection.run(&prepared, &[]).expect("prepared run").rows, vec![vec![Cell::Integer(42)]]);
        assert_eq!(connection.execute("SELECT ANSWER()", &[]).expect("script run")[0].rows, vec![vec![Cell::Integer(42)]]);
    }

    #[test]
    fn run_rejects_missing_parameters() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("table exists");
        let prepared = connection.prepare("INSERT INTO t VALUES (?, ?)").expect("parses");
        let error = connection.run(&prepared, &[Cell::Integer(1)]).expect_err("one parameter short");
        assert_eq!(error.code, "bind-parameter");
        assert_eq!(error.statement, Some("insert"));
    }

    #[test]
    fn read_only_rejects_writes_before_execution() {
        let mut connection = Connection::open(ConnectionOptions { read_only: true, ..Default::default() }).expect("read-only connection");
        let error = connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect_err("write rejected");
        assert_eq!(error.code, "read-only");
        let prepared = connection.prepare("INSERT INTO t VALUES (1)").expect("parses");
        assert_eq!(connection.run(&prepared, &[]).expect_err("write rejected").code, "read-only");
        let rows = connection.execute("SELECT 1", &[]).expect("reads still work").last().expect("result").rows.clone();
        assert_eq!(rows, vec![vec![Cell::Integer(1)]]);
    }

    /// 建表并一次性插入 `rows` 行 `(id, label)`,行内容可独立预言。
    fn seed_rows(connection: &mut Connection, rows: usize) {
        connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)", &[]).expect("create");
        let mut sql = String::from("INSERT INTO t (id, label) VALUES ");
        for id in 1..=rows {
            if id > 1 {
                sql.push(',');
            }
            sql.push_str(&format!("({id}, 'row-{id}')"));
        }
        connection.execute(&sql, &[]).expect("seed");
    }

    #[test]
    fn cursors_read_bounded_windows_in_order() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_rows(&mut connection, 1000);
        let prepared = connection.prepare("SELECT id, label FROM t ORDER BY id").expect("parses");
        let opened = connection.open_cursor(&prepared, &[]).expect("cursor opens");
        assert_eq!(opened.columns, vec!["id".to_string(), "label".to_string()]);

        let mut seen = 0_i64;
        loop {
            let batch = connection.cursor_next(opened.handle, 256).expect("window");
            assert!(batch.rows.len() <= 256, "the window is bounded");
            for row in &batch.rows {
                seen += 1;
                assert_eq!(row, &vec![Cell::Integer(seen), Cell::Text(format!("row-{seen}"))]);
            }
            if batch.done {
                break;
            }
        }
        assert_eq!(seen, 1000);

        connection.cursor_close(opened.handle).expect("close");
        connection.cursor_close(opened.handle).expect("close is idempotent");
        assert_eq!(connection.cursor_count(), 0);
        assert_eq!(connection.cursor_next(opened.handle, 1).expect_err("released").code, "cursor-not-found");
    }

    #[test]
    fn two_cursors_on_one_connection_read_independently() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_rows(&mut connection, 10);
        let ascending = connection.prepare("SELECT id FROM t ORDER BY id").expect("parses");
        let descending = connection.prepare("SELECT id FROM t ORDER BY id DESC").expect("parses");
        let first = connection.open_cursor(&ascending, &[]).expect("first cursor");
        let second = connection.open_cursor(&descending, &[]).expect("second cursor");

        assert_eq!(
            connection.cursor_next(first.handle, 3).expect("first window").rows,
            vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(3)]]
        );
        assert_eq!(
            connection.cursor_next(second.handle, 3).expect("second window").rows,
            vec![vec![Cell::Integer(10)], vec![Cell::Integer(9)], vec![Cell::Integer(8)]]
        );
        assert_eq!(
            connection.cursor_next(first.handle, 3).expect("first continues").rows,
            vec![vec![Cell::Integer(4)], vec![Cell::Integer(5)], vec![Cell::Integer(6)]]
        );
        assert_eq!(connection.cursor_next(second.handle, 20).expect("second finishes").done, true);
        connection.cursor_close(first.handle).expect("close first");
        connection.cursor_close(second.handle).expect("close second");
    }

    #[test]
    fn a_transaction_ending_invalidates_cursors_opened_inside_it() {
        for control in ["ROLLBACK", "COMMIT"] {
            let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
            seed_rows(&mut connection, 10);
            let prepared = connection.prepare("SELECT id FROM t ORDER BY id").expect("parses");
            connection.execute("BEGIN", &[]).expect("begin");
            let opened = connection.open_cursor(&prepared, &[]).expect("cursor opens inside the transaction");
            assert_eq!(connection.cursor_next(opened.handle, 2).expect("rows before the end").rows.len(), 2);
            connection.execute(control, &[]).expect("transaction ends");
            let error = connection.cursor_next(opened.handle, 2).expect_err("the cursor is stale");
            assert_eq!(error.code, "cursor-expired");
            connection.cursor_close(opened.handle).expect("the stale cursor still closes");
            assert_eq!(connection.cursor_count(), 0);
        }
    }

    #[test]
    fn an_autocommit_cursor_survives_a_later_transaction() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_rows(&mut connection, 10);
        let prepared = connection.prepare("SELECT id FROM t ORDER BY id").expect("parses");
        let opened = connection.open_cursor(&prepared, &[]).expect("autocommit cursor");
        connection.execute("BEGIN", &[]).expect("begin");
        connection.execute("COMMIT", &[]).expect("commit");
        assert_eq!(connection.cursor_next(opened.handle, 3).expect("still valid").rows[0], vec![Cell::Integer(1)]);
    }

    #[test]
    fn closing_the_connection_invalidates_open_cursors() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_rows(&mut connection, 10);
        let prepared = connection.prepare("SELECT id FROM t ORDER BY id").expect("parses");
        let opened = connection.open_cursor(&prepared, &[]).expect("cursor opens");
        connection.close().expect("close");
        assert_eq!(connection.cursor_next(opened.handle, 1).expect_err("closed").code, "db-closed");
    }

    /// 建表并分批插入 `rows` 行 `(id, row-id)`,供大表游标用例使用。
    fn seed_large_rows(connection: &mut Connection, rows: usize) {
        connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)", &[]).expect("create");
        let mut start = 1;
        while start <= rows {
            let end = (start + 999).min(rows);
            let mut sql = String::from("INSERT INTO t (id, label) VALUES ");
            for id in start..=end {
                if id > start {
                    sql.push(',');
                }
                sql.push_str(&format!("({id}, 'row-{id}')"));
            }
            connection.execute(&sql, &[]).expect("seed chunk");
            start = end + 1;
        }
    }

    /// 50k 行简单扫描:惰性游标逐批读取,行数/顺序与物化路径一致,常驻内存
    /// 增量显著低于一次性 `all()`。
    #[test]
    fn a_large_simple_scan_streams_lazily_and_uses_less_memory_than_all() {
        let rows = 50_000usize;
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_large_rows(&mut connection, rows);
        let prepared = connection.prepare("SELECT * FROM t").expect("parses");
        let baseline = resident_bytes();

        let opened = connection.open_cursor(&prepared, &[]).expect("lazy cursor opens");
        assert!(opened.lazy, "a plain single-table scan must stream lazily");
        assert_eq!(opened.columns, vec!["id".to_string(), "label".to_string()]);
        let mut seen = 0usize;
        loop {
            let batch = connection.cursor_next(opened.handle, 256).expect("window");
            assert!(batch.rows.len() <= 256, "the lazy window is bounded");
            for row in &batch.rows {
                seen += 1;
                assert_eq!(row, &vec![Cell::Integer(seen as i64), Cell::Text(format!("row-{seen}"))]);
            }
            if batch.done {
                break;
            }
        }
        assert_eq!(seen, rows, "the lazy cursor returns every row in rowid order");
        connection.cursor_close(opened.handle).expect("close");
        let lazy_rss = resident_bytes();

        // Oracle: the same statement through the materialized path.
        let materialized = connection.execute("SELECT * FROM t", &[]).expect("materialized scan").pop().expect("one result");
        assert_eq!(materialized.rows.len(), rows);
        for (index, row) in materialized.rows.iter().enumerate() {
            assert_eq!(row, &vec![Cell::Integer(index as i64 + 1), Cell::Text(format!("row-{}", index + 1))]);
        }
        let materialized_rss = resident_bytes();

        if let (Some(baseline), Some(lazy), Some(materialized)) = (baseline, lazy_rss, materialized_rss) {
            let lazy_delta = lazy.saturating_sub(baseline);
            let materialized_delta = materialized.saturating_sub(baseline);
            println!("cursor lazy RSS delta: {lazy_delta} bytes; all() RSS delta: {materialized_delta} bytes");
            assert!(
                lazy_delta < materialized_delta,
                "the lazy cursor must use less resident memory than all(): lazy {lazy_delta}, materialized {materialized_delta}"
            );
        }
    }

    /// 打开游标后的写入不影响游标:它继续读打开时刻的一致快照。
    #[test]
    fn a_lazy_cursor_keeps_the_snapshot_taken_at_open() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_rows(&mut connection, 20);
        let prepared = connection.prepare("SELECT id, label FROM t").expect("parses");
        let opened = connection.open_cursor(&prepared, &[]).expect("cursor opens");
        assert!(opened.lazy);
        assert_eq!(
            connection.cursor_next(opened.handle, 5).expect("first window").rows,
            (1..=5).map(|id| vec![Cell::Integer(id), Cell::Text(format!("row-{id}"))]).collect::<Vec<_>>()
        );

        connection.execute("UPDATE t SET label = 'changed' WHERE id = 1", &[]).expect("update after open");
        connection.execute("INSERT INTO t (id, label) VALUES (21, 'row-21')", &[]).expect("insert after open");

        let mut seen = 5usize;
        loop {
            let batch = connection.cursor_next(opened.handle, 4).expect("snapshot window");
            for row in &batch.rows {
                seen += 1;
                assert_eq!(row, &vec![Cell::Integer(seen as i64), Cell::Text(format!("row-{seen}"))]);
            }
            if batch.done {
                break;
            }
        }
        assert_eq!(seen, 20, "the cursor still sees exactly the rows present at open");
        connection.cursor_close(opened.handle).expect("close");

        let fresh = connection.execute("SELECT id, label FROM t", &[]).expect("fresh statement").pop().expect("one result").rows;
        assert_eq!(fresh.len(), 21, "later statements see the writes");
        assert_eq!(fresh[0], vec![Cell::Integer(1), Cell::Text("changed".to_string())]);
    }

    /// `JOIN`、`GROUP BY`、非 rowid 顺序的 `ORDER BY`、`DISTINCT` 与
    /// `LIMIT` 一律走既有物化路径,结果与直接执行一致。
    #[test]
    fn complex_statements_stay_on_the_materialized_cursor_path() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        seed_rows(&mut connection, 10);
        connection.execute("CREATE TABLE u (id INTEGER PRIMARY KEY, tag TEXT NOT NULL)", &[]).expect("create u");
        connection
            .execute("INSERT INTO u (id, tag) VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (5, 'e'), (6, 'f'), (7, 'g'), (8, 'h'), (9, 'i'), (10, 'j')", &[])
            .expect("seed u");
        for sql in [
            "SELECT t.id, u.tag FROM t JOIN u ON t.id = u.id",
            "SELECT label, count(*) FROM t GROUP BY label",
            "SELECT id FROM t ORDER BY label DESC",
            "SELECT DISTINCT label FROM t",
            "SELECT id FROM t LIMIT 5",
        ] {
            let prepared = connection.prepare(sql).unwrap_or_else(|error| panic!("prepare `{sql}`: {error}"));
            let opened = connection.open_cursor(&prepared, &[]).unwrap_or_else(|error| panic!("open `{sql}`: {error}"));
            assert!(!opened.lazy, "`{sql}` must stay on the materialized path");
            let mut rows = Vec::new();
            loop {
                let batch = connection.cursor_next(opened.handle, 3).unwrap_or_else(|error| panic!("next `{sql}`: {error}"));
                rows.extend(batch.rows);
                if batch.done {
                    break;
                }
            }
            let expected = connection.execute(sql, &[]).unwrap_or_else(|error| panic!("run `{sql}`: {error}")).pop().expect("one result").rows;
            assert_eq!(rows, expected, "cursor rows of `{sql}`");
            connection.cursor_close(opened.handle).expect("close");
        }
    }

    #[test]
    fn autocommit_write_publishes_to_the_file() {
        let path = temp_path("publish");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER, b TEXT)", &[]).expect("create publishes");
        let prepared = connection.prepare("INSERT INTO t VALUES (?, ?)").expect("parses");
        connection.run(&prepared, &[Cell::Integer(7), Cell::Text("seven".to_string())]).expect("insert publishes");
        assert_eq!(rows_on_disk(&path, "SELECT a, b FROM t"), vec![vec![Cell::Integer(7), Cell::Text("seven".to_string())]]);
        fs::remove_dir_all(&path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn transaction_defers_publish_until_commit() {
        let path = temp_path("commit");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("BEGIN", &[]).expect("transaction opens");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert defers");
        assert!(rows_on_disk(&path, "SELECT a FROM t").is_empty(), "the file must not see uncommitted rows");
        assert!(connection.in_transaction());
        connection.execute("COMMIT", &[]).expect("commit publishes");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)]]);
        fs::remove_dir_all(&path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn rollback_leaves_the_file_unchanged() {
        let path = temp_path("rollback");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("first row publishes");
        connection.execute("BEGIN", &[]).expect("transaction opens");
        connection.execute("INSERT INTO t VALUES (2)", &[]).expect("second row defers");
        connection.execute("ROLLBACK", &[]).expect("rollback discards");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)]]);
        fs::remove_dir_all(&path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn close_keeps_an_open_transaction_out_of_the_file() {
        let path = temp_path("close");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("BEGIN", &[]).expect("transaction opens");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert defers");
        connection.close().expect("close without publish");
        assert!(rows_on_disk(&path, "SELECT a FROM t").is_empty(), "an open transaction must not reach the file");
        fs::remove_dir_all(&path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 发布故障不得先宣告成功:autocommit 边界与 `close` 都原样传播存储
    /// 错误,连接保持未关闭、未发布状态可查询,修复环境后 `close` 重发
    /// 成功才改关闭状态并释放写锁。
    #[test]
    fn a_failed_publish_keeps_the_connection_open_and_dirty_for_retry() {
        let path = temp_path("publish-failure");
        let mut connection = Connection::open(ConnectionOptions {
            filename: Some(path.clone()),
            journal_mode: JournalMode::Delete,
            ..Default::default()
        })
        .expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("first insert publishes");
        let published = fs::read(&path).expect("published image");

        // 挡住日志写出:目录占住 sidecar 路径,发布在主文件替换之前失败。
        let journal = database_storage::sqlite::journal::sidecar(&path);
        fs::create_dir(&journal).expect("block the sidecar path");
        let error = connection.execute("INSERT INTO t VALUES (2)", &[]).expect_err("the publish fails");
        assert_eq!(error.code, "storage");
        assert_eq!(fs::read(&path).expect("image"), published, "a failed publish must not replace the main file");
        assert!(connection.has_unpublished_changes(), "the dirty image survives the failure");

        // `close` 报告发布失败而不是先宣告成功,连接保持未关闭。
        let error = connection.close().expect_err("close propagates the publish failure");
        assert_eq!(error.code, "storage");
        assert!(connection.has_unpublished_changes(), "close must not discard the unpublished image");

        // 下一个语句边界仍然重试落盘并如实报错:连接没有被关闭,
        // 故障也没有被吞掉。
        let error = connection.execute("SELECT 1", &[]).expect_err("the retry still fails");
        assert_eq!(error.code, "storage", "a closed connection would report `db-closed` instead");

        // 修复环境后 `close` 先发布、再改关闭状态并释放写锁。
        fs::remove_dir(&journal).expect("free the sidecar path");
        connection.close().expect("the retry publishes");
        assert!(!connection.has_unpublished_changes(), "a successful close clears the dirty image");
        assert_eq!(connection.execute("SELECT 1", &[]).expect_err("closed").code, "db-closed");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t ORDER BY a"), vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]);
        let reopened = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("lock released");
        drop(reopened);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 最外层 `RELEASE`(`SAVEPOINT` 自开的事务)是发布边界:释放成功
    /// 才落盘;`BEGIN` 事务内释放中间 savepoint 不落盘;`ROLLBACK TO`
    /// 丢弃的行不随随后的 `RELEASE` 发布。
    #[test]
    fn savepoint_release_publishes_only_at_the_outermost_boundary() {
        let path = temp_path("release");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");

        // `BEGIN` 之外的 savepoint 自开事务,释放最外层即提交并发布。
        connection.execute("SAVEPOINT sp", &[]).expect("savepoint opens a transaction");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert defers");
        assert!(connection.in_transaction());
        assert!(rows_on_disk(&path, "SELECT a FROM t").is_empty(), "the savepoint scope must not reach the file");
        connection.execute("RELEASE sp", &[]).expect("outermost release commits");
        assert!(!connection.in_transaction());
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)]]);

        // `BEGIN` 事务内释放内层 savepoint 仍保持事务打开,发布继续推迟到 `COMMIT`。
        connection.execute("BEGIN", &[]).expect("transaction opens");
        connection.execute("SAVEPOINT inner", &[]).expect("inner savepoint opens");
        connection.execute("INSERT INTO t VALUES (2)", &[]).expect("insert defers");
        connection.execute("RELEASE inner", &[]).expect("inner release keeps the transaction");
        assert!(connection.in_transaction());
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)]], "an inner release must not publish");
        connection.execute("COMMIT", &[]).expect("commit publishes");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]);

        // `ROLLBACK TO` 丢弃的行不随随后释放最外层 savepoint 发布。
        connection.execute("SAVEPOINT drop", &[]).expect("savepoint opens");
        connection.execute("INSERT INTO t VALUES (3)", &[]).expect("row defers");
        connection.execute("ROLLBACK TO drop", &[]).expect("rollback to savepoint");
        connection.execute("RELEASE drop", &[]).expect("release the emptied savepoint");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]], "the rolled-back row must not publish");
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn backup_writes_the_current_image_to_another_file() {
        let directory = temp_path("backup");
        let target = directory.with_file_name("copy.sqlite");
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("table exists");
        connection.execute("INSERT INTO t VALUES (9)", &[]).expect("row exists");
        connection.backup(&target).expect("backup");
        assert_eq!(rows_on_disk(&target, "SELECT a FROM t"), vec![vec![Cell::Integer(9)]]);
        fs::remove_dir_all(directory.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn sqlite_version_reports_the_format_three_library_stamp() {
        let connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        assert_eq!(connection.sqlite_version().expect("header carries a version"), sqlite::ENGINE_LIBRARY_VERSION);
    }

    /// 对照用例:一批覆盖各类行集语句的 SQL,`prepare` 推导的列标签必须与
    /// 执行后 `ExecResult.columns` 逐字节相等。任何一条不等都说明 describe
    /// 路径与执行路径的标签推导漂移了。
    #[test]
    fn prepared_columns_match_the_executed_header() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        for setup in [
            "CREATE TABLE t1 (a INTEGER, b TEXT)",
            "CREATE TABLE t2 (a INTEGER, y TEXT)",
            "CREATE TABLE sp (\"A\" TEXT, bb INTEGER)",
            "CREATE TABLE wo (k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID",
            "INSERT INTO t1 VALUES (1, 'one'), (2, 'two')",
            "INSERT INTO t2 VALUES (1, 'x'), (3, 'z')",
            "INSERT INTO sp VALUES ('s', 7)",
            "INSERT INTO wo VALUES ('k', 1)",
            "CREATE VIEW v1 AS SELECT a, b FROM t1",
            "CREATE VIEW v2 (c, d) AS SELECT a, a FROM t1",
        ] {
            connection.execute(setup, &[]).unwrap_or_else(|error| panic!("setup `{setup}`: {error}"));
        }
        let queries = [
            "SELECT 1",
            "SELECT a, b FROM t1",
            "SELECT A, bb FROM sp",
            "SELECT a AS one, b FROM t1",
            "SELECT a+1, upper(b) FROM t1",
            "SELECT * FROM t1",
            "SELECT * FROM t1, t2",
            "SELECT * FROM t1 JOIN t2 ON t1.a = t2.a",
            "SELECT * FROM t1 JOIN t2 USING (a)",
            "SELECT * FROM t1 NATURAL JOIN t2",
            "SELECT * FROM wo",
            "SELECT count(*) FROM t1",
            "SELECT rowid, a FROM t1",
            "SELECT a, a FROM t1",
            "SELECT 1 UNION SELECT 2",
            "SELECT a FROM t1 UNION ALL SELECT a FROM t2 ORDER BY 1",
            "WITH c AS (SELECT a FROM t1) SELECT * FROM c",
            "WITH c(x) AS (SELECT a FROM t1) SELECT x FROM c",
            "WITH c AS (SELECT a AS z FROM t1) SELECT z FROM c",
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n < 3) SELECT n FROM r",
            "SELECT * FROM v1",
            "SELECT * FROM v2",
            "SELECT * FROM (SELECT a, b FROM t1) AS d",
            "SELECT * FROM (SELECT a, a FROM t1)",
            "SELECT * FROM sqlite_master",
            "SELECT b FROM t1 WHERE b IS NOT NULL ORDER BY 1",
            "SELECT DISTINCT b FROM t1",
            "SELECT b, count(*) FROM t1 GROUP BY b",
            "SELECT a FROM t1 GROUP BY a HAVING count(*) > 0",
            "SELECT a, row_number() OVER (ORDER BY a) FROM t1",
            "SELECT CASE WHEN a > 1 THEN 'big' ELSE 'small' END FROM t1",
            "SELECT b FROM t1 LIMIT 1 OFFSET 1",
            "PRAGMA table_info(t1)",
            "PRAGMA table_xinfo(t1)",
            "PRAGMA index_list(t1)",
            "PRAGMA foreign_keys",
            "PRAGMA database_list",
            "PRAGMA integrity_check",
            "EXPLAIN SELECT a FROM t1",
            "EXPLAIN QUERY PLAN SELECT a FROM t1",
            "INSERT INTO t1 VALUES (10, 'ten') RETURNING a, b",
            "INSERT INTO t1 VALUES (11, 'eleven') RETURNING *",
            "UPDATE t1 SET b = 'changed' WHERE a = 10 RETURNING a",
            "DELETE FROM t1 WHERE a = 11 RETURNING b",
        ];
        for query in queries {
            let prepared = connection.prepare(query).unwrap_or_else(|error| panic!("prepare `{query}`: {error}"));
            let results = connection.execute(query, &[]).unwrap_or_else(|error| panic!("run `{query}`: {error}"));
            let executed = results.last().expect("one result").columns.clone();
            assert_eq!(prepared.columns(), Some(executed), "columns of `{query}`");
        }
    }

    /// 非行集语句(无 `RETURNING` 的 DML、DDL、事务控制、写形 `PRAGMA`)
    /// 在 prepare 期如实返回 `None`。
    #[test]
    fn prepared_columns_report_none_without_a_rowset() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        connection.execute("CREATE TABLE t1 (a INTEGER, b TEXT)", &[]).expect("table exists");
        connection.execute("INSERT INTO t1 VALUES (1, 'one')", &[]).expect("row exists");
        for query in [
            "INSERT INTO t1 VALUES (2, 'a')",
            "UPDATE t1 SET b = 'z'",
            "DELETE FROM t1 WHERE a = 2",
            "CREATE TABLE other (i INTEGER)",
            "DROP TABLE other",
            "BEGIN",
            "COMMIT",
            "PRAGMA foreign_keys = ON",
            "PRAGMA user_version = 7",
        ] {
            let prepared = connection.prepare(query).unwrap_or_else(|error| panic!("prepare `{query}`: {error}"));
            assert!(prepared.columns().is_none(), "no rowset for `{query}`");
            connection.execute(query, &[]).unwrap_or_else(|error| panic!("run `{query}`: {error}"));
        }
    }

    /// 目录解析失败不改变拒绝口径:`prepare` 仍然成功、标签如实为 `None`,
    /// 缺表与缺列错误留在执行期,错误码与既有行为一致。
    #[test]
    fn prepare_keeps_run_time_errors_out_of_the_columns_path() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        connection.execute("CREATE TABLE t1 (a INTEGER)", &[]).expect("table exists");
        let prepared = connection.prepare("SELECT * FROM missing_table").expect("prepare still succeeds");
        assert_eq!(prepared.columns(), None, "an unknown source has no derivable header");
        let error = connection.execute("SELECT * FROM missing_table", &[]).expect_err("run reports the missing table");
        assert_eq!(error.code, "unknown-table");
        let prepared = connection.prepare("SELECT bogus FROM t1").expect("prepare still succeeds");
        assert_eq!(prepared.columns(), None, "an unknown projection column has no derivable header");
        let error = connection.execute("SELECT bogus FROM t1", &[]).expect_err("run reports the missing column");
        assert_eq!(error.code, "unknown-column");
    }

    /// 诚实性红线:`prepare` 绝不执行语句——预编译一条 `INSERT` 不会写入任何行。
    #[test]
    fn prepare_does_not_execute_the_statement() {
        let mut connection = Connection::open(ConnectionOptions::default()).expect("in-memory connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("table exists");
        let prepared = connection.prepare("INSERT INTO t VALUES (1)").expect("parses");
        assert!(prepared.is_write());
        let rows = connection.execute("SELECT a FROM t", &[]).expect("read back").last().expect("result").rows.clone();
        assert!(rows.is_empty(), "prepare must not insert");
    }

    /// 只读连接同样能在 prepare 期拿到表头;写语句的 `RETURNING` 标签照常
    /// 推导,拒绝仍发生在执行期,与既有只读语义一致。
    #[test]
    fn read_only_connections_still_describe_prepared_statements() {
        let path = temp_path("describe-readonly");
        {
            let mut writer =
                Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
            writer.execute("CREATE TABLE t (a INTEGER, b TEXT)", &[]).expect("create publishes");
            writer.execute("INSERT INTO t VALUES (1, 'one')", &[]).expect("insert publishes");
        }
        let mut reader = Connection::open(ConnectionOptions { filename: Some(path.clone()), read_only: true, ..Default::default() })
            .expect("read-only connection");
        let prepared = reader.prepare("SELECT * FROM t").expect("parses");
        assert_eq!(prepared.columns(), Some(vec!["a".to_string(), "b".to_string()]));
        let executed = reader.run(&prepared, &[]).expect("read runs").columns;
        assert_eq!(prepared.columns(), Some(executed));
        let insert = reader.prepare("INSERT INTO t VALUES (2, 'two') RETURNING a").expect("parses");
        assert_eq!(insert.columns(), Some(vec!["a".to_string()]));
        assert_eq!(reader.run(&insert, &[]).expect_err("write rejected").code, "read-only");
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn journal_mode_parses_only_the_supported_names() {
        assert_eq!(JournalMode::parse("preserve").expect("preserve"), JournalMode::Preserve);
        assert_eq!(JournalMode::parse("DELETE").expect("delete"), JournalMode::Delete);
        assert_eq!(JournalMode::parse(" truncate ").expect("truncate"), JournalMode::Truncate);
        assert_eq!(JournalMode::parse("wal").expect_err("wal is not implemented").code, "unsupported");
        assert_eq!(JournalMode::parse("off").expect_err("off is not a rollback journal").code, "unsupported");
        assert_eq!(JournalMode::Delete.as_str(), "delete");
    }

    /// 目录里不得留下发布或恢复用的临时文件。
    fn assert_no_temporary_files(path: &Path) {
        for entry in fs::read_dir(path.parent().expect("parent directory")).expect("list directory") {
            let name = entry.expect("entry").file_name().to_string_lossy().into_owned();
            assert!(!name.contains(".tmp") && !name.contains(".recover"), "leftover temporary file: {name}");
        }
    }

    #[test]
    fn delete_journal_is_removed_after_every_commit() {
        let path = temp_path("journal-delete");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), journal_mode: JournalMode::Delete, ..Default::default() })
                .expect("file connection");
        let journal = database_storage::sqlite::journal::sidecar(&path);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        assert!(!journal.exists(), "a finished commit leaves no journal in delete mode");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert publishes");
        assert!(!journal.exists(), "a finished commit leaves no journal in delete mode");
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(1)]]);
        connection.close().expect("close");
        assert_no_temporary_files(&path);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn truncate_journal_stays_as_a_zero_byte_file_after_commit() {
        let path = temp_path("journal-truncate");
        let mut connection =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), journal_mode: JournalMode::Truncate, ..Default::default() })
                .expect("file connection");
        let journal = database_storage::sqlite::journal::sidecar(&path);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (7)", &[]).expect("insert publishes");
        assert!(journal.exists(), "truncate mode keeps a zero-byte sidecar");
        assert_eq!(fs::metadata(&journal).expect("journal metadata").len(), 0);
        assert_eq!(rows_on_disk(&path, "SELECT a FROM t"), vec![vec![Cell::Integer(7)]]);
        connection.close().expect("close");
        assert_no_temporary_files(&path);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 主文件已发布、日志尚未清理时崩溃:重新打开必须回滚到旧镜像。
    #[test]
    fn a_hot_journal_rolls_back_a_published_commit_on_reopen() {
        let path = temp_path("journal-after-publish");
        let mut connection = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert publishes");
        let before = fs::read(&path).expect("previous image");
        connection.execute("INSERT INTO t VALUES (2)", &[]).expect("second insert publishes");
        drop(connection);

        // Recreate the crash window: the main file already carries the new
        // image, while a rollback journal for the previous image is still hot.
        let journal = database_storage::sqlite::journal::sidecar(&path);
        database_storage::sqlite::journal::write(&path, &before, true).expect("write hot journal");
        assert!(journal.exists(), "the journal outlives the interrupted commit");
        assert_ne!(fs::read(&path).expect("published image"), before, "the publish really replaced the main file");

        // A read-only reopen replays the journal in memory and leaves the disk alone.
        let mut reader = Connection::open(ConnectionOptions { filename: Some(path.clone()), read_only: true, ..Default::default() })
            .expect("read-only reopen");
        assert_eq!(reader.execute("SELECT a FROM t", &[]).expect("read")[0].rows, vec![vec![Cell::Integer(1)]]);
        drop(reader);
        assert!(journal.exists(), "a read-only connection must not delete the journal");

        // A writable reopen restores the old image first, then clears the journal.
        let mut reopened =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), journal_mode: JournalMode::Delete, ..Default::default() })
                .expect("writable reopen");
        assert_eq!(reopened.execute("SELECT a FROM t", &[]).expect("read")[0].rows, vec![vec![Cell::Integer(1)]]);
        assert!(!journal.exists(), "recovery clears the journal before the next commit");
        assert_eq!(fs::read(&path).expect("restored image"), before);
        reopened.close().expect("close");
        assert_no_temporary_files(&path);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 日志已落盘、主文件尚未发布时崩溃:主文件保持旧镜像,恢复不产生半镜像。
    #[test]
    fn a_journal_without_a_published_image_keeps_the_old_main_file() {
        let path = temp_path("journal-after-journal");
        let mut connection = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert publishes");
        let before = fs::read(&path).expect("previous image");
        drop(connection);

        // A crash after the journal reached the disk leaves the main file as is.
        let journal = database_storage::sqlite::journal::sidecar(&path);
        database_storage::sqlite::journal::write(&path, &before, true).expect("write hot journal");
        assert!(fs::metadata(&journal).expect("journal exists").len() > 0, "the journal holds the old page images");
        assert_eq!(fs::read(&path).expect("main file untouched"), before, "no half image reached the main file");

        let mut reopened =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), journal_mode: JournalMode::Truncate, ..Default::default() })
                .expect("writable reopen");
        assert_eq!(reopened.execute("SELECT a FROM t", &[]).expect("read")[0].rows, vec![vec![Cell::Integer(1)]]);
        assert_eq!(fs::metadata(&journal).expect("journal exists").len(), 0, "recovery honours truncate mode");
        reopened.close().expect("close");
        assert_no_temporary_files(&path);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 外部 SQLite 引擎必须能识别本绑定写出的 rollback journal 并完成回滚。
    #[test]
    fn the_reference_engine_rolls_back_a_hot_journal_written_by_this_binding() {
        let python = reference_python().expect("a Python interpreter with sqlite3 is required for the interop test");
        let path = temp_path("journal-interop");
        let mut connection = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("file connection");
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert publishes");
        let before = fs::read(&path).expect("previous image");
        connection.execute("INSERT INTO t VALUES (2)", &[]).expect("second insert publishes");
        drop(connection);
        database_storage::sqlite::journal::write(&path, &before, true).expect("write hot journal");

        let script = r#"
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",), "integrity_check"
assert db.execute("SELECT count(*) FROM t").fetchone() == (1,), "the hot journal restores the previous image"
db.close()
"#;
        let output = std::process::Command::new(python)
            .args(["-c", script, path.to_str().expect("utf-8 path")])
            .output()
            .expect("spawn upstream sqlite");
        assert!(output.status.success(), "upstream SQLite rejected the rollback journal: {}", String::from_utf8_lossy(&output.stderr));
        assert!(!database_storage::sqlite::journal::sidecar(&path).exists(), "SQLite removes the journal after rollback");

        let mut reopened =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), journal_mode: JournalMode::Delete, ..Default::default() })
                .expect("reopen after the external rollback");
        assert_eq!(reopened.execute("SELECT a FROM t", &[]).expect("read")[0].rows, vec![vec![Cell::Integer(1)]]);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 第一个装有 `sqlite3` 模块的解释器，与 facade 其他互操作用例同一探测口径。
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

    #[test]
    fn a_second_writer_is_rejected_with_busy_after_the_timeout() {
        let path = temp_path("busy");
        let mut first = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("first writer");
        first.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");

        let started = Instant::now();
        let error = Connection::open(ConnectionOptions { filename: Some(path.clone()), busy_timeout_ms: 150, ..Default::default() })
            .expect_err("the file is already locked");
        assert_eq!(error.code, "busy");
        assert!(error.message.contains("SQLITE_BUSY"), "{}", error.message);
        assert!(started.elapsed() >= Duration::from_millis(120), "the busy handler must honour the timeout");
        assert!(started.elapsed() < Duration::from_secs(5), "the busy handler must not wait past the timeout");

        // An immediate attempt with no timeout is rejected at once.
        let started = Instant::now();
        let error = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() })
            .expect_err("a zero timeout makes one attempt");
        assert_eq!(error.code, "busy");
        assert!(started.elapsed() < Duration::from_millis(200));

        // A read-only connection never waits for the writer lock.
        let mut reader =
            Connection::open(ConnectionOptions { filename: Some(path.clone()), read_only: true, ..Default::default() }).expect("reader");
        let rows = reader.execute("SELECT a FROM t", &[]).expect("read while the writer holds the lock");
        assert!(rows.last().expect("result").rows.is_empty());
        drop(reader);

        // Closing releases the lock and refuses further statements.
        first.close().expect("close publishes and releases");
        assert_eq!(first.execute("SELECT 1", &[]).expect_err("closed connection").code, "db-closed");
        let second = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("lock released");
        drop(second);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    /// 交叉进程测试的持锁端:由 `cross_process_writers_are_mutually_exclusive`
    /// 以子进程方式启动,拿到写锁后写就绪标记,等待停止标记后直接退出进程
    /// (不调用 `close`),由操作系统回收 advisory 锁。
    #[test]
    #[ignore = "spawned as a child process by the cross-process lock test"]
    fn cross_process_lock_holder() {
        let database = PathBuf::from(std::env::var("YYDB_SQLITE_LOCK_DB").expect("lock holder database path"));
        let ready = PathBuf::from(std::env::var("YYDB_SQLITE_LOCK_READY").expect("lock holder ready marker"));
        let stop = PathBuf::from(std::env::var("YYDB_SQLITE_LOCK_STOP").expect("lock holder stop marker"));
        let mut connection = Connection::open(ConnectionOptions { filename: Some(database), ..Default::default() }).expect("lock holder opens");
        connection.execute("CREATE TABLE held (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO held VALUES (7)", &[]).expect("insert publishes");
        fs::write(&ready, std::process::id().to_string()).expect("ready marker");
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && !stop.exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
        // No `close`, no destructors: the OS releases the advisory lock at exit.
        std::process::exit(0);
    }

    #[test]
    fn cross_process_writers_are_mutually_exclusive() {
        use std::process::{Command, Stdio};

        let directory = temp_path("cross-process").parent().expect("parent directory").to_path_buf();
        let database = directory.join("db.sqlite");
        let ready = directory.join("ready");
        let stop = directory.join("stop");
        let executable = std::env::current_exe().expect("test executable");
        let mut child = Command::new(executable)
            .args(["--exact", "tests::cross_process_lock_holder", "--ignored"])
            .env("YYDB_SQLITE_LOCK_DB", &database)
            .env("YYDB_SQLITE_LOCK_READY", &ready)
            .env("YYDB_SQLITE_LOCK_STOP", &stop)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn lock holder");
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "the lock holder must publish its row before the parent races it");

        // Another process holding the lock is a `busy` rejection here, and the
        // diagnostic names the holder.
        let error = Connection::open(ConnectionOptions { filename: Some(database.clone()), ..Default::default() })
            .expect_err("a second process must not share the write lock");
        assert_eq!(error.code, "busy");
        assert!(error.message.contains("SQLITE_BUSY"), "{}", error.message);
        // The timeout really waits for the lock before rejecting.
        let started = Instant::now();
        let error = Connection::open(ConnectionOptions { filename: Some(database.clone()), busy_timeout_ms: 200, ..Default::default() })
            .expect_err("the holder keeps the lock");
        assert_eq!(error.code, "busy");
        assert!(started.elapsed() >= Duration::from_millis(150));

        // Readers are never blocked by the write lock and see the published image.
        let mut reader =
            Connection::open(ConnectionOptions { filename: Some(database.clone()), read_only: true, ..Default::default() }).expect("reader");
        let rows = reader.execute("SELECT a FROM held", &[]).expect("read while another process writes");
        assert_eq!(rows.last().expect("result").rows, vec![vec![Cell::Integer(7)]]);
        drop(reader);

        fs::write(&stop, b"stop").expect("stop marker");
        let status = child.wait().expect("lock holder exits");
        assert!(status.success());

        // The lock file records the owner for diagnostics; it survives the
        // crash and is overwritten by the next writer.
        let mut lock_path = database.as_os_str().to_os_string();
        lock_path.push(".lock");
        let recorded = fs::read_to_string(PathBuf::from(lock_path)).expect("the lock file records its last owner");
        assert_eq!(recorded.trim(), child.id().to_string(), "the lock file must record the holder PID");

        // The holder never called `close`: the OS still released the lock, so a
        // crash leaves no stale lock behind and the next writer proceeds.
        let writer = Connection::open(ConnectionOptions { filename: Some(database.clone()), ..Default::default() })
            .expect("a crashed holder must not keep the database locked");
        drop(writer);
        fs::remove_dir_all(&directory).expect("cleanup");
    }

    /// 打开损坏镜像时原生层不得 panic;索引 cell 指针越界与表根页类型损坏
    /// 都要以 `corrupt` 结构化拒绝返回。
    #[test]
    fn corrupt_pages_surface_as_structured_corrupt_errors() {
        use sqlite::{SchemaObjectKind, TableLimits, read_schema, validate_database};

        let mut source = Connection::open(ConnectionOptions::default()).expect("in-memory source");
        source.execute("CREATE TABLE t(x INTEGER)", &[]).expect("create table");
        source.execute("CREATE INDEX i ON t(x)", &[]).expect("create index");
        source.execute("INSERT INTO t VALUES (1)", &[]).expect("insert");
        let image = source.snapshot().expect("image").to_vec();
        let objects = read_schema(&image, TableLimits::default()).expect("schema rows");
        let root_of = |kind: SchemaObjectKind| {
            objects.iter().find(|object| object.kind == kind).and_then(|object| object.root_page).expect("catalog root") as usize
        };
        let page_size = validate_database(&image).expect("page size");
        let header = |root: usize| if root == 1 { 100 } else { 0 };

        // The index root's single cell pointer sits past the page.
        let mut bad_index = image.clone();
        let root = root_of(SchemaObjectKind::Index);
        let base = (root - 1) * page_size + header(root);
        bad_index[base + 3..base + 5].copy_from_slice(&1u16.to_be_bytes());
        bad_index[base + 8..base + 10].copy_from_slice(&5000u16.to_be_bytes());
        let error = Connection::open(ConnectionOptions { data: Some(bad_index), ..Default::default() }).err().expect("corrupt index");
        assert_eq!(error.code, "corrupt");

        // The table root carries an invalid page type; opening tolerates it, the
        // first scan reports corruption instead of panicking.
        let mut bad_table = image;
        let root = root_of(SchemaObjectKind::Table);
        let base = (root - 1) * page_size + header(root);
        bad_table[base] = 0;
        let mut connection =
            Connection::open(ConnectionOptions { data: Some(bad_table), ..Default::default() }).expect("open defers table reads");
        let error = connection.execute("SELECT x FROM t", &[]).expect_err("corrupt table root");
        assert_eq!(error.code, "corrupt");
    }
}
