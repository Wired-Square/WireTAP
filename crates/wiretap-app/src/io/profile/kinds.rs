//! What each device kind's connection map holds: the one declaration its
//! readers, its form and its validation read, so none restates a default.
//!
//! Readers resolve a default at read time, through [`IOProfile`]'s `conn_*` and
//! `req_*` accessors, so changing one reaches profiles already saved.
//! [`apply_defaults`] is the exception: the write path stores a profile with its
//! defaults, because the frontend reads the map directly.
//!
//! Outside the table: the Modbus MITM server's listen `host`/`port`, and the
//! nested `interfaces[]` entries, whose per-item values are the `VIRTUAL_*`
//! constants.

use std::collections::HashMap;

use serde::Serialize;
use wslib_wiretap_catalogue::serial_framing::degenerate_framing_field;
use wslib_wiretap_catalogue::FramingMode;

use super::{ConnValue, IOProfile};
use DefaultValue::{Bool, Float, Int, Str};

/// A default connection value, as a `const` can hold one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DefaultValue {
    Str(&'static str),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl From<DefaultValue> for ConnValue {
    fn from(value: DefaultValue) -> Self {
        match value {
            DefaultValue::Str(s) => s.into(),
            DefaultValue::Int(n) => n.into(),
            DefaultValue::Float(f) => f.into(),
            DefaultValue::Bool(b) => b.into(),
        }
    }
}

/// What a device kind needs in its connection map.
#[derive(Debug)]
pub struct KindSpec {
    /// Filled in when absent; never also required.
    pub defaults: &'static [(&'static str, DefaultValue)],
    /// No sensible default: [`validate_profile`] rejects one missing or blank.
    pub required: &'static [&'static str],
}

pub const VIRTUAL_FRAME_RATE_HZ: f64 = 10.0;
pub const VIRTUAL_SIGNAL_GENERATOR: bool = true;

/// In the order the kind pickers list them.
static KINDS: &[(&str, KindSpec)] = &[
    (
        "framelink",
        KindSpec {
            defaults: &[("port", Int(120)), ("timeout", Float(5.0))],
            required: &["host"],
        },
    ),
    (
        "gs_usb",
        KindSpec {
            defaults: &[
                ("bus", Int(0)),
                ("address", Int(0)),
                ("bitrate", Int(500_000)),
                ("sample_point", Float(87.5)),
                ("listen_only", Bool(true)),
                ("channel", Int(0)),
                ("enable_fd", Bool(false)),
                ("data_bitrate", Int(2_000_000)),
                ("data_sample_point", Float(75.0)),
            ],
            required: &[],
        },
    ),
    (
        "gvret_tcp",
        KindSpec {
            defaults: &[
                ("host", Str("192.168.1.100")),
                ("port", Int(23)),
                ("timeout", Float(5.0)),
            ],
            required: &[],
        },
    ),
    (
        "gvret_usb",
        KindSpec {
            defaults: &[("baud_rate", Int(115_200))],
            required: &["port"],
        },
    ),
    (
        "modbus_tcp",
        KindSpec {
            defaults: &[
                ("host", Str("192.168.1.100")),
                ("port", Int(502)),
                ("unit_id", Int(1)),
                ("timeout", Float(5.0)),
            ],
            required: &[],
        },
    ),
    (
        "mqtt",
        KindSpec {
            defaults: &[("host", Str("localhost")), ("port", Int(1883))],
            required: &[],
        },
    ),
    (
        "wiretap",
        KindSpec {
            // Defaulted, not required: a blank url falls back to the one the
            // form has always shown.
            defaults: &[
                ("url", Str("http://localhost:8423")),
                ("database", Str("wiretap")),
            ],
            required: &[],
        },
    ),
    (
        "serial",
        KindSpec {
            defaults: &[
                ("baud_rate", Int(115_200)),
                ("data_bits", Int(8)),
                ("stop_bits", Int(1)),
                ("parity", Str("none")),
                ("framing_encoding", Str("raw")),
            ],
            required: &["port"],
        },
    ),
    (
        "slcan",
        KindSpec {
            defaults: &[
                ("baud_rate", Int(115_200)),
                ("data_bits", Int(8)),
                ("stop_bits", Int(1)),
                ("parity", Str("none")),
                ("bitrate", Int(500_000)),
                // Listen-only is the safe default on someone's vehicle bus.
                ("silent_mode", Bool(true)),
                ("enable_fd", Bool(false)),
                ("data_bitrate", Int(2_000_000)),
            ],
            required: &["port"],
        },
    ),
    (
        "socketcan",
        KindSpec {
            // No `bitrate` or `data_bitrate`: absent leaves the interface as the
            // system configured it.
            defaults: &[("interface", Str("can0")), ("enable_fd", Bool(false))],
            required: &[],
        },
    ),
    (
        "virtual",
        KindSpec {
            defaults: &[
                ("traffic_type", Str("can")),
                ("loopback", Bool(true)),
                ("signal_generator", Bool(VIRTUAL_SIGNAL_GENERATOR)),
                ("frame_rate_hz", Float(VIRTUAL_FRAME_RATE_HZ)),
                ("bus_count", Int(1)),
            ],
            required: &[],
        },
    ),
];

