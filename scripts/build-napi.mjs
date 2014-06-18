import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, "projects", "sqlite.rs", "Cargo.toml");
const outDir = join(root, "projects", "sqlite.rs", "sqlite-napi");

const result = spawnSync(
  "cargo",
  ["build", "--release", "--manifest-path", manifest, "-p", "sqlite-napi"],
  { stdio: "inherit" }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const targetDir = join(root, "projects", "sqlite.rs", "target", "release");
const candidates =
  process.platform === "win32"
    ? ["sqlite_napi.dll"]
    : process.platform === "darwin"
      ? ["libsqlite_napi.dylib"]
      : ["libsqlite_napi.so"];

const artifact = candidates.map((name) => join(targetDir, name)).find((path) => existsSync(path));
if (!artifact) {
  console.error(`native artifact not found under ${targetDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const destination = join(outDir, "sqlite.node");
copyFileSync(artifact, destination);
console.log(destination);
