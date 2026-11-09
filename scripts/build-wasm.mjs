import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {isAbsolute, resolve} from "node:path";

import {repository, wasmPlatform} from "../projects/sqlite.ts/packages/sqlite-harness/stages/paths.mjs";

const rustWorkspace = resolve(repository, "projects/sqlite.rs");
const rustManifest = resolve(rustWorkspace, "Cargo.toml");
// The glue belongs to the platform package, not to the crate or to a second
// `sqlite-wasm` package.
const packageDir = resolve(wasmPlatform, "lib");
const targetRoot = process.env.CARGO_TARGET_DIR
    ? isAbsolute(process.env.CARGO_TARGET_DIR)
        ? process.env.CARGO_TARGET_DIR
        : resolve(rustWorkspace, process.env.CARGO_TARGET_DIR)
    : resolve(rustWorkspace, "target");
const rawWasm = resolve(targetRoot, "wasm32-unknown-unknown/release/sqlite_wasm.wasm");

// `wasm-bindgen` refuses to run when its schema version differs from the crate
// it linked, so the CLI version is read from the workspace dependency instead
// of being repeated here or in CI.
function requiredWasmBindgen() {
    const text = readFileSync(rustManifest, "utf8");
    const match = text.match(/^[ \t]*wasm-bindgen[ \t]*=[ \t]*"=[ \t]*([0-9]+\.[0-9]+\.[0-9]+)"/m);
    if (!match) {
        throw new Error(`cannot read the pinned wasm-bindgen version from ${rustManifest}`);
    }
    return match[1];
}

function installedWasmBindgen() {
    const result = spawnSync("wasm-bindgen", ["--version"], {encoding: "utf8"});
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const match = output.match(/^wasm-bindgen\s+([0-9]+\.[0-9]+\.[0-9]+)/);
    return match ? match[1] : null;
}

const required = requiredWasmBindgen();
if (process.argv.includes("--print-wasm-bindgen-version")) {
    console.log(required);
    process.exit(0);
}
const found = installedWasmBindgen();
if (found !== required) {
    console.error(
        `wasm-bindgen version mismatch: expected ${required} (pinned in projects/sqlite.rs/Cargo.toml), found ${found ?? "not installed on PATH"}.`,
    );
    console.error(`Install the pinned version with: cargo install wasm-bindgen-cli --version ${required}`);
    process.exit(1);
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, {cwd, stdio: "inherit"});
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
mkdirSync(packageDir, {recursive: true});
run("wasm-bindgen", ["--target", "nodejs", "--out-dir", packageDir, "--out-name", "sqlite_wasm", rawWasm], packageDir);
// The repository root declares `"type": "module"`, while `wasm-bindgen --target nodejs`
// emits CommonJS. Scoping the glue directory back to CommonJS keeps both loaders happy.
writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({type: "commonjs"}, null, 2) + "\n");
