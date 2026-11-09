// 正式产品入口：`new SQLite(options?)` 是一个已经打开、可直接使用的连接。
//
// 类型映射是忠实的：SQLite INTEGER→`bigint`（含 rowid 与 `lastInsertRowid`）、
// REAL→`number`、TEXT→`string`、BLOB→`Uint8Array`、NULL→`null`；绑定参数与
// 读取遵守同一映射。库不做任何按大小、按精度的自动改判，也不替用户把
// Date/对象转换成数据库值（boolean→INTEGER 0/1 是显式合同）。
//
// 只暴露真实兑现的能力：需要上游存储/锁/回调链路才能成立的选项
// （`busyTimeoutMs`、`journalMode: "delete" | "wal"`、`limits`、UDF）在被显式
// 请求时抛 `unsupported`，而不是在 TS 里记一个字段假装实现。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bindings } from "./index.ts";

/** 结果值：忠实映射 SQLite 存储类别。 */
export type SQLiteValue = null | bigint | number | string | Uint8Array;

/** 可绑定值：结果值加上显式的 `boolean`（转 INTEGER 0/1）。 */
export type SQLiteBindValue = SQLiteValue | boolean;

/** 参数容器只有两种形状：位置数组或具名对象。 */
export type SQLiteParams = readonly SQLiteBindValue[] | Readonly<Record<string, SQLiteBindValue>>;

/** 对象行；重复列标签在执行时抛错，用 `.raw()`/`AS` 消歧。 */
export type SQLiteRow = Readonly<Record<string, SQLiteValue>>;

export interface SQLiteRunResult {
  changes: number;
  lastInsertRowid: bigint;
}

export interface SQLiteOptions {
  /** 文件路径；与 `data` 互斥。不存在时默认创建（`create: false` 要求已存在）。 */
  filename?: string | URL;
  /** 从镜像创建私有内存副本；不自动写回传入数组。 */
  data?: Uint8Array;
  /** 文件不存在时是否创建，默认 `true`。 */
  create?: boolean;
  /** 只读打开：拒绝任何写语句，永不写文件。默认 `false`。 */
  readOnly?: boolean;
  /** 外键约束，默认开启（本绑定的明确产品策略）。 */
  foreignKeys?: boolean;
  /** 仅支持 `"preserve"`（提交时发布一致镜像）；`"delete"`/`"wal"` 需要真实日志实现，显式请求会抛 unsupported。 */
  journalMode?: "preserve" | "delete" | "wal";
  /** 新建库的页大小，默认 4096。 */
  pageSize?: number;
  /** 未支持：需要真实锁实现。传入即抛 `unsupported`。 */
  busyTimeoutMs?: number;
  /** 未支持：需要上游限额链路。传入即抛 `unsupported`。 */
  limits?: Record<string, number>;
}

interface TypedResult {
  statement: string;
  affected: number;
  lastInsertRowid: bigint;
  columns: string[];
  rows: SQLiteValue[][];
}

interface TypedEngine {
  runTyped(statement: string, parameters?: unknown[]): TypedResult;
  exec(script: string): unknown;
  inTransaction(): boolean;
  snapshot(): Uint8Array;
  pageSize(): number;
  sqliteVersion(): string;
}

/** 统一错误：`code` 是稳定合同，原始引擎错误保留在 `cause`。 */
export class SQLiteError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SQLiteError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// SQL 词法：单语句判定 + 占位符扫描（跳过字符串字面量、引用标识符与注释）。
// ---------------------------------------------------------------------------

type Token = { text: string; start: number; end: number };

function lexSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (character === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === character) {
          if (sql[index + 1] === character) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ text: sql.slice(start, index), start, end: index });
      continue;
    }
    if (character === "[") {
      const start = index;
      const end = sql.indexOf("]", index);
      index = end === -1 ? sql.length : end + 1;
      tokens.push({ text: sql.slice(start, index), start, end: index });
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === ";") {
      tokens.push({ text: ";", start: index, end: index + 1 });
      index += 1;
      continue;
    }
    // 占位符：`?` / `?NNN` 单独成 token；`$name`、`@name` 带前缀成词；`:` 与词分开。
    if (character === "?") {
      const start = index;
      index += 1;
      while (index < sql.length && /\d/.test(sql[index]!)) index += 1;
      tokens.push({ text: sql.slice(start, index), start, end: index });
      continue;
    }
    if (character === "$" || character === "@") {
      const start = index;
      index += 1;
      while (index < sql.length && /\w/.test(sql[index]!)) index += 1;
      if (index === start + 1) {
        tokens.push({ text: character, start, end: index });
      } else {
        tokens.push({ text: sql.slice(start, index), start, end: index });
      }
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      while (index < sql.length && /\w/.test(sql[index]!)) index += 1;
      tokens.push({ text: sql.slice(start, index), start, end: index });
      continue;
    }
    tokens.push({ text: character, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function statementRanges(tokens: Token[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const token of tokens) {
    if (token.text === ";") {
      ranges.push({ start, end: token.start });
      start = token.end;
    }
  }
  ranges.push({ start, end: Number.POSITIVE_INFINITY });
  return ranges.filter((range) => tokens.some((token) => token.start >= range.start && token.start < range.end && token.text !== ";"));
}

/** `prepare/run/get/all/iterate` 只接受一个语句；第二条直接拒绝。 */
function assertSingleStatement(tokens: Token[]): void {
  if (statementRanges(tokens).length > 1) {
    throw new SQLiteError("multi-statement", "prepared statements must contain exactly one statement; use exec() for scripts");
  }
}

type Placeholder = { kind: "positional"; index: number } | { kind: "named"; prefix: string; name: string; index: number };

function scanPlaceholders(tokens: Token[]): Placeholder[] {
  const slots: Placeholder[] = [];
  let auto = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.text === "?") {
      auto += 1;
      slots.push({ kind: "positional", index: auto });
      continue;
    }
    const explicit = /^\?(\d+)$/.exec(token.text);
    if (explicit) {
      slots.push({ kind: "positional", index: Number(explicit[1]) });
      continue;
    }
    if (token.text === ":" || token.text === "$" || token.text === "@") {
      const word = tokens[index + 1];
      if (word !== undefined && /^\w+$/.test(word.text)) {
        auto += 1;
        slots.push({ kind: "named", prefix: token.text, name: word.text, index: auto });
        index += 1;
      }
      continue;
    }
    const prefixed = /^([:$@])(\w+)$/.exec(token.text);
    if (prefixed) {
      auto += 1;
      slots.push({ kind: "named", prefix: prefixed[1]!, name: prefixed[2]!, index: auto });
    }
  }
  return slots;
}

function normalizeBindValue(value: unknown): SQLiteBindValue {
  if (value === undefined) {
    throw new SQLiteError("param-undefined", "SQL NULL must be an explicit null; undefined is not a bindable value");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value > 9223372036854775807n || value < -9223372036854775808n) {
      throw new SQLiteError("param-range", "bigint parameter exceeds the signed 64-bit INTEGER range");
    }
    return value;
  }
  if (value instanceof Uint8Array) return Buffer.isBuffer(value) ? value : Buffer.from(value);
  throw new SQLiteError("param-type", "cannot bind Date, arrays or plain objects; convert them explicitly (e.g. value.toISOString(), JSON.stringify)");
}

