# sqlite-napi

Node-API surface for the SQLite format-3 product.

Owns snapshot inspect / decode / writer bindings. Does **not** open YYDB
databases and does not depend on the `yydb` facade. Core codecs live in
`database.rs` (`sqlite-formats` / `sqlite-storage` / `sqlite`).
