// Compatibility entry for CI and `package.json`; the harness owns the checks.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.exit(
  spawnSync(
    process.execPath,
    [join(root, "projects/sqlite.ts/packages/sqlite-harness/stages/wasm/build.mjs")],
    { stdio: "inherit" },
  ).status ?? 1,
);
