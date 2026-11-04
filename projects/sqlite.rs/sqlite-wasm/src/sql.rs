//! Minimal SQL front end for the in-memory wasm database.
//!
//! Supported statements, deliberately small and fail-closed:
//!
//! | Statement | Shape |
//! |-----------|-------|
//! | `CREATE TABLE` | column list with `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT` |
//! | `INSERT` | optional column list, one or more `VALUES` tuples |
//! | `SELECT` | `count(*)`, `*`, or an explicit column list, with optional `LIMIT` |
//!
//! Anything else (`WHERE`, `JOIN`, `UPDATE`, `DELETE`, table-level constraints,
//! views, triggers, `ALTER`, `DROP`) is rejected with a message instead of
//! being silently approximated.

use sqlite::{ColumnSpec, WriteValue};

/// One literal value parsed from a `VALUES` tuple or a `DEFAULT` clause.
#[derive(Clone, Debug, PartialEq)]
pub enum Literal {
    /// SQL `NULL`.
    Null,
    /// Signed 64-bit integer.
    Integer(i64),
    /// IEEE-754 binary64.
    Real(f64),
    /// Text without quotes, with `''` already collapsed to `'`.
    Text(String),
    /// Blob bytes from `X'…'`.
    Blob(Vec<u8>),
}

impl Literal {
    /// Converts the literal into the writer's value type.
    pub fn to_write_value(&self) -> WriteValue {
        match self {
            Self::Null => WriteValue::Null,
            Self::Integer(value) => WriteValue::Integer(*value),
            Self::Real(value) => WriteValue::Real(*value),
            Self::Text(value) => WriteValue::Text(value.clone()),
            Self::Blob(value) => WriteValue::Blob(value.clone()),
        }
    }
}

/// Projection of a `SELECT` statement.
#[derive(Clone, Debug, PartialEq)]
pub enum SelectItems {
    /// `count(*)`.
    CountAll,
    /// `*`.
    Star,
    /// Explicit column list in source order.
    Named(Vec<String>),
}

/// One parsed statement.
#[derive(Clone, Debug)]
pub enum Statement {
    /// `CREATE TABLE ...`.
    CreateTable {
        /// Table name as written.
        name: String,
        /// `IF NOT EXISTS` was present.
        if_not_exists: bool,
        /// Column definitions in declaration order.
        columns: Vec<ColumnSpec>,
    },
    /// `INSERT INTO ... VALUES ...`.
    Insert {
        /// Target table name as written.
        table: String,
        /// Optional explicit column list.
        columns: Option<Vec<String>>,
        /// One literal tuple per inserted row.
        rows: Vec<Vec<Literal>>,
    },
    /// `SELECT ... FROM ... [LIMIT n]`.
    Select {
        /// Source table name as written.
        table: String,
        /// Selected projection.
        items: SelectItems,
        /// Optional row limit.
        limit: Option<usize>,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Word(String),
    Quoted(String),
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
    Comma,
    LParen,
    RParen,
    Star,
    Semi,
    Minus,
}

impl Token {
    fn describe(&self) -> String {
        match self {
            Self::Word(word) => format!("`{word}`"),
            Self::Quoted(word) => format!("`\"{word}\"`"),
            Self::Int(value) => format!("`{value}`"),
            Self::Real(value) => format!("`{value}`"),
            Self::Text(_) => "a string literal".to_string(),
            Self::Blob(_) => "a blob literal".to_string(),
            Self::Comma => "`,`".to_string(),
            Self::LParen => "`(`".to_string(),
            Self::RParen => "`)`".to_string(),
            Self::Star => "`*`".to_string(),
            Self::Semi => "`;`".to_string(),
            Self::Minus => "`-`".to_string(),
        }
    }
}

/// Parses one or more semicolon-separated statements.
pub fn parse(source: &str) -> Result<Vec<Statement>, String> {
    let tokens = tokenize(source)?;
    let mut parser = Parser { tokens, at: 0 };
    let mut statements = Vec::new();
    while !parser.done() {
        if parser.peek() == Some(&Token::Semi) {
            parser.at += 1;
            continue;
        }
        statements.push(parser.statement()?);
        if parser.peek() == Some(&Token::Semi) {
            parser.at += 1;
        }
    }
    Ok(statements)
}

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        let byte = bytes[at];
        match byte {
            byte if byte.is_ascii_whitespace() => at += 1,
            b'-' if bytes.get(at + 1) == Some(&b'-') => {
                while at < bytes.len() && bytes[at] != b'\n' {
                    at += 1;
                }
            }
            b'/' if bytes.get(at + 1) == Some(&b'*') => {
                at += 2;
                loop {
                    if at + 1 >= bytes.len() {
                        return Err("unterminated `/* ... */` comment".to_string());
                    }
                    if bytes[at] == b'*' && bytes[at + 1] == b'/' {
                        at += 2;
                        break;
                    }
                    at += 1;
                }
            }
            b',' => {
                tokens.push(Token::Comma);
                at += 1;
            }
            b'(' => {
                tokens.push(Token::LParen);
                at += 1;
            }
            b')' => {
                tokens.push(Token::RParen);
                at += 1;
            }
            b'*' => {
                tokens.push(Token::Star);
                at += 1;
            }
            b';' => {
                tokens.push(Token::Semi);
                at += 1;
            }
            b'-' => {
                tokens.push(Token::Minus);
                at += 1;
            }
            b'\'' => {
                let (text, next) = read_quoted(source, at, b'\'', b'\'')?;
                tokens.push(Token::Text(text));
                at = next;
            }
            b'"' => {
                let (text, next) = read_quoted(source, at, b'"', b'"')?;
                tokens.push(Token::Quoted(text));
                at = next;
            }
            b'[' => {
                let mut text = String::new();
                at += 1;
                while at < bytes.len() {
                    if bytes[at] == b']' {
                        break;
                    }
                    text.push(char::from(bytes[at]));
                    at += 1;
                }
                if at >= bytes.len() {
                    return Err("unterminated `[...]` identifier".to_string());
                }
                tokens.push(Token::Quoted(text));
                at += 1;
            }
            b'`' => {
                let (text, next) = read_quoted(source, at, b'`', b'`')?;
                tokens.push(Token::Quoted(text));
                at = next;
            }
            byte if byte.is_ascii_digit() => {
                let (token, next) = read_number(source, at)?;
                tokens.push(token);
                at = next;
            }
            byte if is_word_start(byte) => {
                let mut word = String::new();
                while at < bytes.len() && is_word_part(bytes[at]) {
                    word.push(char::from(bytes[at]));
                    at += 1;
                }
                if word.eq_ignore_ascii_case("x") && bytes.get(at) == Some(&b'\'') {
                    let (text, next) = read_quoted(source, at, b'\'', b'\'')?;
                    tokens.push(Token::Blob(decode_hex(&text)?));
                    at = next;
                }
                else {
                    tokens.push(Token::Word(word));
                }
            }
            other => return Err(format!("unsupported character `{}` in SQL", char::from(other))),
        }
    }
    Ok(tokens)
}

