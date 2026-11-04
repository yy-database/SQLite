import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const manifest = resolve(repository, "projects/sqlite.rs/sqlite-pyo3/Cargo.toml");
const wheels = resolve(here, "wheels");
const venv = resolve(here, ".venv");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: here, stdio: "inherit", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

mkdirSync(wheels, { recursive: true });
run("python", ["-m", "maturin", "build", "--release", "--manifest-path", manifest, "--out", wheels]);

if (!existsSync(venv)) {
  run("python", ["-m", "venv", venv]);
}
const venvPython = resolve(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

run(venvPython, ["-m", "pip", "install", "--quiet", "--force-reinstall", "--no-index", "--find-links", wheels, "sqlite-format3"]);
run(venvPython, ["-m", "unittest", "discover", "-s", resolve(here, "tests"), "-v"]);
