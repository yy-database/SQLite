import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { repository, wasmPlatform } from "../sqlite-harness/stages/paths.mjs";

const rustWorkspace = resolve(repository, "projects/sqlite.rs");
// The glue belongs to the platform package, not to the crate or to a second
// `sqlite-wasm` package.
const packageDir = resolve(wasmPlatform, "lib");
const targetRoot = process.env.CARGO_TARGET_DIR
  ? isAbsolute(process.env.CARGO_TARGET_DIR)
    ? process.env.CARGO_TARGET_DIR
    : resolve(rustWorkspace, process.env.CARGO_TARGET_DIR)
  : resolve(rustWorkspace, "target");
const rawWasm = resolve(targetRoot, "wasm32-unknown-unknown/release/sqlite_wasm.wasm");

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
