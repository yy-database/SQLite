// 崩溃循环的子进程写入端。
//
// `commit` 阶段：提交固定数量的小批量事务后正常退出。
// `arm` 阶段：先提交固定数量的小批量事务，再开一个新事务写入下一批行，
// 打印 `armed <next id>` 后挂起，等待父进程在固定点位用 SIGKILL 强杀。
// 事务与落盘全部由 Rust facade 承担，本脚本不模拟提交或回滚。

import { SQLite } from "../../src/index.ts";

const [filename, journalMode, phase, committedRaw, startIdRaw, batchSizeRaw] = process.argv.slice(2);
if (!filename || !journalMode || !phase) {
  process.stderr.write("crash writer needs <file> <journalMode> <commit|arm> <batches> <startId> <batchSize>\n");
  process.exit(2);
}

const committedBatches = Number(committedRaw ?? 0);
const batchSize = Number(batchSizeRaw ?? 16);
let nextId = Number(startIdRaw ?? 1);

const db = new SQLite({ filename, journalMode });

function insertBatch(baseId) {
  for (let offset = 0; offset < batchSize; offset += 1) {
    const id = baseId + offset;
    db.run("insert into crashes (id, v, label) values (?, ?, ?)", [BigInt(id), BigInt(id * 7), `row-${id}`]);
  }
}

for (let batch = 0; batch < committedBatches; batch += 1) {
  db.exec("begin");
  insertBatch(nextId);
  db.exec("commit");
  nextId += batchSize;
}

if (phase === "commit") {
  process.stdout.write(`committed ${nextId - 1}\n`);
  db.close();
  process.exit(0);
}

// `arm`：再开一个事务并写入下一批行，然后停在这里等父进程强杀。
db.exec("begin");
insertBatch(nextId);
process.stdout.write(`armed ${nextId}\n`);
setInterval(() => {}, 1_000);
