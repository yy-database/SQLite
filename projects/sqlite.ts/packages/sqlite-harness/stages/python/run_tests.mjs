import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { repository, stagesDir } from "../paths.mjs";

const project = resolve(repository, "projects/sqlite.py/packages/sqlite");
const wheels = resolve(stagesDir, "python/wheels");
const venv = resolve(stagesDir, "python/.venv");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: stagesDir, stdio: "inherit", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

mkdirSync(wheels, { recursive: true });
run("python", ["-m", "maturin", "build", "--release", "--out", wheels], { cwd: project });

if (!existsSync(venv)) {
  run("python", ["-m", "venv", venv]);
}
const venvPython = resolve(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

run(venvPython, ["-m", "pip", "install", "--quiet", "--force-reinstall", "--no-index", "--find-links", wheels, "sqlite-format3"]);
run(venvPython, ["-m", "unittest", "test_features", "-v"], { cwd: resolve(stagesDir, "python") });
