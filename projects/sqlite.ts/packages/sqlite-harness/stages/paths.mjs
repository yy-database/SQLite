// Shared filesystem anchors for the platform stages.
//
// The stages live under `projects/sqlite.ts/packages/sqlite-harness/stages`,
// so the repository root is five levels up and the wasm artifacts belong to
// the `sqlite-unknown-wasm32` platform package.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const stagesDir = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(stagesDir, "../../../../..");
export const tsProject = resolve(repository, "projects/sqlite.ts");
export const wasmPlatform = resolve(tsProject, "platforms/sqlite-unknown-wasm32");
