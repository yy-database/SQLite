// 并发矩阵的读取端：反复按路径重新打开只读连接，每次都要求读到完整的
// 已提交镜像（行数是批大小的整数倍、id 连续、v = id * 7）。
// 出现半镜像、缺行或错行即让子进程以非零码退出。
// stdin 收到 `stop` 后把统计打到 stdout 并退出。

import { createInterface } from "node:readline";

import { SQLite } from "../../src/index.ts";

const [filename, batchSizeRaw] = process.argv.slice(2);
if (!filename) {
  process.stderr.write("concurrency reader needs a database path\n");
  process.exit(2);
}
const batchSize = Number(batchSizeRaw ?? 20);

let reads = 0;
const images = new Set();
let inProgress = false;
let stopped = false;

const lines = createInterface({ input: process.stdin });
const stopping = (async () => {
  for await (const line of lines) {
    if (line.trim() === "stop") break;
  }
  stopped = true;
})();

while (!stopped) {
  const reader = new SQLite({ filename, readOnly: true });
  try {
    const rows = reader.all("select id, v, label from mirror order by id");
    if (rows.length % batchSize !== 0) {
      throw new Error(`visible image has ${rows.length} rows, not a whole number of batches`);
    }
    for (let index = 0; index < rows.length; index += 1) {
      const id = index + 1;
      if (rows[index].id !== BigInt(id) || rows[index].v !== BigInt(id * 7) || rows[index].label !== `row-${id}`) {
        throw new Error(`broken image at row ${index}`);
      }
    }
    if (rows.length > 0) inProgress = true;
    images.add(rows.length);
    reads += 1;
    if (reads === 1) process.stdout.write("started\n");
  } finally {
    reader.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 2));
}

await stopping;
process.stdout.write(`${JSON.stringify({ reads, images: images.size, maxImage: Math.max(0, ...images), inProgress })}\n`);
process.exit(0);
