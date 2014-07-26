import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { repository, wasmPlatform } from "../paths.mjs";

const rustWorkspace = resolve(repository, "projects/sqlite.rs");
const packageDir = resolve(wasmPlatform, "pkg");
const rawWasm = resolve(rustWorkspace, "target/wasm32-unknown-unknown/release/sqlite_wasm.wasm");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

run("cargo", ["build", "-p", "sqlite-wasm", "--target", "wasm32-unknown-unknown", "--release"], rustWorkspace);
if (!existsSync(rawWasm)) {
  throw new Error(`missing build artifact: ${rawWasm}`);
}
mkdirSync(packageDir, { recursive: true });
run("wasm-bindgen", ["--target", "nodejs", "--out-dir", packageDir, "--out-name", "sqlite_wasm", rawWasm], packageDir);
// The repository root declares `"type": "module"`, while `wasm-bindgen --target nodejs`
// emits CommonJS. Scoping the glue directory back to CommonJS keeps both loaders happy.
writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
