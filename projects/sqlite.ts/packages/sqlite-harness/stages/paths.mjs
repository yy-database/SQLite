// Shared filesystem anchors for the platform stages.
//
// The stages live under `projects/sqlite.ts/packages/sqlite-harness/stages`,
// so the repository root is five levels up and the wasm artifacts belong to
// the `sqlite-unknown-wasm32` platform package.

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const stagesDir = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(stagesDir, "../../../../..");
export const tsProject = resolve(repository, "projects/sqlite.ts");
export const wasmPlatform = resolve(tsProject, "platforms/sqlite-unknown-wasm32");

export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

/** Resolve the staged `.node` inside the platform package `lib/`. */
export function nativeBindingPath() {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) return resolve(fromEnv);
  const key = platformKey();
  if (!key) throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  const libDir = join(dirname(require.resolve(`@yydb/sqlite-${key}`)), "lib");
  const fileName = existsSync(libDir)
    ? readdirSync(libDir).find((entry) => entry.endsWith(".node"))
    : undefined;
  if (!fileName) throw new Error(`Missing .node binary in ${libDir}. Run pnpm build:napi from the repo root.`);
  return join(libDir, fileName);
}
