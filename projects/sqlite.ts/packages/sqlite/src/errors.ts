// 统一错误：`code` 是稳定合同，原始引擎错误保留在 `cause`。
//
// N-API 把引擎的结构化拒绝（`code`、`message`、`statement`、`clause`、
// `position`）以 JSON 信封放进错误的 `message`；这里解析信封还原稳定代码，
// 非结构化的绑定错误（JS 类型转换失败等）归入 `engine`。

export class SQLiteError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SQLiteError";
    this.code = code;
  }
}

/** 把原生抛出的错误映射为 `SQLiteError`，还原 Rust 侧的结构化 `code`。 */
export function toSQLiteError(error: unknown): SQLiteError {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (typeof parsed.code === "string" && typeof parsed.message === "string") {
      return new SQLiteError(parsed.code, parsed.message, { cause: error });
    }
  } catch {
    // 不是结构化信封，按绑定层错误处理。
  }
  return new SQLiteError("engine", message, { cause: error });
}
