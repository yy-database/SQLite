//! SQL 值与 JS 值之间的忠实转换。
//!
//! 存储类别由 JS 类型本身表达：INTEGER→`bigint`、REAL→`number`、TEXT→`string`、
//! BLOB→`Buffer`、NULL→`null`。绑定侧 `boolean` 不是可绑定值（SQL 没有布尔类型，
//! 转换是用户的业务决定）；输出侧不做任何按大小或按精度的自动改判。

use std::ptr;

use napi::{
    bindgen_prelude::{BigInt, Buffer, FromNapiValue, ToNapiValue, Unknown, ValueType},
    sys,
};
use sqlite::RecordValue;

pub(crate) unsafe fn js_string(env: sys::napi_env, text: &[u8]) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_string_utf8(env, text.as_ptr().cast(), text.len() as isize, &mut value) })?;
    Ok(value)
}

pub(crate) unsafe fn create_object(env: sys::napi_env) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_object(env, &mut value) })?;
    Ok(value)
}

pub(crate) unsafe fn create_array(env: sys::napi_env, length: usize) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_array_with_length(env, length, &mut value) })?;
    Ok(value)
}

/// INTEGER 一律是原生 `bigint`，不经过 `number` 的精度窗口。
pub(crate) unsafe fn create_integer(env: sys::napi_env, integer: i64) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_bigint_int64(env, integer, &mut value) })?;
    Ok(value)
}

/// 无符号计数（affected rows）同样以 `bigint` 呈现，不截断到 32 位。
pub(crate) unsafe fn create_count(env: sys::napi_env, count: u64) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_bigint_uint64(env, count, &mut value) })?;
    Ok(value)
}

pub(crate) unsafe fn create_real(env: sys::napi_env, real: f64) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_double(env, real, &mut value) })?;
    Ok(value)
}

pub(crate) unsafe fn create_null(env: sys::napi_env) -> napi::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_get_null(env, &mut value) })?;
    Ok(value)
}

pub(crate) unsafe fn set_property(
    env: sys::napi_env,
    object: sys::napi_value,
    key: sys::napi_value,
    value: sys::napi_value,
) -> napi::Result<()> {
    napi::check_status!(unsafe { sys::napi_set_property(env, object, key, value) })
}

pub(crate) unsafe fn set_element(env: sys::napi_env, array: sys::napi_value, index: usize, value: sys::napi_value) -> napi::Result<()> {
    napi::check_status!(unsafe { sys::napi_set_element(env, array, index as u32, value) })
}

/// 把一个解码值写进数组：整数用 bigint、实数用 number、文本用 string、blob 用 Buffer、NULL 用 null。
pub(crate) unsafe fn set_value(env: sys::napi_env, array: sys::napi_value, index: usize, value: RecordValue<'_>) -> napi::Result<()> {
    unsafe {
        let js = match value {
            RecordValue::Null => create_null(env)?,
            RecordValue::Integer(integer) => create_integer(env, integer)?,
            RecordValue::Real(real) => create_real(env, real)?,
            RecordValue::Text(text) => js_string(env, text.as_bytes())?,
            RecordValue::Blob(blob) => <Buffer as ToNapiValue>::to_napi_value(env, Buffer::from(blob.to_vec()))?,
        };
        set_element(env, array, index, js)
    }
}

/// 把一个执行结果单元格写进数组，映射与 [`set_value`] 同一套合同。
pub(crate) unsafe fn set_cell(env: sys::napi_env, array: sys::napi_value, index: usize, cell: &sqlite::Cell) -> napi::Result<()> {
    let js = unsafe {
        match cell {
            sqlite::Cell::Null => create_null(env)?,
            sqlite::Cell::Integer(value) => create_integer(env, *value)?,
            sqlite::Cell::Real(value) => create_real(env, *value)?,
            sqlite::Cell::Text(text) => js_string(env, text.as_bytes())?,
            sqlite::Cell::Blob(bytes) => <Buffer as ToNapiValue>::to_napi_value(env, Buffer::from(bytes.as_slice()))?,
        }
    };
    unsafe { set_element(env, array, index, js) }
}

