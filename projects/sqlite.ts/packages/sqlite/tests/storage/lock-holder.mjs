// 跨进程写锁争用测试的持锁端：以子进程启动，打开文件写连接并写一行，
// 打印 `ready` 后保持连接打开，直到父进程在 stdin 上发送 `stop`。
// 锁由上游 facade 在打开时取得，进程存活期间一直持有；这里不做任何加锁模拟。

import { createInterface } from "node:readline";

import { SQLite } from "../../src/index.ts";

const filename = process.argv[2];
if (!filename) {
  process.stderr.write("lock holder needs a database path\n");
  process.exit(2);
}

const db = new SQLite({ filename });
db.exec("create table held (id integer primary key, label text)");
db.run("insert into held (label) values (?)", ["held"]);
process.stdout.write("ready\n");

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "stop") break;
}

db.close();
process.exit(0);
