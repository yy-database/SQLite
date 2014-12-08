import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { repository, stagesDir } from "../paths.mjs";

const project = resolve(repository, "projects/sqlite.py/packages/sqlite");
const wheels = resolve(stagesDir, "python/wheels");
const venv = resolve(stagesDir, "python/.venv");
// Windows exposes `python` while the POSIX runners only guarantee `python3`.
const interpreter = process.platform === "win32" ? "python" : "python3";

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
run(interpreter, ["-m", "maturin", "build", "--release", "--out", wheels], { cwd: project });

if (!existsSync(venv)) {
  run(interpreter, ["-m", "venv", venv]);
}
const venvPython = resolve(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

run(venvPython, ["-m", "pip", "install", "--quiet", "--force-reinstall", "--no-index", "--find-links", wheels, "sqlite-format3"]);
run(venvPython, ["test_features.py"], { cwd: resolve(stagesDir, "python") });

// `--acceptance` also runs the package suite in the same venv, so the tests
// import the wheel that was just built instead of the host interpreter.
if (process.argv.includes("--acceptance")) {
  const tests = resolve(project, "tests");
  run(venvPython, ["-m", "unittest", "discover", "-v", "-s", tests, "-t", tests], { cwd: project });
}
