// 跨进程读写一致性测试的写入端：以正常文件连接持续提交小批量事务。
// 上游把每次提交的完整镜像发布到目标路径，本进程只负责制造持续写入。
// 第一批提交完成后打印 `ready`，父进程据此开始循环打开读取。

import { SQLite } from "../../src/index.ts";

const [filename, batchesRaw, batchSizeRaw] = process.argv.slice(2);
if (!filename) {
  process.stderr.write("mirror writer needs a database path\n");
  process.exit(2);
}
const batches = Number(batchesRaw ?? 60);
const batchSize = Number(batchSizeRaw ?? 50);

const db = new SQLite({ filename });
db.exec("create table mirror (id integer primary key, v integer not null)");

let id = 0;
for (let batch = 1; batch <= batches; batch += 1) {
  db.transaction((tx) => {
    for (let index = 0; index < batchSize; index += 1) {
      id += 1;
      tx.run("insert into mirror (id, v) values (?, ?)", [BigInt(id), BigInt(id * 7)]);
    }
  });
  process.stdout.write(batch === 1 ? "ready\n" : `batch ${batch}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

db.close();
process.stdout.write("done\n");
