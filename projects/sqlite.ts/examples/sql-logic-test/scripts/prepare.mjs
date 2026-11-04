// Shared installation-state preparation for both example runners.
//
// `scripts/run.mjs` drives the SQLLogicTest corpus and `scripts/run-fixtures.mjs`
// drives the semantic fixtures; both must exercise the published surfaces, so
// both pack the workspace packages into a temporary directory and import them
// from there. Nothing is installed into the repository.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function run(command, cwd, timeout = 600_000) {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

export function requireOk(label, result) {
  if (result.status !== 0) {
    throw new Error(`${label} failed\n${(result.stdout + result.stderr).trim().slice(-4000)}`);
  }
  return result;
}

export function repoPaths(repoRoot) {
  return {
    packageRoot: resolve(repoRoot, "projects/sqlite.ts/packages/sqlite"),
    platformRoot: resolve(repoRoot, `projects/sqlite.ts/platforms/sqlite-${process.platform}-${process.arch}`),
    pythonRoot: resolve(repoRoot, "projects/sqlite.py/packages/sqlite"),
  };
}

export function stagingDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Packs both npm packages and installs them into `<staging>/install`. */
export function packAndInstall(repoRoot, staging) {
  const paths = repoPaths(repoRoot);
  const tarballs = join(staging, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  for (const directory of [paths.packageRoot, paths.platformRoot]) {
    requireOk(`pnpm pack in ${directory}`, run(`pnpm pack --pack-destination "${tarballs}"`, directory, 300_000));
  }
  const packed = readdirSync(tarballs)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(tarballs, entry));
  if (packed.length < 2) {
    throw new Error(`expected two tarballs, found ${packed.join(", ")}`);
  }

  const install = join(staging, "install");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "slt-probe", private: true, type: "module" }, null, 2));
  requireOk(
    "npm install",
    run(`npm install --no-audit --no-fund --omit=optional ${packed.map((entry) => `"${entry}"`).join(" ")}`, install, 300_000),
  );
  requireOk(
    "plain Node import of @yydb/sqlite",
    run(
      `node -e "import('@yydb/sqlite').then((m)=>{const e=m.createEngine();e.execute('CREATE TABLE t(a INTEGER)');console.log(e.execute('SELECT count(*) FROM t').rows[0][0])})"`,
      install,
      60_000,
    ),
  );
  return { install, packed };
}

/** Builds the pyo3 extension and returns the virtual-environment interpreter. */
export function preparePython(repoRoot, staging) {
  const wheels = join(staging, "wheels");
  const venv = join(staging, "venv");
  mkdirSync(wheels, { recursive: true });
  requireOk("maturin build", run(`python -m maturin build --release --out "${wheels}"`, repoPaths(repoRoot).pythonRoot, 600_000));
  requireOk("venv", run(`python -m venv "${venv}"`, staging, 300_000));
  const pythonExe = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  requireOk(
    "pip install sqlite-format3",
    run(`"${pythonExe}" -m pip install --quiet --no-index --find-links "${wheels}" sqlite-format3`, staging, 300_000),
  );
  requireOk("python import", run(`"${pythonExe}" -c "import sqlite_format3;print(sqlite_format3.SqliteEngine.create().ping())"`, staging, 60_000));
  return pythonExe;
}
