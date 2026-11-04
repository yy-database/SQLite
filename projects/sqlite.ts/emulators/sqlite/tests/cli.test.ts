// Acceptance cases for the `sqlite` command persona. Every case spawns the
// real bin against a real main file written by this repository's writer, so the
// command surface is judged on its printed bytes, not on an in-process call.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWriter, openDatabase, writeSlots } from "@yydb/sqlite";

const BIN = fileURLToPath(new URL("../bin/sqlite3.mjs", import.meta.url));

const COLUMNS = JSON.stringify([
    { name: "id", declaredType: "INTEGER", notNull: false, defaultValue: null, primaryKey: true, unique: false },
    { name: "label", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    { name: "score", declaredType: "REAL", notNull: false, defaultValue: null, primaryKey: false, unique: false },
    { name: "payload", declaredType: "BLOB", notNull: false, defaultValue: null, primaryKey: false, unique: false },
]);

interface Workspace {
    readonly path: string;
    readonly dispose: () => void;
}

function workspace(label: string): Workspace {
    const root = mkdtempSync(join(tmpdir(), `sqlite-emulator-${label}-`));
    return {
        path: join(root, "main.sqlite3"),
        dispose: () => {
            try {
                rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            } catch {
                // A Windows handle can outlive the process, so cleanup is advisory.
            }
        },
    };
}

function seed(space: Workspace): void {
    const writer = createWriter(4096);
    writer.createTable("samples", COLUMNS);
    writer.createTable("zebra", COLUMNS);
    writer.createIndex("samples_label", "samples", ["label"], false);
    writer.insert("samples", writeSlots([{ $omit: true }, "alpha", 1.5, null]));
    writer.insert("samples", writeSlots([{ $omit: true }, "beta", 2, Buffer.from([1, 2, 3])]));
    writer.save(space.path);
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("lists user tables and hides internal objects", () => {
    const space = workspace("tables");
    try {
        seed(space);
        const result = run([space.path, ".tables"]);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, "samples\nzebra\n");
    } finally {
        space.dispose();
    }
});

test("prints every schema statement with a terminator", () => {
    const space = workspace("schema");
    try {
        seed(space);
        const result = run([space.path, ".schema"]);
        assert.equal(result.status, 0);
        const lines = result.stdout.trimEnd().split("\n");
        assert.ok(lines.length >= 3);
        assert.ok(lines.every((line) => line.endsWith(";")));
        assert.match(result.stdout, /CREATE TABLE "samples"/);
        assert.match(result.stdout, /CREATE INDEX "samples_label"/);
    } finally {
        space.dispose();
    }
});

test("reports the health probe", () => {
    const space = workspace("ping");
    try {
        seed(space);
        const result = run([space.path, ".ping"]);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, `ok ${openDatabase(space.path).ping()}\n`);
    } finally {
        space.dispose();
    }
});

test("reports the text encoding label", () => {
    const space = workspace("encoding");
    try {
        seed(space);
        const result = run([space.path, ".encoding"]);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, "utf8\n");
    } finally {
        space.dispose();
    }
});

test("reports the library version stamped in the file header", () => {
    const space = workspace("version");
    try {
        seed(space);
        const result = run([space.path, ".version"]);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
    } finally {
        space.dispose();
    }
});

test("dumps rows with the rowid and decoded storage classes", () => {
    const space = workspace("dump");
    try {
        seed(space);
        const result = run([space.path, ".dump samples"]);
        assert.equal(result.status, 0);
        const lines = result.stdout.trimEnd().split("\n");
        assert.equal(lines.length, 2);
        assert.match(lines[0], /^1\s+\| NULL\s+\| alpha\s+\| 1\.5\s+\| NULL\s*$/);
        assert.match(lines[1], /^2\s+\| NULL\s+\| beta\s+\| 2\.0\s+\| X'010203'/);
    } finally {
        space.dispose();
    }
});

test("refuses SQL statements", () => {
    const space = workspace("sql");
    try {
        seed(space);
        const result = run([space.path, "select count(*) from samples"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /SQL execution is not available/);
    } finally {
        space.dispose();
    }
});

test("refuses unknown dot commands", () => {
    const space = workspace("unknown");
    try {
        seed(space);
        const result = run([space.path, ".indexes"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unsupported dot command '\.indexes'/);
    } finally {
        space.dispose();
    }
});

test("refuses a missing database file", () => {
    const space = workspace("missing");
    try {
        const result = run([join(space.path, "absent.sqlite"), ".tables"]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /database file not found/);
    } finally {
        space.dispose();
    }
});

test("prints usage and the command banner", () => {
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Supported dot commands/);
    const version = run(["--version"]);
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^sqlite3 \(SQLite format-3 reader over @yydb\/sqlite\)\n$/);
});