fn is_word_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn is_word_part(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn read_quoted(source: &str, at: usize, open: u8, close: u8) -> Result<(String, usize), String> {
    let bytes = source.as_bytes();
    debug_assert_eq!(bytes.get(at), Some(&open));
    let mut text = String::new();
    let mut index = at + 1;
    while index < bytes.len() {
        if bytes[index] == close {
            if bytes.get(index + 1) == Some(&close) {
                text.push(char::from(close));
                index += 2;
                continue;
            }
            return Ok((text, index + 1));
        }
        text.push(char::from(bytes[index]));
        index += 1;
    }
    Err("unterminated quoted literal".to_string())
}

fn read_number(source: &str, at: usize) -> Result<(Token, usize), String> {
    let bytes = source.as_bytes();
    let start = at;
    let mut index = at;
    if bytes.get(index) == Some(&b'0') && matches!(bytes.get(index + 1), Some(b'x') | Some(b'X')) {
        index += 2;
        let digits_start = index;
        while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
            index += 1;
        }
        let value = i64::from_str_radix(&source[digits_start..index], 16)
            .map_err(|_| "hexadecimal integer literal is out of the signed 64-bit range".to_string())?;
        return Ok((Token::Int(value), index));
    }
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let mut real = false;
    if bytes.get(index) == Some(&b'.') {
        real = true;
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
    }
    if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        let next = index + 1;
        let signed = matches!(bytes.get(next), Some(b'+') | Some(b'-'));
        let digits = if signed { next + 1 } else { next };
        if bytes.get(digits).is_some_and(u8::is_ascii_digit) {
            real = true;
            index = digits;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
        }
    }
    let text = &source[start..index];
    if real {
        let value = text.parse::<f64>().map_err(|_| format!("real literal `{text}` is not a finite f64"))?;
        if !value.is_finite() {
            return Err(format!("real literal `{text}` is not a finite f64"));
        }
        Ok((Token::Real(value), index))
    }
    else {
        let value = text.parse::<i64>().map_err(|_| format!("integer literal `{text}` is out of the signed 64-bit range"))?;
        Ok((Token::Int(value), index))
    }
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("blob literal must have an even number of hex digits".to_string());
    }
    let mut bytes = Vec::with_capacity(text.len() / 2);
    let mut index = 0;
    while index < text.len() {
        let byte = u8::from_str_radix(&text[index..index + 2], 16)
            .map_err(|_| "blob literal contains a non-hex digit".to_string())?;
        bytes.push(byte);
        index += 2;
    }
    Ok(bytes)
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
}

