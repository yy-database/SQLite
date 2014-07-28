// Resolves the Node-API binding built by `scripts/build-napi.mjs` in this
// checkout. The binding is shared by every Node platform package because the
// repository builds it from the same Rust crate.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default require("../../../sqlite.rs/sqlite-napi/sqlite.node");
