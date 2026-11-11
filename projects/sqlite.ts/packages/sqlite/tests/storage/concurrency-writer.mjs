// 并发矩阵的写入端：持续提交小批量镜像，第一批提交后打印 `ready`。
// 全部批次完成后打印 `done`，并保持写连接（跨进程写锁）直到 stdin 收到
// `stop`，让父进程能在写者存活期间观察 `busy` 与读者行为。

import { createInterface } from "node:readline";

import { SQLite } from "../../src/index.ts";

const [filename, batchesRaw, batchSizeRaw] = process.argv.slice(2);
if (!filename) {
  process.stderr.write("concurrency writer needs a database path\n");
  process.exit(2);
}
const batches = Number(batchesRaw ?? 60);
const batchSize = Number(batchSizeRaw ?? 20);

const db = new SQLite({ filename });
db.exec("create table mirror (id integer primary key, v integer not null, label text not null)");

let id = 0;
for (let batch = 1; batch <= batches; batch += 1) {
  db.transaction((tx) => {
    for (let offset = 0; offset < batchSize; offset += 1) {
      id += 1;
      tx.run("insert into mirror (id, v, label) values (?, ?, ?)", [BigInt(id), BigInt(id * 7), `row-${id}`]);
    }
  });
  process.stdout.write(batch === 1 ? "ready\n" : `batch ${batch}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

process.stdout.write("done\n");

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "stop") break;
}

db.close();
process.exit(0);
