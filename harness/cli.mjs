// Repository-level shortcut for the single harness entry that lives with the
// `@sqlite/sqlite-harness` package. It forwards every argument and the exit
// code, so `node harness/cli.mjs <cmd>` and the package binary behave the same.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../projects/sqlite.ts/packages/sqlite-harness/bin/cli.mjs", import.meta.url));
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
