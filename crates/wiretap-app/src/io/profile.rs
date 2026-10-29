//! A device profile as the desktop's settings file stores it, the per-kind
//! table its connection map is read against, and a serial source's settings
//! resolved from one. Pure: no I/O, so it builds on every target.

mod kinds;
mod serial;
mod value;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wslib_wiretap_catalogue::FramingMode;

pub use kinds::{
    apply_defaults, canonical_kind, default_connection, default_value, kinds,
    resolve_serial_framing, spec, validate_profile, DefaultValue, KindSpec, ProfileValidationError,
    ValidationCode, VIRTUAL_FRAME_RATE_HZ, VIRTUAL_SIGNAL_GENERATOR,
};
pub use serial::{SerialOverrides, SerialSourceConfig, SerialSourceError};
pub use value::ConnValue;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct IOProfile {
    pub id: String,
    pub name: String,
    /// One of [`kinds`], or a kind the table doesn't declare.
    pub kind: String,
    pub connection: HashMap<String, ConnValue>,
    #[serde(default)]
    pub preferred_catalog: Option<String>,
    /// Created ad hoc for this run and never saved. Skipped when false, so a
    /// saved profile round-trips unchanged.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ephemeral: bool,
}

/// A required field the profile doesn't carry.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{kind} profile is missing '{key}'")]
pub struct MissingField {
    pub kind: String,
    pub key: String,
}

impl From<MissingField> for String {
    fn from(e: MissingField) -> Self {
        e.to_string()
    }
}

/// Each `conn_*` read takes a numeric field in either spelling, the form's
/// string or a number, and falls back to the kind's default, as does a value
/// of the wrong shape. `req_*` makes absent a [`MissingField`].
impl IOProfile {
    fn conn<T>(&self, key: &str, read: impl Fn(&ConnValue) -> Option<T>) -> Option<T> {
        self.connection
            .get(key)
            .and_then(&read)
            .or_else(|| default_value(&self.kind, key).and_then(|v| read(&ConnValue::from(v))))
    }

    /// A blank string is not a value: the form writes `""` for a cleared input.
    pub fn conn_str(&self, key: &str) -> Option<String> {
        self.conn(key, |v| {
            v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
        })
    }

    pub fn conn_i64(&self, key: &str) -> Option<i64> {
        self.conn(key, |v| {
            v.as_i64().or_else(|| v.as_str()?.trim().parse().ok())
        })
    }

    pub fn conn_f64(&self, key: &str) -> Option<f64> {
        self.conn(key, |v| {
            v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())
        })
    }

    /// Also `"true"`/`"false"` and `"1"`/`"0"`; any other string reads as absent.
    pub fn conn_bool(&self, key: &str) -> Option<bool> {
        self.conn(key, |v| {
            v.as_bool().or_else(|| match v.as_str()?.trim() {
                s if s.eq_ignore_ascii_case("true") || s == "1" => Some(true),
                s if s.eq_ignore_ascii_case("false") || s == "0" => Some(false),
                _ => None,
            })
        })
    }

    /// A list of integers, or the hex string the picker sends (`"20 60 65"`,
    /// `"0x20,0x60"`). An entry that is not a byte drops out rather than folding
    /// to zero, which would be a real function code.
    pub fn conn_u8_list(&self, key: &str) -> Option<Vec<u8>> {
        self.conn(key, |v| match v.as_list() {
            Some(items) => Some(
                items
                    .iter()
                    .filter_map(|n| u8::try_from(n.as_i64()?).ok())
                    .collect(),
            ),
            None => Some(wslib_bits::hex::parse_bytes_lenient(v.as_str()?)),
        })
    }

    /// The saved `framing_encoding`, in the session's spellings; a name that is
    /// not a framing reads as the kind default.
    pub fn conn_framing(&self) -> FramingMode {
        self.conn("framing_encoding", |v| v.as_str()?.parse().ok())
            .unwrap_or_default()
    }

    fn missing(&self, key: &str) -> MissingField {
        MissingField {
            kind: self.kind.clone(),
            key: key.to_string(),
        }
    }

    pub fn req_str(&self, key: &str) -> Result<String, MissingField> {
        self.conn_str(key).ok_or_else(|| self.missing(key))
    }

    pub fn req_i64(&self, key: &str) -> Result<i64, MissingField> {
        self.conn_i64(key).ok_or_else(|| self.missing(key))
    }

    pub fn req_f64(&self, key: &str) -> Result<f64, MissingField> {
        self.conn_f64(key).ok_or_else(|| self.missing(key))
    }

    pub fn req_bool(&self, key: &str) -> Result<bool, MissingField> {
        self.conn_bool(key).ok_or_else(|| self.missing(key))
    }
}
