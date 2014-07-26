// Single harness entry. Node runs TypeScript sources through type stripping,
// so this wrapper re-executes itself with the flag and forwards the exit code.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("./src/main.ts", import.meta.url));
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", main, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
