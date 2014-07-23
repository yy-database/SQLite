#!/usr/bin/env node
// Entry point required by CI and by humans: `node harness/cli.mjs <command>`.
// The implementation lives in the `sqlite-harness` workspace package; this
// file only forwards the command and exit code.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../projects/sqlite.ts/packages/sqlite-harness/src/main.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", main, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
