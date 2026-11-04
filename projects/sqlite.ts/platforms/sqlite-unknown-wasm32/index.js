// Loads the wasm-bindgen output produced by the harness `test` stage. The
// generated `pkg/` directory is a build artifact, so importing this package
// requires running the wasm build first.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default require("./pkg/sqlite_wasm.js");
