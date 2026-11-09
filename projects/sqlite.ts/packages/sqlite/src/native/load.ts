// 唯一的 native loader：平台识别与 addon 加载只发生在这里。
// 示例、benchmark 与 fuzz 不再各写一份加载逻辑。

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { NativeAddon } from "./binding.ts";

const require = createRequire(import.meta.url);

export type PlatformKey = "win32-x64" | "linux-x64" | "darwin-x64" | "darwin-arm64";

/** Map Node platform and arch to the optionalDependency package suffix. */
export function platformKey(platform = process.platform, arch = process.arch): PlatformKey | null {
  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  return null;
}

/** Absolute path of the platform package `main` (the `.node` binary). */
export function nativeBindingPath(): string {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    const bindingPath = resolve(fromEnv);
    if (!existsSync(bindingPath)) {
      throw new Error(`SQLITE_NATIVE points to missing binding: ${fromEnv}`);
    }
    return bindingPath;
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  // `package.json#main` owns the `.node` filename — callers never concatenate it.
  return require.resolve(`@yydb/sqlite-${key}`);
}

/** Load the platform binding through the package entry installed for this host. */
export function loadNative(): NativeAddon {
  const fromEnv = process.env.SQLITE_NATIVE?.trim();
  if (fromEnv) {
    return loadModule(nativeBindingPath());
  }
  const key = platformKey();
  if (!key) {
    throw new Error(`SQLite native binding not available for ${process.platform}-${process.arch}`);
  }
  const pkg = `@yydb/sqlite-${key}`;
  try {
    return loadModule(pkg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite native binding not found. Run pnpm build:napi from the repo root, reinstall @yydb/sqlite with optional dependencies, set SQLITE_NATIVE, or stage ${pkg}. ${message}`,
    );
  }
}

function loadModule(specifier: string): NativeAddon {
  const loaded = require(specifier) as NativeAddon & { default?: NativeAddon };
  return loaded.default ?? loaded;
}