/** 参数合同：缺失、多余、`undefined` 都报错；每次执行完整重新绑定。 */
function bindParameters(tokens: Token[], params: SQLiteParams | undefined): unknown[] {
  const slots = scanPlaceholders(tokens);
  const providedCount =
    params === undefined ? 0 : Array.isArray(params) ? params.length : Object.keys(params).length;
  if (slots.length === 0) {
    if (providedCount > 0) throw new SQLiteError("param-extra", "statement has no placeholders but parameters were provided");
    return [];
  }
  if (params === undefined) {
    throw new SQLiteError("param-missing", `statement needs ${slots.length} parameter(s) but none were provided`);
  }
  if (Array.isArray(params)) {
    if (slots.some((slot) => slot.kind === "named")) {
      throw new SQLiteError("param-shape", "named placeholders require an object container");
    }
    const indices = new Set<number>();
    for (const slot of slots) {
      if (slot.kind !== "positional" || indices.has(slot.index)) {
        throw new SQLiteError("param-index", "positional placeholders must be distinct");
      }
      indices.add(slot.index);
    }
    const max = Math.max(...indices);
    if (indices.size !== max) throw new SQLiteError("param-index", "positional placeholders must fill indices 1..n without gaps");
    if (params.length > indices.size) {
      throw new SQLiteError("param-extra", `statement takes ${indices.size} parameter(s), got ${params.length}`);
    }
    if (params.length < indices.size) {
      throw new SQLiteError("param-missing", `expected ${indices.size} positional parameter(s), got ${params.length}`);
    }
    const cells: unknown[] = new Array(max).fill(undefined);
    for (const slot of slots) {
      if (slot.kind !== "positional") continue;
      const value = normalizeBindValue(params[slot.index - 1]);
      cells[slot.index - 1] = value;
    }
    return cells;
  }
  if (slots.some((slot) => slot.kind === "positional")) {
    throw new SQLiteError("param-shape", "positional placeholders require an array container");
  }
  const names = slots.filter((slot): slot is Extract<Placeholder, { kind: "named" }> => slot.kind === "named");
  const ambiguous = new Set<string>();
  const prefixOf = new Map<string, string>();
  for (const slot of names) {
    const previous = prefixOf.get(slot.name);
    if (previous !== undefined && previous !== slot.prefix) ambiguous.add(slot.name);
    else prefixOf.set(slot.name, slot.prefix);
  }
  const record = params as Record<string, unknown>;
  const allPrefixes = [":", "$", "@"];
  const cells: unknown[] = [];
  const consumed = new Set<string>();
  for (const slot of names) {
    const exactKey = slot.prefix + slot.name;
    // 前缀省略：名字在语句中不歧义时，裸键或任意前缀键都可命中。
    const candidates = ambiguous.has(slot.name) ? [exactKey] : [exactKey, slot.name, ...allPrefixes.map((prefix) => prefix + slot.name)];
    const key = candidates.find((candidate) => record[candidate] !== undefined);
    if (key === undefined) {
      const keyHint = ambiguous.has(slot.name) ? `exact key "${exactKey}"` : `"${slot.name}" or "${exactKey}"`;
      throw new SQLiteError("param-missing", `missing value for placeholder ${exactKey}; provide ${keyHint}`);
    }
    consumed.add(key);
    cells.push(normalizeBindValue(record[key]));
  }
  const extra = Object.keys(record).filter((key) => !consumed.has(key));
  if (extra.length > 0) throw new SQLiteError("param-extra", `unused parameter keys: ${extra.join(", ")}`);
  return cells;
}

const MUTATION_FIRST_WORDS = new Set(["insert", "update", "delete", "replace", "create", "drop", "alter", "vacuum", "reindex"]);
const TRANSACTION_WORDS = new Set(["begin", "commit", "end", "rollback", "savepoint", "release"]);

function firstWordOf(tokens: Token[], range: { start: number; end: number }): string | null {
  const token = tokens.find((entry) => entry.start >= range.start && entry.start < range.end && entry.text !== ";");
  return token ? token.text.toLowerCase() : null;
}

function scriptTouchesTransactionControl(tokens: Token[]): boolean {
  return statementRanges(tokens).some((range) => {
    const word = firstWordOf(tokens, range);
    return word !== null && TRANSACTION_WORDS.has(word);
  });
}

