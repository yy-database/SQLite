# Harness

Private package: `@yydb/sqlite-harness`  
CLI: `node projects/sqlite.ts/packages/sqlite-harness/bin/cli.mjs <command>`  
Root aliases: `pnpm test`, `pnpm test:gate`, `pnpm corpus`, and `harness/cli.mjs`.

`scripts/check-test-floor.mjs` is a thin spawn wrapper so CI and `package.json` keep a stable path while the harness owns the checks.

## Commands

| Command | Purpose |
|---------|---------|
| `test` | Build native module, run TypeScript + Python suites, then platform stages |
| `bench` | Same workload vs `better-sqlite3` |
| `conformance` | Parse external fixtures and compare with an external engine |
| `fixtures` | Regenerate fixture assets from external engines; print sha256 |
| `oracle` | Report external engines; verify two agree on probes |
| `corpus` | Seeded differential corpus against external oracles (`--seed`, `--count`, `--check` / `--update-baseline`) |
| `fuzz` | Grammar-driven fuzz + shrink against external oracles |

Pass `--json` where supported for machine-readable output. See `src/cli/main.ts` usage text for flags.

## Layer model

Every acceptance case lands in exactly one layer:

| Layer | What it proves |
|-------|----------------|
| `external` | Peer engines agree on shared corpus / probes |
| `storage` | This repo’s format-3 reader/writer/snapshot/API/platform behavior |
| `sql` | This repo’s SQL engine envelopes and rejections |

Floors live in `packages/sqlite-harness/src/tests/index.ts` (`FLOORS`) and are overridable via:

- `TS_EXTERNAL_FLOOR` / `TS_STORAGE_FLOOR` / `TS_SQL_FLOOR`
- `PY_EXTERNAL_FLOOR` / `PY_STORAGE_FLOOR` / `PY_SQL_FLOOR`

The gate also reads suite sources and fails if they stop calling a real external engine (`better-sqlite3`, Python `sqlite3`, `PRAGMA integrity_check`, …). There is no JSON allowlist for skips.

Platform stages report assertion counts separately from data-volume `rows`, with their own SQL assertion floors where applicable.

## Suite locations

| Host | Tests root |
|------|------------|
| TypeScript | `projects/sqlite.ts/packages/sqlite/tests/` |
| Python | `projects/sqlite.py/packages/sqlite/tests/` plus wheel-stage acceptance |

TypeScript suites are grouped by harness layer directories (`external/`, `storage/`, `sql/`). Shared JSON corpora for peer-engine judgment live under `external/corpus/`.

When regrouping tests, keep layer classification and external-oracle calls intact so floors stay meaningful. Prefer harness exports (`conformance`, `oracle`, fixtures helpers) over duplicating corpus/oracle helpers inside the product package. Do not treat case-count tables in old notes as truth — floors in `FLOORS` and the live suite tree are authoritative.

## Stages

Registered in `packages/sqlite-harness/stages/` — see [platforms.md](./platforms.md) and `stages/README.md` for the node / python / wasm smoke contracts and `verify_sqlite.py` external oracle.
