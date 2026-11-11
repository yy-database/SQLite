// 崩溃测试用的 rollback journal 构造器：把 `image` 写成 SQLite 格式的
// 热日志，等价于上游 “主文件已发布、日志尚未清理” 的失败点。
//
// 这里只按上游写者相同的字节布局生成 sidecar；回滚语义仍由 Rust facade
// 在重开时执行，测试不模拟回滚。

import { writeFileSync } from "node:fs";

const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const JOURNAL_SECTOR_BYTES = 512;

function pageSizeOf(image: Buffer): number {
  const raw = image.readUInt16BE(16);
  return raw === 1 ? 65_536 : raw;
}

/** SQLite rollback-journal record checksum, matching the facade writer. */
function recordChecksum(page: Buffer, seed: number): number {
  let checksum = seed >>> 0;
  let index = page.length - 200;
  while (index > 0) {
    checksum = (checksum + page[index]!) >>> 0;
    index -= 200;
  }
  return checksum;
}

/** 把 `image` 写成 `<path>-journal` 的热日志并返回日志路径。 */
export function writeHotJournal(path: string, image: Buffer): string {
  const pageSize = pageSizeOf(image);
  const pages = image.length / pageSize;
  if (!Number.isInteger(pages) || pages <= 0) throw new Error("the image must be a whole number of pages");
  const seed = 0x9e37_79b1;
  const recordBytes = 4 + pageSize + 4;
  const journal = Buffer.alloc(JOURNAL_SECTOR_BYTES + pages * recordBytes);
  for (let index = 0; index < pages; index += 1) {
    const offset = JOURNAL_SECTOR_BYTES + index * recordBytes;
    const page = image.subarray(index * pageSize, (index + 1) * pageSize);
    journal.writeUInt32BE(index + 1, offset);
    page.copy(journal, offset + 4);
    journal.writeUInt32BE(recordChecksum(page, seed), offset + 4 + pageSize);
  }
  JOURNAL_MAGIC.copy(journal, 0);
  journal.writeUInt32BE(pages, 8);
  journal.writeUInt32BE(seed, 12);
  journal.writeUInt32BE(pages, 16);
  journal.writeUInt32BE(JOURNAL_SECTOR_BYTES, 20);
  journal.writeUInt32BE(pageSize, 24);
  const journalPath = `${path}-journal`;
  writeFileSync(journalPath, journal);
  return journalPath;
}
