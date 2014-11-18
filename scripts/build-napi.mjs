import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NATIVE_ARTIFACTS } from "./native-artifacts.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, "projects", "sqlite.rs", "Cargo.toml");
const artifact = NATIVE_ARTIFACTS.find(
  (entry) => entry.hostPlatform === process.platform && entry.hostArch === process.arch,
);

if (!artifact) {
  throw new Error(`No SQLite native package mapping for ${process.platform}-${process.arch}`);
}

const build = spawnSync(
  "cargo",
  ["build", "--manifest-path", manifest, "-p", "sqlite-napi", "--release"],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const targetRoot = process.env.CARGO_TARGET_DIR
  ? (isAbsolute(process.env.CARGO_TARGET_DIR) ? process.env.CARGO_TARGET_DIR : join(root, process.env.CARGO_TARGET_DIR))
  : join(root, "projects", "sqlite.rs", "target");
const src = join(targetRoot, "release", artifact.cargoRelease);
if (!existsSync(src)) {
  throw new Error(`missing cargo artifact: ${src}`);
}

const libDir = join(root, "projects", "sqlite.ts", "platforms", artifact.pkg, "lib");
mkdirSync(libDir, { recursive: true });

for (const existing of readdirSync(libDir).filter((name) => name.endsWith(".node"))) {
  try {
    unlinkSync(join(libDir, existing));
  } catch (error) {
    // A concurrent suite can still hold the previous binding.
    if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
  }
}

const dest = join(libDir, artifact.fileName);
try {
  copyFileSync(src, dest);
} catch (error) {
  // Another process can hold the binding while a concurrent suite runs. If the
  // destination already matches the fresh artifact there is nothing to do.
  const fresh =
    existsSync(dest) &&
    statSync(src).size === statSync(dest).size &&
    statSync(dest).mtimeMs >= statSync(src).mtimeMs;
  if (!fresh) throw error;
}
console.log(dest);