/// Aliases the settings file has carried at one time or another.
pub fn canonical_kind(kind: &str) -> &str {
    match kind {
        "gvret-tcp" => "gvret_tcp",
        "gvret-usb" => "gvret_usb",
        other => other,
    }
}

/// Every kind the table declares, in table order.
pub fn kinds() -> impl Iterator<Item = &'static str> {
    KINDS.iter().map(|(k, _)| *k)
}

/// `None` for a kind that declares nothing (captures, recorded sources, the
/// Modbus scan pseudo-source).
pub fn spec(kind: &str) -> Option<&'static KindSpec> {
    let kind = canonical_kind(kind);
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, s)| s)
}

pub fn default_value(kind: &str, key: &str) -> Option<DefaultValue> {
    spec(kind)?
        .defaults
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
}

/// A kind's whole default connection map, as the form seeds from it.
pub fn default_connection(kind: &str) -> HashMap<String, ConnValue> {
    spec(kind)
        .map(|s| {
            s.defaults
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).into()))
                .collect()
        })
        .unwrap_or_default()
}

/// Fill each field left absent, null or blank with the kind's default, numbers
/// spelled as strings the way the form writes them. Idempotent, and safe on an
/// unknown kind.
pub fn apply_defaults(profile: &mut IOProfile) {
    let Some(spec) = spec(&profile.kind) else {
        return;
    };
    for (key, val) in spec.defaults {
        let blank = match profile.connection.get(*key) {
            None | Some(ConnValue::Null) => true,
            Some(ConnValue::Str(s)) => s.is_empty(),
            Some(_) => false,
        };
        if blank {
            let form_value = match val {
                Int(n) => n.to_string().into(),
                Float(f) => f.to_string().into(),
                _ => (*val).into(),
            };
            profile.connection.insert((*key).to_string(), form_value);
        }
    }
}

/// What a serial source will run with: the framing, and whether raw bytes go
/// on the wire beside any frames. A session override wins, then the profile,
/// then the kind default; raw framing always emits bytes.
///
/// Resolved once, before the session exists: the captures a session gets are
/// decided from this, and a reader that resolved it differently wrote to none.
pub fn resolve_serial_framing(
    profile: &IOProfile,
    framing_override: Option<FramingMode>,
    emit_raw_bytes_override: Option<bool>,
) -> (FramingMode, bool) {
    let framing = framing_override.unwrap_or_else(|| profile.conn_framing());
    let emit_raw_bytes = framing == FramingMode::Raw || emit_raw_bytes_override.unwrap_or(false);
    (framing, emit_raw_bytes)
}

/// Why a profile was rejected. An enum rather than a string so adding a rule is
/// a compile error at every match, and so the frontend's translation map has a
/// closed set to cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ValidationCode {
    NameRequired,
    NameDuplicate,
    PortRequired,
    HostRequired,
    FieldRequired,
    FieldInvalid,
}

/// A rejection: what was wrong, and which input to focus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProfileValidationError {
    pub code: ValidationCode,
    pub field: Option<String>,
}

fn rejected(code: ValidationCode, field: &str) -> Result<(), ProfileValidationError> {
    Err(ProfileValidationError {
        code,
        field: Some(field.to_string()),
    })
}

fn required_code(field: &str) -> ValidationCode {
    match field {
        "port" => ValidationCode::PortRequired,
        "host" => ValidationCode::HostRequired,
        _ => ValidationCode::FieldRequired,
    }
}

/// Check a device before it is written. `existing` is every device already
/// known; the profile itself is excluded by id, so keeping its own name is not
/// a duplicate.
pub fn validate_profile(
    profile: &IOProfile,
    existing: &[IOProfile],
) -> Result<(), ProfileValidationError> {
    if profile.name.trim().is_empty() {
        return rejected(ValidationCode::NameRequired, "name");
    }
    if existing
        .iter()
        .any(|p| p.id != profile.id && p.name == profile.name)
    {
        return rejected(ValidationCode::NameDuplicate, "name");
    }
    for field in spec(&profile.kind).map_or(&[][..], |s| s.required) {
        let present = match profile.connection.get(*field) {
            None | Some(ConnValue::Null) => false,
            Some(ConnValue::Str(s)) => !s.trim().is_empty(),
            Some(_) => true,
        };
        if !present {
            return rejected(required_code(field), field);
        }
    }
    if canonical_kind(&profile.kind) == "serial" {
        let delimiter = profile.conn_u8_list("delimiter");
        let max_frame_length = profile.conn_i64("max_frame_length");
        if let Some(field) = degenerate_framing_field(delimiter.as_deref(), max_frame_length) {
            return rejected(ValidationCode::FieldInvalid, field);
        }
    }
    Ok(())
}