function scriptHasMutation(tokens: Token[]): boolean {
  return statementRanges(tokens).some((range) => {
    const word = firstWordOf(tokens, range);
    if (word === null) return false;
    if (MUTATION_FIRST_WORDS.has(word)) return true;
    // `PRAGMA name = value` 改变连接状态，视为写。
    return word === "pragma" && tokens.some((token) => token.start >= range.start && token.start < range.end && token.text === "=");
  });
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

type ResultView = "object" | "raw" | "pluck";

export class Statement<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams> {
  readonly #db: SQLite;
  readonly #sql: string;
  readonly #tokens: Token[];
  readonly #view: ResultView;
  #activeCursor = false;
  #columns: string[] | null = null;
  #closed = false;

  constructor(db: SQLite, sql: string, view: ResultView = "object") {
    this.#db = db;
    this.#sql = sql;
    this.#tokens = lexSql(sql);
    assertSingleStatement(this.#tokens);
    this.#view = view;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** 结果列标签。prepare 期元数据需要上游 describe 支持，首次执行前会抛 `columns-pending`。 */
  columns(): string[] {
    if (this.#columns === null) {
      throw new SQLiteError("columns-pending", "column metadata is captured on first execution; prepare-time describe is not available yet");
    }
    return [...this.#columns];
  }

  raw(): Statement<SQLiteValue[], Params> {
    return new Statement(this.#db, this.#sql, "raw") as Statement<SQLiteValue[], Params>;
  }

  pluck<T = SQLiteValue>(): Statement<T, Params> {
    return new Statement(this.#db, this.#sql, "pluck") as Statement<T, Params>;
  }

  run(params?: Params): SQLiteRunResult {
    const result = this.#execute(params);
    return { changes: result.affected, lastInsertRowid: result.lastInsertRowid };
  }

  get(params?: Params): Row | undefined {
    const result = this.#execute(params);
    if (result.rows.length === 0) return undefined;
    return this.#shape(result, 0) as Row;
  }

  all(params?: Params): Row[] {
    const result = this.#execute(params);
    return result.rows.map((_row, index) => this.#shape(result, index) as Row);
  }

  /**
   * 逐行读取。上游游标链路就绪前，行集在引擎内已物化，本方法提供正确的
   * 游标接口：`for...of` 的耗尽、`break`、异常都会释放游标；手动 `next()`
   * 中途退出需要 `close()`（即 `return()`）。同一 Statement 有活跃游标时
   * 禁止重复执行，不静默打断旧游标。
   */
  iterate(params?: Params): Generator<Row, void, unknown> {
    if (this.#activeCursor) throw new SQLiteError("cursor-active", "statement already has an active cursor; close it before re-executing");
    const result = this.#execute(params);
    const total = result.rows.length;
    const shape = this.#shape.bind(this);
    this.#activeCursor = true;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.#activeCursor = false;
      }
    };
    function* rows(): Generator<Row, void, unknown> {
      try {
        for (let index = 0; index < total; index += 1) yield shape(result, index) as Row;
      } finally {
        release();
      }
    }
    const generator = rows();
    const originalReturn = generator.return.bind(generator);
    generator.return = () => {
      release();
      return originalReturn();
    };
    return generator;
  }

  close(): void {
    this.#closed = true;
  }

  #shape(result: TypedResult, index: number): SQLiteValue | SQLiteRow | SQLiteValue[] {
    const row = result.rows[index]!;
    if (this.#view === "raw") return row;
    if (this.#view === "pluck") return row[0] ?? null;
    const labels = result.columns;
    const seen = new Set<string>();
    for (const label of labels) {
      if (seen.has(label)) {
        throw new SQLiteError("duplicate-column", `duplicate result label "${label}"; disambiguate with AS or use .raw()/.pluck()`);
      }
      seen.add(label);
    }
    const object: Record<string, SQLiteValue> = {};
    for (let column = 0; column < labels.length; column += 1) {
      object[labels[column]!] = row[column] ?? null;
    }
    return object;
  }

  #execute(params: SQLiteParams | undefined): TypedResult {
    if (this.#closed) throw new SQLiteError("statement-closed", "statement is closed");
    if (this.#activeCursor) throw new SQLiteError("cursor-active", "statement has an active cursor; finish or close it before re-executing");
    this.#db.assertUsable(this.#tokens);
    const engine = this.#db.engine();
    const cells = bindParameters(this.#tokens, params);
    let result: TypedResult;
    try {
      result = engine.runTyped(this.#sql, cells);
    } catch (error) {
      throw new SQLiteError("engine", error instanceof Error ? error.message : String(error), { cause: error });
    }
    this.#columns = result.columns;
    this.#db.afterStatement(this.#tokens, result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Transaction scope
// ---------------------------------------------------------------------------

/** `transaction()` 回调收到的作用域视图：不是新连接，出了作用域即失效。 */
export class TransactionScope {
  #db: SQLite;
  #active = true;

  constructor(db: SQLite) {
    this.#db = db;
  }

  prepare<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams>(sql: string): Statement<Row, Params> {
    this.#assert();
    return this.#db.prepareWithin<Row, Params>(sql, this);
  }

  run(sql: string, params?: SQLiteParams): SQLiteRunResult {
    return this.prepare(sql).run(params);
  }

  get<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Row | undefined {
    return this.prepare<Row>(sql).get(params) as Row | undefined;
  }

  all<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Row[] {
    return this.prepare<Row>(sql).all(params) as Row[];
  }

  iterate<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Generator<Row, void, unknown> {
    return this.prepare<Row>(sql).iterate(params) as Generator<Row, void, unknown>;
  }

  exec(script: string): void {
    this.#assert();
    this.#db.execWithin(script, this);
  }

  transaction<T>(callback: (tx: TransactionScope) => T): T {
    this.#assert();
    return this.#db.transaction(callback);
  }

  deactivate(): void {
    this.#active = false;
  }

  #assert(): void {
    if (!this.#active) throw new SQLiteError("scope-escaped", "transaction scope cannot be used outside its callback");
  }
}

// ---------------------------------------------------------------------------
// SQLite connection
// ---------------------------------------------------------------------------

let savepointCounter = 0;

export class SQLite {
  readonly #engine: TypedEngine;
  readonly #filename: string | null;
  readonly #readOnly: boolean;
  #managedScopes = 0;
  #closed = false;

  constructor(options: SQLiteOptions = {}) {
    if (options.busyTimeoutMs !== undefined) {
      throw new SQLiteError("unsupported", "busyTimeoutMs requires the real lock implementation; this snapshot engine has no busy handler");
    }
    if (options.limits !== undefined) {
      throw new SQLiteError("unsupported", "limits requires the upstream resource-limit chain; apply explicit checks at the call site for now");
    }
    if ((options as { integers?: unknown }).integers !== undefined) {
      throw new SQLiteError("unsupported", "the integers mode was removed; INTEGER is always bigint, REAL is always number");
    }
    if (options.journalMode !== undefined && options.journalMode !== "preserve") {
      throw new SQLiteError("unsupported", `journalMode "${options.journalMode}" needs a real journal/locking implementation`);
    }
    if (options.data !== undefined && (options.filename !== undefined || options.create !== undefined)) {
      throw new SQLiteError("option-conflict", "data is mutually exclusive with filename/create");
    }

    const foreignKeys = options.foreignKeys ?? true;
    if (options.filename !== undefined) {
      const path = typeof options.filename === "string" ? options.filename : fileURLToPath(options.filename);
      const exists = existsSync(path);
      if (!exists && options.create === false) throw new SQLiteError("not-found", `database file does not exist: ${path}`);
      if (!exists && options.readOnly) throw new SQLiteError("not-found", `read-only open requires an existing file: ${path}`);
      if (exists) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(path);
        } catch (error) {
          throw new SQLiteError("open-failed", `cannot read ${path}`, { cause: error });
        }
        this.#engine = fromSnapshot(bytes);
      } else {
        this.#engine = createEngine(options.pageSize ?? 4096);
      }
      this.#filename = path;
      this.#readOnly = options.readOnly ?? false;
    } else if (options.data !== undefined) {
      this.#engine = fromSnapshot(Buffer.from(options.data.slice()));
      this.#filename = null;
      this.#readOnly = false;
    } else {
      this.#engine = createEngine(options.pageSize ?? 4096);
      this.#filename = null;
      this.#readOnly = false;
    }

    // 新建的文件库立刻落一份一致镜像；打开失败在上面直接抛错。
    if (this.#filename !== null && !existsSync(this.#filename)) this.#publish();
    if (!this.#readOnly) this.#engine.runTyped(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }

  // --- 连接属性 -------------------------------------------------------------

  get filename(): string | null {
    return this.#filename;
  }

  get isOpen(): boolean {
    return !this.#closed;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  /** 真实引擎状态，不在 TS 里镜像布尔值。 */
  get inTransaction(): boolean {
    this.#assertOpen();
    return this.#engine.inTransaction();
  }

  get sqliteVersion(): string {
    this.#assertOpen();
    return this.#engine.sqliteVersion();
  }

  // --- 语句面 ---------------------------------------------------------------

  prepare<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams>(sql: string): Statement<Row, Params> {
    this.#assertOpen();
    return new Statement(this, sql) as Statement<Row, Params>;
  }

  run(sql: string, params?: SQLiteParams): SQLiteRunResult {
    return this.prepare(sql).run(params);
  }

  get<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Row | undefined {
    return this.prepare<Row>(sql).get(params) as Row | undefined;
  }

  all<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Row[] {
    return this.prepare<Row>(sql).all(params) as Row[];
  }

  iterate<Row = SQLiteRow>(sql: string, params?: SQLiteParams): Generator<Row, void, unknown> {
    return this.prepare<Row>(sql).iterate(params) as Generator<Row, void, unknown>;
  }

  /** 执行脚本，返回 `void`，不隐含事务；整批原子执行请放进 `transaction()`。 */
  exec(script: string): void {
    this.#assertOpen();
    const tokens = lexSql(script);
    if (this.#managedScopes > 0 && scriptTouchesTransactionControl(tokens)) {
      throw new SQLiteError("transaction-ownership", "managed transactions own BEGIN/COMMIT/ROLLBACK; do not issue them by hand inside transaction()");
    }
    if (this.#readOnly && scriptHasMutation(tokens)) throw readOnlyError();
    try {
      this.#engine.exec(script);
    } catch (error) {
      throw new SQLiteError("engine", error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (!this.#readOnly && scriptHasMutation(tokens) && !this.#engine.inTransaction()) this.#publish();
  }

  // --- 事务 -----------------------------------------------------------------

  /**
   * 立即执行并返回回调结果。回调成功提交、抛错回滚；提交因延迟约束失败
   * 同样回滚并传播失败。嵌套使用 savepoint，内层失败可由外层捕获后继续。
   * 禁止异步回调：返回值若是 Promise 会被拒绝（提交时机不可控）。
   */
  transaction<T>(callback: (tx: TransactionScope) => T, options?: { mode?: "deferred" }): T {
    this.#assertOpen();
    if (options?.mode !== undefined && options.mode !== "deferred") {
      throw new SQLiteError("unsupported", `transaction mode "${options.mode}" needs real lock semantics; this engine only has the deferred level`);
    }
    const nested = this.#engine.inTransaction();
    const name = nested ? `__sqlite_tx_${(savepointCounter += 1)}` : null;
    if (nested) this.#engine.runTyped(`SAVEPOINT ${name}`);
    else this.#engine.runTyped("BEGIN");

    const scope = new TransactionScope(this);
    this.#managedScopes += 1;
    let outcome: T;
    try {
      outcome = callback(scope);
    } catch (error) {
      this.#managedScopes -= 1;
      scope.deactivate();
      try {
        if (nested) {
          this.#engine.runTyped(`ROLLBACK TO ${name}`);
          this.#engine.runTyped(`RELEASE ${name}`);
        } else {
          this.#engine.runTyped("ROLLBACK");
        }
      } catch {
        // 回滚失败不掩盖原始错误。
      }
      throw error;
    }
    if ((outcome as unknown) instanceof Promise) {
      // 异步回调会把提交时机推到 Promise 之前，直接拒绝并回滚。
      try {
        if (nested) this.#engine.runTyped(`ROLLBACK TO ${name}`);
        else this.#engine.runTyped("ROLLBACK");
      } catch {
        // ignore
      }
      this.#managedScopes -= 1;
      scope.deactivate();
      throw new SQLiteError("async-callback", "transaction callbacks must be synchronous; Promise results are rejected before commit");
    }
    this.#managedScopes -= 1;
    scope.deactivate();
    try {
      if (nested) this.#engine.runTyped(`RELEASE ${name}`);
      else this.#engine.runTyped("COMMIT");
    } catch (error) {
      try {
        if (!nested) this.#engine.runTyped("ROLLBACK");
      } catch {
        // 回滚失败不掩盖提交失败。
      }
      throw new SQLiteError("commit-failed", error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (!nested) this.#publish();
    return outcome;
  }

  // --- 运维 -----------------------------------------------------------------

  pragma(name: string, options?: { scalar?: boolean; value?: SQLiteBindValue }): unknown {
    this.#assertOpen();
    if (!/^[\w]+$/.test(name)) throw new SQLiteError("option-invalid", `invalid pragma name ${JSON.stringify(name)}`);
    const set = options?.value !== undefined;
    if (set && this.#readOnly) throw readOnlyError();
    const sql = set ? `PRAGMA ${name} = ${literal(options.value!)}` : `PRAGMA ${name}`;
    const result = this.#engine.runTyped(sql);
    if (set && !this.#engine.inTransaction()) this.#publish();
    if (options?.scalar) return result.rows[0]?.[0] ?? undefined;
    return result.rows.map((row) => Object.fromEntries(result.columns.map((label, index) => [label, row[index] ?? null])));
  }

  /** 一致镜像导出；与 `backup()` 的合同不同。 */
  serialize(): Uint8Array {
    this.#assertOpen();
    return this.#engine.snapshot();
  }

  /** 正式备份：在事务外取一致镜像并原子落盘（tmp + rename）。 */
  backup(path: string | URL): void {
    this.#assertOpen();
    if (this.#engine.inTransaction()) {
      throw new SQLiteError("backup-in-transaction", "backup must run outside a transaction to capture a consistent image");
    }
    const target = typeof path === "string" ? path : fileURLToPath(path);
    const bytes = this.#engine.snapshot();
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
  }

  // --- UDF：等待上游回调链路 -------------------------------------------------

  function(): never {
    throw new SQLiteError("unsupported", "JS UDF registration needs the upstream host-function chain (database.udf is a Send+Sync contract, not a JS callback bridge)");
  }

  aggregate(): never {
    throw new SQLiteError("unsupported", "JS aggregate callbacks need the upstream host-function chain");
  }

  window(): never {
    throw new SQLiteError("unsupported", "JS window callbacks need the upstream host-function chain");
  }

  // --- 生命周期 -------------------------------------------------------------

  close(): void {
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // --- 内部（Statement/Scope 跨类协作面，@internal） -------------------------

  /** @internal */
  engine(): TypedEngine {
    this.#assertOpen();
    return this.#engine;
  }

  /** @internal 执行前校验：连接可用、只读、受管事务所有权。 */
  assertUsable(tokens: Token[]): void {
    this.#assertOpen();
    if (this.#managedScopes > 0 && scriptTouchesTransactionControl(tokens)) {
      throw new SQLiteError("transaction-ownership", "managed transactions own BEGIN/COMMIT/ROLLBACK; do not issue them by hand inside transaction()");
    }
    if (this.#readOnly && scriptHasMutation(tokens)) throw readOnlyError();
  }

  /** @internal 提交时发布：镜像只在事务边界落盘，不在每次执行后重写。 */
  afterStatement(tokens: Token[], result: TypedResult): void {
    if (this.#readOnly) return;
    if (this.#engine.inTransaction()) return;
    const mutating = scriptHasMutation(tokens) || result.statement === "commit" || result.statement === "end";
    if (mutating) this.#publish();
  }

  /** @internal */
  prepareWithin<Row = SQLiteRow, Params extends SQLiteParams = SQLiteParams>(sql: string, scope: TransactionScope): Statement<Row, Params> {
    void scope;
    return this.prepare<Row, Params>(sql);
  }

  /** @internal */
  execWithin(script: string, scope: TransactionScope): void {
    void scope;
    this.exec(script);
  }

  #assertOpen(): void {
    if (this.#closed) throw new SQLiteError("db-closed", "database is closed");
  }

  #publish(): void {
    if (this.#filename === null || this.#readOnly) return;
    try {
      writeFileSync(this.#filename, this.#engine.snapshot());
    } catch (error) {
      throw new SQLiteError("publish-failed", `cannot publish ${this.#filename}`, { cause: error });
    }
  }
}

function readOnlyError(): SQLiteError {
  return new SQLiteError("read-only", "database was opened read-only; mutations are rejected");
}

function createEngine(pageSize: number): TypedEngine {
  try {
    return bindings.SqliteEngine.create(pageSize) as unknown as TypedEngine;
  } catch (error) {
    throw new SQLiteError("open-failed", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function fromSnapshot(bytes: Buffer): TypedEngine {
  try {
    return bindings.SqliteEngine.fromSnapshot(bytes) as unknown as TypedEngine;
  } catch (error) {
    throw new SQLiteError("open-failed", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function literal(value: SQLiteBindValue): string {
  if (value === null) return "NULL";
  if (typeof value === "bigint") return `${value}`;
  if (typeof value === "number") return `${value}`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `x'${Buffer.from(value).toString("hex")}'`;
}
