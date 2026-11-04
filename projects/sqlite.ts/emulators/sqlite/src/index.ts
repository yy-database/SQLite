// The emulator entry re-exports the product facade so a consumer that wants the
// `sqlite3` command persona and the reader types can depend on one package.
// It adds no reader of its own and no SQL execution.

export {
    bindings,
    createWriter,
    openDatabase,
    openSnapshot,
    openWriter,
    platformKey,
    writeSlots,
    writeValue,
} from "@yydb/sqlite";

export type {
    ColumnSpec,
    DecodedRow,
    NativeBindings,
    NativeDatabase,
    NativeDatabaseConstructor,
    NativeSnapshot,
    NativeSnapshotConstructor,
    NativeWriter,
    NativeWriterConstructor,
    PlatformKey,
    RawRow,
    ReadLimits,
    RecordValue,
    SchemaObject,
} from "@yydb/sqlite";
