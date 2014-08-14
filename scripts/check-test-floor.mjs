// Compatibility entry for CI and `package.json`; the harness owns the checks.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "projects/sqlite.ts/packages/sqlite-harness/bin/cli.mjs");
process.exit(spawnSync(process.execPath, [cli, "test"], { stdio: "inherit" }).status ?? 1);