impl Parser {
    fn done(&self) -> bool {
        self.at >= self.tokens.len()
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.at).cloned();
        if token.is_some() {
            self.at += 1;
        }
        token
    }

    fn take(&mut self) -> Result<Token, String> {
        self.next().ok_or_else(|| "unexpected end of SQL".to_string())
    }

    fn peek_word(&self) -> Option<&str> {
        match self.peek() {
            Some(Token::Word(word)) => Some(word.as_str()),
            _ => None,
        }
    }

    fn eat_word(&mut self, keyword: &str) -> bool {
        if self.peek_word().is_some_and(|word| word.eq_ignore_ascii_case(keyword)) {
            self.at += 1;
            true
        }
        else {
            false
        }
    }

    fn expect_word(&mut self, keyword: &str) -> Result<(), String> {
        if self.eat_word(keyword) {
            Ok(())
        }
        else {
            match self.peek() {
                Some(token) => Err(format!("expected `{keyword}` but found {}", token.describe())),
                None => Err(format!("expected `{keyword}` but the statement ended")),
            }
        }
    }

    fn expect_char(&mut self, expected: &Token) -> Result<(), String> {
        match self.peek() {
            Some(token) if token == expected => {
                self.at += 1;
                Ok(())
            }
            Some(token) => Err(format!("expected {} but found {}", describe_expected(expected), token.describe())),
            None => Err(format!("expected {} but the statement ended", describe_expected(expected))),
        }
    }

    fn name(&mut self) -> Result<String, String> {
        match self.next() {
            Some(Token::Word(word)) => Ok(word),
            Some(Token::Quoted(word)) => Ok(word),
            Some(token) => Err(format!("expected an identifier but found {}", token.describe())),
            None => Err("expected an identifier but the statement ended".to_string()),
        }
    }

    fn statement(&mut self) -> Result<Statement, String> {
        if self.eat_word("create") {
            return self.create_table();
        }
        if self.eat_word("insert") {
            return self.insert();
        }
        if self.eat_word("select") {
            return self.select();
        }
        let found = self.peek().map(Token::describe).unwrap_or_else(|| "end of SQL".to_string());
        Err(format!(
            "unsupported statement starting at {found}; this engine accepts `CREATE TABLE`, `INSERT`, and `SELECT` only"
        ))
    }

    fn create_table(&mut self) -> Result<Statement, String> {
        self.expect_word("table")?;
        let if_not_exists = if self.eat_word("if") {
            self.expect_word("not")?;
            self.expect_word("exists")?;
            true
        }
        else {
            false
        };
        let name = self.name()?;
        self.expect_char(&Token::LParen)?;
        let mut columns = Vec::new();
        loop {
            columns.push(self.column_spec()?);
            match self.peek() {
                Some(Token::Comma) => {
                    self.at += 1;
                }
                Some(Token::RParen) => {
                    self.at += 1;
                    break;
                }
                Some(token) => return Err(format!("expected `,` or `)` after a column definition but found {}", token.describe())),
                None => return Err("create table column list is not closed".to_string()),
            }
        }
        Ok(Statement::CreateTable { name, if_not_exists, columns })
    }

    fn column_spec(&mut self) -> Result<ColumnSpec, String> {
        let name = self.name()?;
        let mut declared_type = Vec::new();
        while let Some(word) = self.peek_word() {
            let lower = word.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "primary" | "not" | "null" | "unique" | "default" | "constraint" | "check" | "references" | "collate" | "generated"
            ) {
                break;
            }
            declared_type.push(word.to_string());
            self.at += 1;
        }
        let declared_type = if declared_type.is_empty() { "BLOB".to_string() } else { declared_type.join(" ") };
        let mut spec = ColumnSpec {
            name,
            declared_type,
            not_null: false,
            default_value: None,
            primary_key: false,
            unique: false,
        };
        loop {
            if self.eat_word("primary") {
                self.expect_word("key")?;
                spec.primary_key = true;
            }
            else if self.eat_word("not") {
                self.expect_word("null")?;
                spec.not_null = true;
            }
            else if self.eat_word("unique") {
                spec.unique = true;
            }
            else if self.eat_word("null") {
                // Explicit `NULL` is the SQLite default; nothing to record.
            }
            else if self.eat_word("default") {
                spec.default_value = Some(self.literal()?.to_write_value());
            }
            else if self.eat_word("constraint") || self.eat_word("check") || self.eat_word("references") || self.eat_word("collate") {
                return Err(format!("unsupported column constraint in `{}`", spec.name));
            }
            else if self.eat_word("generated") {
                return Err(format!("unsupported generated column `{}`", spec.name));
            }
            else {
                break;
            }
        }
        Ok(spec)
    }

    fn literal(&mut self) -> Result<Literal, String> {
        let negative = matches!(self.peek(), Some(Token::Minus));
        if negative {
            self.at += 1;
        }
        let token = self.take()?;
        let literal = match token {
            Token::Int(value) if negative => Literal::Integer(value.checked_neg().ok_or_else(|| "integer literal underflow".to_string())?),
            Token::Real(value) if negative => Literal::Real(-value),
            Token::Int(value) => Literal::Integer(value),
            Token::Real(value) => Literal::Real(value),
            Token::Text(value) => Literal::Text(value),
            Token::Blob(value) => Literal::Blob(value),
            Token::Word(word) if word.eq_ignore_ascii_case("null") => Literal::Null,
            Token::Word(word) if word.eq_ignore_ascii_case("true") => Literal::Integer(1),
            Token::Word(word) if word.eq_ignore_ascii_case("false") => Literal::Integer(0),
            other => return Err(format!("expected a literal but found {}", other.describe())),
        };
        if negative && matches!(literal, Literal::Integer(_) | Literal::Real(_)) {
            return Ok(literal);
        }
        if negative {
            return Err("`-` must prefix a numeric literal".to_string());
        }
        Ok(literal)
    }

    fn insert(&mut self) -> Result<Statement, String> {
        self.expect_word("into")?;
        let table = self.name()?;
        let columns = if self.peek() == Some(&Token::LParen) {
            self.at += 1;
            let mut names = Vec::new();
            loop {
                names.push(self.name()?);
                match self.peek() {
                    Some(Token::Comma) => {
                        self.at += 1;
                    }
                    Some(Token::RParen) => {
                        self.at += 1;
                        break;
                    }
                    Some(token) => return Err(format!("expected `,` or `)` in the column list but found {}", token.describe())),
                    None => return Err("insert column list is not closed".to_string()),
                }
            }
            Some(names)
        }
        else {
            None
        };
        self.expect_word("values")?;
        let mut rows = Vec::new();
        loop {
            self.expect_char(&Token::LParen)?;
            let mut values = Vec::new();
            loop {
                values.push(self.literal()?);
                match self.peek() {
                    Some(Token::Comma) => {
                        self.at += 1;
                    }
                    Some(Token::RParen) => {
                        self.at += 1;
                        break;
                    }
                    Some(token) => return Err(format!("expected `,` or `)` in a VALUES tuple but found {}", token.describe())),
                    None => return Err("insert VALUES tuple is not closed".to_string()),
                }
            }
            rows.push(values);
            if self.peek() == Some(&Token::Comma) {
                self.at += 1;
                continue;
            }
            break;
        }
        Ok(Statement::Insert { table, columns, rows })
    }

    fn select(&mut self) -> Result<Statement, String> {
        let items = if self.peek() == Some(&Token::Star) {
            self.at += 1;
            SelectItems::Star
        }
        else if self.peek_word().is_some_and(|word| word.eq_ignore_ascii_case("count")) {
            self.at += 1;
            self.expect_char(&Token::LParen)?;
            self.expect_char(&Token::Star)?;
            self.expect_char(&Token::RParen)?;
            SelectItems::CountAll
        }
        else {
            let mut names = Vec::new();
            loop {
                names.push(self.name()?);
                match self.peek() {
                    Some(Token::Comma) => {
                        self.at += 1;
                    }
                    Some(Token::Word(word)) if word.eq_ignore_ascii_case("from") => break,
                    Some(token) => return Err(format!("expected `,` or `FROM` in the projection but found {}", token.describe())),
                    None => return Err("select projection is incomplete".to_string()),
                }
            }
            SelectItems::Named(names)
        };
        self.expect_word("from")?;
        let table = self.name()?;
        let limit = if self.eat_word("limit") {
            let negative = matches!(self.peek(), Some(Token::Minus));
            if negative {
                self.at += 1;
            }
            match self.take()? {
                Token::Int(value) if !negative && value >= 0 => Some(value as usize),
                Token::Int(_) => return Err("`LIMIT` must be a non-negative integer".to_string()),
                token => return Err(format!("`LIMIT` must be an integer but found {}", token.describe())),
            }
        }
        else {
            None
        };
        match self.peek() {
            None | Some(Token::Semi) => Ok(Statement::Select { table, items, limit }),
            Some(token) => {
                Err(format!("unsupported `SELECT` clause starting at {}; this engine supports `FROM` and `LIMIT` only", token.describe()))
            }
        }
    }
}

fn describe_expected(token: &Token) -> String {
    token.describe()
}
