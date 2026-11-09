// Builds `sqlite-napi` and drops the addon into the matching platform package.
//
// Default: the production addon (package `main`), no harness symbols.
// `--dev`: a separate `sqlite.<platform>.dev.node` built with `--features dev-tools`,
// stamped with the pinned database.rs rev so the harness can verify identity before
// trusting its judgment results. The dev addon is never the package `main`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NATIVE_ARTIFACTS } from './native-artifacts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = join(root, 'projects', 'sqlite.rs', 'Cargo.toml');
const dev = process.argv.includes('--dev');

// The pinned database.rs rev, read from the workspace manifest. Used as the dev
// build identity so a stale `.dev.node` cannot masquerade as the installed product.
function pinnedDatabaseRev() {
    const text = readFileSync(manifest, 'utf8');
    const match = text.match(/^database\s*=\s*\{[^}]*rev\s*=\s*"([0-9a-f]{40})"/m);
    if (!match) {
        throw new Error('cannot read the pinned database.rs rev from projects/sqlite.rs/Cargo.toml');
    }
    return match[1];
}

const artifact = NATIVE_ARTIFACTS.find(
    (entry) => entry.hostPlatform === process.platform && entry.hostArch === process.arch,
);

if (!artifact) {
    throw new Error(`No SQLite native package mapping for ${process.platform}-${process.arch}`);
}

const cargoArgs = ['build', '--manifest-path', manifest, '-p', 'sqlite-napi', '--release'];
const env = { ...process.env };
if (dev) {
    cargoArgs.push('--features', 'dev-tools');
    env.SQLITE_HARNESS_DATABASE_REV = pinnedDatabaseRev();
}

const build = spawnSync('cargo', cargoArgs, { cwd: root, stdio: 'inherit', env });
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}

const targetRoot = process.env.CARGO_TARGET_DIR
    ? isAbsolute(process.env.CARGO_TARGET_DIR)
        ? process.env.CARGO_TARGET_DIR
        : join(root, process.env.CARGO_TARGET_DIR)
    : join(root, 'projects', 'sqlite.rs', 'target');
const src = join(targetRoot, 'release', artifact.cargoRelease);
if (!existsSync(src)) {
    throw new Error(`missing cargo artifact: ${src}`);
}

const packageDir = join(root, 'projects', 'sqlite.ts', 'platforms', artifact.pkg);
const fileName = dev ? artifact.fileName.replace(/\.node$/, '.dev.node') : artifact.fileName;

if (!dev) {
    for (const existing of readdirSync(packageDir).filter((name) => name.endsWith('.node') && !name.endsWith('.dev.node'))) {
        try {
            unlinkSync(join(packageDir, existing));
        } catch (error) {
            // A concurrent suite can still hold the previous binding.
            if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
        }
    }
}

const dest = join(packageDir, fileName);
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
