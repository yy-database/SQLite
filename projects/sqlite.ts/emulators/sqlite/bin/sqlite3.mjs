#!/usr/bin/env node
import { existsSync } from "node:fs";

import { openDatabase } from "@yydb/sqlite";

// Read-only `sqlite3`-style command surface. The binding reads on-disk format-3
// bytes only, so this emulator offers inspection dot commands and never SQL
// execution, writes, journals, or WAL recovery.

const USAGE =
    "Usage: sqlite DATABASE COMMAND\n" +
    "Supported dot commands: .tables, .schema, .ping, .encoding, .version, .dump TABLE\n" +
    "This command inspects on-disk main-file bytes only, SQL execution is not available.";

function formatValue(value) {
    if (value.kind === "null") return "NULL";
    if (value.kind === "integer") return String(value.valueInteger ?? "");
    if (value.kind === "real") {
        const number = value.valueReal;
        if (number === undefined) return "";
        return Number.isInteger(number) ? `${number}.0` : String(number);
    }
    if (value.kind === "text") return value.valueText ?? "";
    if (value.kind === "blob") {
        const bytes = value.valueBlob;
        if (!bytes) return "";
        let hex = "";
        for (let index = 0; index < Math.min(bytes.length, 64); index += 1) {
            hex += bytes[index].toString(16).padStart(2, "0");
        }
        return `X'${hex}${bytes.length > 64 ? "…" : ""}'`;
    }
    return "";
}

function runDotCommand(database, command) {
    if (command === ".tables") {
        const tables = database
            .schema()
            .filter((object) => (object.kind === "table" || object.kind === "view") && !object.name.startsWith("sqlite_"))
            .map((object) => object.name)
            .sort();
        for (const name of tables) console.log(name);
        return;
    }
    if (command === ".schema") {
        const statements = database
            .schema()
            .filter((object) => object.sql && !object.name.startsWith("sqlite_"))
            .map((object) => object.sql.trimEnd());
        for (const source of statements) {
            console.log(source.endsWith(";") ? source : `${source};`);
        }
        return;
    }
    if (command === ".ping") {
        console.log(`ok ${database.ping()}`);
        return;
    }
    if (command === ".encoding") {
        console.log(database.encoding());
        return;
    }
    if (command === ".version") {
        console.log(database.sqliteVersion());
        return;
    }
    const dump = command.match(/^\.dump\s+(\S+)\s*$/);
    if (dump) {
        const rows = database.table(dump[1]);
        if (rows.length === 0) return;
        const width = new Array(rows[0].columns.length).fill(0);
        for (const row of rows) {
            for (let index = 0; index < row.columns.length; index += 1) {
                width[index] = Math.max(width[index], formatValue(row.columns[index]).length);
            }
        }
        const line = (cells) => cells.map((cell, index) => cell.padEnd(width[index])).join(" | ");
        for (const row of rows) {
            console.log(line([String(row.rowid), ...row.columns.map(formatValue)]));
        }
        return;
    }
    throw new Error(`unsupported dot command '${command}'`);
}

function main(args) {
    if (args.length === 1 && ["--version", "-version"].includes(args[0])) {
        console.log("sqlite3 (SQLite format-3 reader over @yydb/sqlite)");
        return;
    }
    if (args.length === 1 && ["--help", "-help"].includes(args[0])) {
        console.log(USAGE);
        return;
    }
    if (args.length !== 2 || args[0].startsWith("-") || args[0] === "") {
        throw new Error("expected DATABASE and one supported dot command");
    }
    const [path, input] = args;
    const command = input.trim();
    if (!command.startsWith(".")) {
        throw new Error("SQL execution is not available, use a dot command");
    }
    if (!existsSync(path)) {
        throw new Error(`database file not found: ${path}`);
    }
    runDotCommand(openDatabase(path), command);
}

try {
    main(process.argv.slice(2));
} catch (error) {
    console.error(`@yydb/sqlite-emulator: ${error.message}`);
    process.exitCode = 1;
}
