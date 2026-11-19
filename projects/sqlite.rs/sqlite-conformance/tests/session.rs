//! SQLite 会话与持久发布故障矩阵(22 号盘点 A4 验收)。
//!
//! 消费正式 owner:门面 `sqlite::Connection` 背后的
//! `database.execution::sqlite::session` 会话状态机与
//! `database.storage::sqlite` 的 journal/lock,不重造判定逻辑。
//! 故障注入只走公开面:用目录占住回滚日志 sidecar 路径,使 journaled
//! 发布在主文件替换之前失败。覆盖 autocommit、`COMMIT`、`ROLLBACK`、
//! 嵌套 `RELEASE`、`close` 各边界:提交故障不先宣告成功,失败后资源
//! 状态可解释(未发布、`dirty` 保留/丢弃、写锁持有与否均可查询)。

mod tests {
    use sqlite::{Cell, Connection, ConnectionOptions, JournalMode};
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    /// 每次调用生成唯一临时目录,返回其中的数据库路径。
    fn temp_path(label: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock is ahead of unix epoch").as_nanos();
        let directory = std::env::temp_dir().join(format!("sqlite-session-{label}-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&directory).expect("temp directory");
        directory.join("db.sqlite")
    }

    /// 回滚日志 sidecar 路径,与存储层 `<db>-journal` 合同一致。
    fn journal_sidecar(database: &Path) -> PathBuf {
        let mut path = database.as_os_str().to_os_string();
        path.push("-journal");
        PathBuf::from(path)
    }

    /// 用目录占住 sidecar 路径,使 journaled 发布在替换主文件之前失败。
    /// `truncate` 模式的稳态会留下 0 字节 sidecar,先清掉再占位。
    fn block_journal(database: &Path) {
        let sidecar = journal_sidecar(database);
        if sidecar.exists() {
            fs::remove_file(&sidecar).expect("remove the steady-state sidecar");
        }
        fs::create_dir(sidecar).expect("block the sidecar path");
    }

    fn unblock_journal(database: &Path) {
        fs::remove_dir(journal_sidecar(database)).expect("free the sidecar path");
    }

    /// 以只读连接重新打开文件,返回 `SELECT a FROM t ORDER BY a` 的行。
    fn rows_on_disk(path: &Path) -> Vec<Vec<Cell>> {
        let mut reader =
            Connection::open(ConnectionOptions { filename: Some(path.to_path_buf()), read_only: true, ..Default::default() }).expect("reopen file");
        let results = reader.execute("SELECT a FROM t ORDER BY a", &[]).expect("read committed image");
        results.last().expect("at least one result").rows.clone()
    }

    fn file_connection(path: &Path, journal_mode: JournalMode) -> Connection {
        Connection::open(ConnectionOptions { filename: Some(path.to_path_buf()), journal_mode, ..Default::default() }).expect("file connection")
    }

    #[test]
    fn autocommit_publish_failure_keeps_dirty_and_retries_at_the_next_boundary() {
        let path = temp_path("autocommit-failure");
        let mut connection = file_connection(&path, JournalMode::Delete);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("first insert publishes");
        let published = fs::read(&path).expect("published image");

        block_journal(&path);
        let error = connection.execute("INSERT INTO t VALUES (2)", &[]).expect_err("the publish fails");
        assert_eq!(error.code, "storage");
        assert_eq!(fs::read(&path).expect("image"), published, "a failed publish must not replace the main file");
        assert!(connection.has_unpublished_changes(), "the dirty image survives the failure");

        // 修复环境后,下一个语句边界自动重试落盘,故障不需要手工补偿。
        unblock_journal(&path);
        connection.execute("INSERT INTO t VALUES (3)", &[]).expect("the retry publishes");
        assert!(!connection.has_unpublished_changes(), "a successful publish clears the dirty image");
        assert_eq!(rows_on_disk(&path), vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)], vec![Cell::Integer(3)]]);
        connection.close().expect("close");
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn commit_publish_failure_propagates_and_close_can_recover() {
        let path = temp_path("commit-failure");
        let mut connection = file_connection(&path, JournalMode::Delete);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        let published = fs::read(&path).expect("published image");

        connection.execute("BEGIN", &[]).expect("transaction opens");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert defers");
        block_journal(&path);
        let error = connection.execute("COMMIT", &[]).expect_err("the commit-boundary publish fails");
        assert_eq!(error.code, "storage", "a commit whose publication failed must not report success");
        assert!(!connection.in_transaction(), "the transaction itself ended in memory");
        assert!(connection.has_unpublished_changes(), "the committed image is retained as unpublished");
        assert_eq!(fs::read(&path).expect("image"), published, "the main file keeps the previous image");

        unblock_journal(&path);
        connection.close().expect("the close retry publishes");
        assert_eq!(rows_on_disk(&path), vec![vec![Cell::Integer(1)]]);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn rollback_never_publishes_even_with_a_blocked_journal() {
        let path = temp_path("rollback-blocked");
        let mut connection = file_connection(&path, JournalMode::Delete);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("first row publishes");
        let published = fs::read(&path).expect("published image");

        block_journal(&path);
        connection.execute("BEGIN", &[]).expect("transaction opens");
        connection.execute("INSERT INTO t VALUES (2)", &[]).expect("second row defers");
        connection.execute("ROLLBACK", &[]).expect("rollback discards without touching the disk");
        assert!(!connection.has_unpublished_changes(), "the rollback clears the dirty image");
        assert_eq!(fs::read(&path).expect("image"), published, "a rollback must not attempt a publication");

        unblock_journal(&path);
        connection.close().expect("close without publish");
        assert_eq!(rows_on_disk(&path), vec![vec![Cell::Integer(1)]]);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn outermost_release_publish_failure_keeps_state_explainable() {
        let path = temp_path("release-failure");
        let mut connection = file_connection(&path, JournalMode::Delete);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        let published = fs::read(&path).expect("published image");

        connection.execute("SAVEPOINT sp", &[]).expect("savepoint opens a transaction");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("insert defers");
        block_journal(&path);
        let error = connection.execute("RELEASE sp", &[]).expect_err("the release-boundary publish fails");
        assert_eq!(error.code, "storage", "an outermost release whose publication failed must not report success");
        assert!(!connection.in_transaction(), "the savepoint transaction itself ended in memory");
        assert!(connection.has_unpublished_changes(), "the released image is retained as unpublished");
        assert_eq!(fs::read(&path).expect("image"), published, "the main file keeps the previous image");

        unblock_journal(&path);
        connection.execute("SELECT 1", &[]).expect("the next boundary retries the publication");
        assert!(!connection.has_unpublished_changes());
        assert_eq!(rows_on_disk(&path), vec![vec![Cell::Integer(1)]]);
        connection.close().expect("close");
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn close_failure_keeps_the_writer_lock_and_the_connection_open() {
        let path = temp_path("close-lock");
        let mut connection = file_connection(&path, JournalMode::Delete);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("first insert publishes");

        block_journal(&path);
        let error = connection.execute("INSERT INTO t VALUES (2)", &[]).expect_err("the publish fails");
        assert_eq!(error.code, "storage");
        let error = connection.close().expect_err("close propagates the publish failure");
        assert_eq!(error.code, "storage");
        assert!(connection.has_unpublished_changes(), "close must not discard the unpublished image");

        // 发布失败时写锁保持持有:另一个写连接只能以 `busy` 被拒绝。
        let error = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect_err("the lock is still held");
        assert_eq!(error.code, "busy");

        unblock_journal(&path);
        connection.close().expect("the close retry publishes and releases");
        let reopened = Connection::open(ConnectionOptions { filename: Some(path.clone()), ..Default::default() }).expect("lock released");
        drop(reopened);
        assert_eq!(rows_on_disk(&path), vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]);
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }

    #[test]
    fn truncate_mode_publish_failure_follows_the_same_boundary() {
        let path = temp_path("truncate-failure");
        let mut connection = file_connection(&path, JournalMode::Truncate);
        connection.execute("CREATE TABLE t (a INTEGER)", &[]).expect("create publishes");
        connection.execute("INSERT INTO t VALUES (1)", &[]).expect("first insert publishes");
        let published = fs::read(&path).expect("published image");

        block_journal(&path);
        let error = connection.execute("INSERT INTO t VALUES (2)", &[]).expect_err("the publish fails");
        assert_eq!(error.code, "storage");
        assert_eq!(fs::read(&path).expect("image"), published, "a failed publish must not replace the main file");
        assert!(connection.has_unpublished_changes());

        unblock_journal(&path);
        connection.close().expect("the close retry publishes");
        assert_eq!(rows_on_disk(&path), vec![vec![Cell::Integer(1)], vec![Cell::Integer(2)]]);
        let sidecar = journal_sidecar(&path);
        assert_eq!(fs::metadata(&sidecar).expect("journal metadata").len(), 0, "truncate mode keeps a zero-byte sidecar");
        fs::remove_dir_all(path.parent().expect("parent directory")).expect("cleanup");
    }
}