/// 忠实类型化的绑定参数：TS 层已完成形状校验（`undefined`、Date、嵌套对象
/// 都在进入这里之前被拒绝），本层只做无损映射：`bigint`→INTEGER、
/// `number`→REAL、`string`→TEXT、`Buffer`/`Uint8Array`→BLOB、`null`→NULL。
/// `boolean` 不是可绑定值——SQL 没有布尔类型，0/1 转换是用户的业务决定。
pub struct SqlParam(pub(crate) sqlite::Cell);

impl SqlParam {
    pub(crate) fn into_cell(self) -> sqlite::Cell {
        self.0
    }
}

impl FromNapiValue for SqlParam {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        unsafe {
            let unknown = Unknown::from_napi_value(env, value)?;
            let cell = match unknown.get_type()? {
                ValueType::Null => sqlite::Cell::Null,
                ValueType::Undefined => {
                    return Err(napi::Error::from_reason("sqlite parameter must not be undefined; SQL NULL is explicit"));
                }
                ValueType::Boolean => {
                    return Err(napi::Error::from_reason("sqlite parameter boolean is not bindable; convert to 1 or 0 explicitly"));
                }
                ValueType::Number => sqlite::Cell::Real(f64::from_napi_value(env, value)?),
                ValueType::String => sqlite::Cell::Text(String::from_napi_value(env, value)?),
                ValueType::BigInt => {
                    // `get_i64` 返回 (value, lossless)，第二项为真才表示无损。
                    let (integer, lossless) = BigInt::from_napi_value(env, value)?.get_i64();
                    if !lossless {
                        return Err(napi::Error::from_reason("sqlite INTEGER parameter exceeds signed 64-bit range"));
                    }
                    sqlite::Cell::Integer(integer)
                }
                ValueType::Object => sqlite::Cell::Blob(Buffer::from_napi_value(env, value)?.to_vec()),
                kind => return Err(napi::Error::from_reason(format!("sqlite parameter has unsupported JS type {kind:?}"))),
            };
            Ok(Self(cell))
        }
    }
}

/// 单语句执行的原生结果：`{statement, affected, lastInsertRowid, columns, rows}`，
/// 其中 INTEGER 以 `bigint` 呈现、`affected` 以 `bigint` 呈现且不截断、
/// BLOB 以 `Buffer` 呈现，不经过 JSON 信封。
pub struct TypedRunResult {
    pub(crate) result: sqlite::ExecResult,
    pub(crate) last_insert_rowid: i64,
}

impl ToNapiValue for TypedRunResult {
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        unsafe {
            let object = create_object(env)?;

            let key_statement = js_string(env, b"statement")?;
            let statement = js_string(env, val.result.statement.as_bytes())?;
            set_property(env, object, key_statement, statement)?;

            let key_affected = js_string(env, b"affected")?;
            set_property(env, object, key_affected, create_count(env, val.result.affected as u64)?)?;

            let key_rowid = js_string(env, b"lastInsertRowid")?;
            set_property(env, object, key_rowid, create_integer(env, val.last_insert_rowid)?)?;

            let key_columns = js_string(env, b"columns")?;
            let columns = create_array(env, val.result.columns.len())?;
            for (index, name) in val.result.columns.iter().enumerate() {
                set_element(env, columns, index, js_string(env, name.as_bytes())?)?;
            }
            set_property(env, object, key_columns, columns)?;

            let key_rows = js_string(env, b"rows")?;
            let rows = create_array(env, val.result.rows.len())?;
            for (row_index, row) in val.result.rows.iter().enumerate() {
                let array = create_array(env, row.len())?;
                for (column_index, cell) in row.iter().enumerate() {
                    set_cell(env, array, column_index, cell)?;
                }
                set_element(env, rows, row_index, array)?;
            }
            set_property(env, object, key_rows, rows)?;
            Ok(object)
        }
    }
}

/// 行对象上的两个属性键，每次调用只创建一次。
pub(crate) struct RowKeys {
    pub(crate) rowid: sys::napi_value,
    pub(crate) columns: sys::napi_value,
}

impl RowKeys {
    pub(crate) unsafe fn new(env: sys::napi_env) -> napi::Result<Self> {
        unsafe { Ok(Self { rowid: js_string(env, b"rowid")?, columns: js_string(env, b"columns")? }) }
    }
}
