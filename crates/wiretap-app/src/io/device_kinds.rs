//! One declaration of what each device kind's connection map holds.
//!
//! Before this module the same per-kind table was written out five times in Rust
//! (the broker spawner, `create_reader_session`, `probe_device`,
//! `probe_gvret_device`, and the serde `default =` fns) and four times in
//! TypeScript. They had already drifted: `gvret_tcp`/`modbus_tcp` disagreed on
//! the default host, and `slcan.silent_mode` defaulted to `true` in the form and
//! `false` in the reader — so a profile that never passed through the form was
//! *shown* as listen-only and *run* as active.
//!
//! Two rules keep it that way:
//!
//! - **The readers consume this table at read time**, through the `req_*` and
//!   `conn_*` accessors, rather than restating the values with `.unwrap_or(…)`.
//!   Read time, not write time: a default written into settings.json stops
//!   being a default, and changing one in a later release would then apply only
//!   to profiles created after the change — the drift this module exists to
//!   kill. [`apply_defaults`] is for seeding a *new* profile's map, where the
//!   values are meant to be written.
//! - **The form seeds from this table**, via the `default_connection_for_kind`
//!   command, rather than carrying its own copy. Pre-filling a form is
//!   presentation and stays in TypeScript; the *values* do not. The command is
//!   registered and `applyConnectionDefaults` has yet to call it — until it
//!   does, `src/settings/ioProfileForm.ts` is still a second declaration.
//!
//! Required fields are declared here too, so [`validate_profile`] can reject a
//! device at the write path instead of at connect time.
//!
//! Deliberately outside the table: the Modbus MITM server's `host`/`port`,
//! which are an address to listen on rather than one to dial, and the nested
//! `interfaces[]` entries, whose per-item values come from the `VIRTUAL_*`
//! constants below.

use std::collections::HashMap;

use crate::settings::IOProfile;

/// A default connection value. Kept as a small enum rather than
/// `serde_json::Value` so the table can be a `const`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Val {
    Str(&'static str),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl Val {
    fn to_json(self) -> serde_json::Value {
        match self {
            Val::Str(s) => serde_json::Value::from(s),
            Val::Int(n) => serde_json::Value::from(n),
            Val::Float(f) => serde_json::Value::from(f),
            Val::Bool(b) => serde_json::Value::from(b),
        }
    }
}

/// What a device kind needs in its connection map.
pub struct KindSpec {
    /// Values filled in when absent. A field with a default is never a required
    /// field — the two lists are disjoint.
    pub defaults: &'static [(&'static str, Val)],
    /// Fields with no sensible default, rejected by `validate_profile` when
    /// missing or blank.
    pub required: &'static [&'static str],
}

// The virtual device declares some of its values per-interface inside a nested
// `interfaces[]` array, which the table cannot reach. Naming them here keeps the
// nested parser and the table reading the same constant.
pub const VIRTUAL_FRAME_RATE_HZ: f64 = 10.0;
pub const VIRTUAL_SIGNAL_GENERATOR: bool = true;
pub const VIRTUAL_FRAME_RATE_RANGE: (f64, f64) = (0.1, 1000.0);
pub const VIRTUAL_BUS_COUNT_RANGE: (u8, u8) = (1, 8);

/// Every kind the picker offers, its defaults and its required fields.
static KINDS: &[(&str, KindSpec)] = &[
    (
        "mqtt",
        KindSpec {
            defaults: &[("host", Val::Str("localhost")), ("port", Val::Int(1883))],
            required: &[],
        },
    ),
    (
        "wiretap",
        KindSpec {
            defaults: &[
                ("url", Val::Str("http://localhost:8423")),
                ("database", Val::Str("wiretap")),
            ],
            // `url` is defaulted, not required: the form has always shown
            // `http://localhost:8423`, so the reader's "URL is required" error
            // could only fire on a profile hand-edited to a blank url — where
            // falling back to the default is the better answer.
            required: &[],
        },
    ),
    (
        "gvret_tcp",
        KindSpec {
            defaults: &[
                ("host", Val::Str("192.168.1.100")),
                ("port", Val::Int(23)),
                ("timeout", Val::Float(5.0)),
            ],
            required: &[],
        },
    ),
    (
        "gvret_usb",
        KindSpec {
            defaults: &[("baud_rate", Val::Int(115_200))],
            required: &["port"],
        },
    ),
    (
        "framelink",
        KindSpec {
            defaults: &[("port", Val::Int(120)), ("timeout", Val::Float(5.0))],
            required: &["host"],
        },
    ),
    (
        "slcan",
        KindSpec {
            defaults: &[
                ("baud_rate", Val::Int(115_200)),
                ("data_bits", Val::Int(8)),
                ("stop_bits", Val::Int(1)),
                ("parity", Val::Str("none")),
                ("bitrate", Val::Int(500_000)),
                // Listen-only is the safe default on someone's vehicle bus, it
                // is what the form has always shown, and `transmit.rs` already
                // read it that way — the reader was the one that disagreed.
                ("silent_mode", Val::Bool(true)),
                ("enable_fd", Val::Bool(false)),
                ("data_bitrate", Val::Int(2_000_000)),
            ],
            required: &["port"],
        },
    ),
    (
        "gs_usb",
        KindSpec {
            defaults: &[
                ("bus", Val::Int(0)),
                ("address", Val::Int(0)),
                ("bitrate", Val::Int(500_000)),
                ("sample_point", Val::Float(87.5)),
                ("listen_only", Val::Bool(true)),
                ("channel", Val::Int(0)),
                ("enable_fd", Val::Bool(false)),
                ("data_bitrate", Val::Int(2_000_000)),
                ("data_sample_point", Val::Float(75.0)),
            ],
            required: &[],
        },
    ),
    (
        "socketcan",
        KindSpec {
            // `bitrate` and `data_bitrate` are deliberately absent: leaving the
            // interface as the system configured it is a different instruction
            // from any particular rate, so absent has to stay expressible.
            defaults: &[
                ("interface", Val::Str("can0")),
                ("enable_fd", Val::Bool(false)),
            ],
            required: &[],
        },
    ),
    (
        "modbus_tcp",
        KindSpec {
            defaults: &[
                ("host", Val::Str("192.168.1.100")),
                ("port", Val::Int(502)),
                ("unit_id", Val::Int(1)),
                ("timeout", Val::Float(5.0)),
            ],
            required: &[],
        },
    ),
    (
        "serial",
        KindSpec {
            defaults: &[
                ("baud_rate", Val::Int(115_200)),
                ("data_bits", Val::Int(8)),
                ("stop_bits", Val::Int(1)),
                ("parity", Val::Str("none")),
                ("framing_encoding", Val::Str("raw")),
            ],
            required: &["port"],
        },
    ),
    (
        "virtual",
        KindSpec {
            defaults: &[
                ("traffic_type", Val::Str("can")),
                ("loopback", Val::Bool(true)),
                ("signal_generator", Val::Bool(VIRTUAL_SIGNAL_GENERATOR)),
                ("frame_rate_hz", Val::Float(VIRTUAL_FRAME_RATE_HZ)),
                ("bus_count", Val::Int(1)),
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

/// Every kind the table declares, in table order. The one enumeration of the
/// kind list — anything else needing to iterate kinds reads it from here rather
/// than restating the names.
pub fn kinds() -> impl Iterator<Item = &'static str> {
    KINDS.iter().map(|(k, _)| *k)
}

/// The spec for a kind, or `None` for one that declares nothing (captures,
/// recorded sources, the Modbus scan pseudo-source).
pub fn spec(kind: &str) -> Option<&'static KindSpec> {
    let kind = canonical_kind(kind);
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, s)| s)
}

/// A kind's declared default for one field.
pub fn default_value(kind: &str, key: &str) -> Option<Val> {
    spec(kind)?
        .defaults
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
}

/// A kind's whole default connection map, as the form seeds from it.
pub fn default_connection(kind: &str) -> HashMap<String, serde_json::Value> {
    spec(kind)
        .map(|s| {
            s.defaults
                .iter()
                .map(|(k, v)| ((*k).to_string(), v.to_json()))
                .collect()
        })
        .unwrap_or_default()
}

/// Fill in the values a kind needs to connect at all, leaving anything the
/// caller supplied alone. Idempotent, and safe on an unknown kind.
///
/// For **seeding a new profile**, not for reading one: the accessors already
/// fall back to the table, so a reader needs no materialisation, and a
/// materialised map that reaches `save_settings` freezes today's defaults into
/// the file.
pub fn apply_defaults(profile: &mut IOProfile) {
    let Some(spec) = spec(&profile.kind) else {
        return;
    };
    for (key, val) in spec.defaults {
        if !profile.connection.contains_key(*key) {
            profile.connection.insert((*key).to_string(), val.to_json());
        }
    }
}

// ── Connection accessors ─────────────────────────────────────────────────────
//
// The settings file allows both the string and the number spelling of a numeric
// field (the form writes strings, a hand-edit or an MCP caller may write
// numbers), so every read tolerates both. Each falls back to the kind's declared
// default, so a profile hand-edited into settings.json reads the same values a
// form-built one does — which is what makes the table the single declaration
// rather than a second one.
//
// `req_*` is what a driver should call: same resolution, but "not there" becomes
// a named error instead of each call site spelling one out. `conn_*` stays for
// the fields the table deliberately leaves undeclared, where absent is itself a
// meaningful answer (`gs_usb.serial`, `socketcan.bitrate`/`data_bitrate`).

/// Read `key` off the profile with `read`, falling back to the kind's declared
/// default read the same way. A profile value of the wrong shape falls through
/// to the default rather than failing.
fn conn<T>(
    profile: &IOProfile,
    key: &str,
    read: impl Fn(&serde_json::Value) -> Option<T>,
) -> Option<T> {
    profile
        .connection
        .get(key)
        .and_then(&read)
        .or_else(|| default_value(&profile.kind, key).and_then(|v| read(&v.to_json())))
}

/// Read a string field. A blank string is not a value — the form writes `""`
/// for an input the user cleared, and that must not shadow the default.
pub fn conn_str(profile: &IOProfile, key: &str) -> Option<String> {
    conn(profile, key, |v| {
        v.as_str().map(str::to_string).filter(|s| !s.is_empty())
    })
}

/// Read an integer field, tolerating the string spelling.
pub fn conn_i64(profile: &IOProfile, key: &str) -> Option<i64> {
    conn(profile, key, |v| {
        v.as_i64().or_else(|| v.as_str()?.trim().parse().ok())
    })
}

/// Read a float field, tolerating the string spelling.
pub fn conn_f64(profile: &IOProfile, key: &str) -> Option<f64> {
    conn(profile, key, |v| {
        v.as_f64().or_else(|| v.as_str()?.trim().parse().ok())
    })
}

/// Read a boolean field, tolerating the string spellings the settings file has
/// carried (`"true"`/`"false"`, `"1"`/`"0"`). Anything else falls through to the
/// default rather than being guessed at — the older `s != "false"` reading in
/// the drivers scored an empty string as `true`.
pub fn conn_bool(profile: &IOProfile, key: &str) -> Option<bool> {
    conn(profile, key, |v| {
        v.as_bool().or_else(|| match v.as_str()?.trim() {
            s if s.eq_ignore_ascii_case("true") || s == "1" => Some(true),
            s if s.eq_ignore_ascii_case("false") || s == "0" => Some(false),
            _ => None,
        })
    })
}

/// Read a byte-list field — a JSON array of integers, or the hex string the
/// picker sends (`"20 60 65"`, `"0x20,0x60"`). An entry that is not a byte drops
/// out rather than folding to zero, which would be a real function code.
pub fn conn_u8_list(profile: &IOProfile, key: &str) -> Option<Vec<u8>> {
    conn(profile, key, |v| {
        if let Some(arr) = v.as_array() {
            return Some(arr.iter().filter_map(|n| u8::try_from(n.as_i64()?).ok()).collect());
        }
        Some(crate::hex::parse_bytes_lenient(v.as_str()?))
    })
}

/// What a serial source will actually run with: the framing name, and whether
/// raw bytes go on the wire alongside any frames.
///
/// A session override wins, then the profile's saved setting, then the kind
/// default. Raw framing *is* the byte stream, so it always emits bytes; every
/// other framing does so only when asked.
///
/// **This has to be resolved once, before the session exists.** The reader
/// resolves the same pair for itself in `serial::utils::parse_profile_for_source`,
/// but that runs on a background task long after `IOBroker` has decided which
/// captures to create and what to put in `IOCapabilities`. When the two
/// disagreed, a framed serial profile opened as a single source got a bytes
/// capture nothing ever wrote to, no frames capture at all, and every framed row
/// dropped on the floor.
pub fn resolve_serial_framing(
    profile: &IOProfile,
    framing_override: Option<&str>,
    emit_raw_bytes_override: Option<bool>,
) -> (String, bool) {
    // `conn_str` falls through to the kind's declared default, so for a serial
    // profile — the only kind that reaches here in practice — the last arm is
    // unreachable and the table's `("framing_encoding", "raw")` decides.
    let framing = framing_override
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| conn_str(profile, "framing_encoding"))
        .unwrap_or_else(|| "raw".to_string());
    let emit_raw_bytes = framing == "raw" || emit_raw_bytes_override.unwrap_or(false);
    (framing, emit_raw_bytes)
}

/// The error a reader reports for a field it could not resolve. For a field the
/// table declares this is unreachable — pinned by `every_default_reads_back` —
/// so the message is phrased for the case that does happen: a *required* field
/// the user has not filled in.
fn missing(profile: &IOProfile, key: &str) -> String {
    format!("{} profile is missing '{}'", profile.kind, key)
}

/// Read a string field the profile is expected to carry.
pub fn req_str(profile: &IOProfile, key: &str) -> Result<String, String> {
    conn_str(profile, key).ok_or_else(|| missing(profile, key))
}

/// Read an integer field the profile is expected to carry.
pub fn req_i64(profile: &IOProfile, key: &str) -> Result<i64, String> {
    conn_i64(profile, key).ok_or_else(|| missing(profile, key))
}

/// Read a float field the profile is expected to carry.
pub fn req_f64(profile: &IOProfile, key: &str) -> Result<f64, String> {
    conn_f64(profile, key).ok_or_else(|| missing(profile, key))
}

/// Read a boolean field the profile is expected to carry.
pub fn req_bool(profile: &IOProfile, key: &str) -> Result<bool, String> {
    conn_bool(profile, key).ok_or_else(|| missing(profile, key))
}

// ── Validation ───────────────────────────────────────────────────────────────

/// Why a profile was rejected. An enum rather than a string so adding a rule is
/// a compile error at every match, and so the frontend's translation map has a
/// closed set to cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ValidationCode {
    NameRequired,
    NameDuplicate,
    PortRequired,
    HostRequired,
    FieldRequired,
}

/// A rejection: what was wrong, and which input to focus.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProfileValidationError {
    pub code: ValidationCode,
    pub field: Option<String>,
}

impl ProfileValidationError {
    fn new(code: ValidationCode, field: Option<&str>) -> Self {
        Self {
            code,
            field: field.map(str::to_string),
        }
    }
}

/// The code for a missing required field.
fn required_code(field: &str) -> ValidationCode {
    match field {
        "port" => ValidationCode::PortRequired,
        "host" => ValidationCode::HostRequired,
        _ => ValidationCode::FieldRequired,
    }
}

/// Check a device before it is written.
///
/// `existing` is every device already known — settings plus the ad-hoc overlay,
/// which is why this lives in Rust: the frontend can only see one of the two
/// halves at a time. A profile being *edited* is excluded by id, so keeping its
/// own name is not a duplicate.
pub fn validate_profile(
    profile: &IOProfile,
    existing: &[IOProfile],
) -> Result<(), ProfileValidationError> {
    if profile.name.trim().is_empty() {
        return Err(ProfileValidationError::new(
            ValidationCode::NameRequired,
            Some("name"),
        ));
    }
    if existing
        .iter()
        .any(|p| p.id != profile.id && p.name == profile.name)
    {
        return Err(ProfileValidationError::new(
            ValidationCode::NameDuplicate,
            Some("name"),
        ));
    }
    if let Some(spec) = spec(&profile.kind) {
        for field in spec.required {
            let present = profile
                .connection
                .get(*field)
                .map(|v| match v {
                    serde_json::Value::String(s) => !s.trim().is_empty(),
                    serde_json::Value::Null => false,
                    _ => true,
                })
                .unwrap_or(false);
            if !present {
                return Err(ProfileValidationError::new(
                    required_code(field),
                    Some(field),
                ));
            }
        }
    }
    Ok(())
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// The default connection map for a kind, for the form to seed from.
#[tauri::command(rename_all = "snake_case")]
pub fn default_connection_for_kind(kind: String) -> HashMap<String, serde_json::Value> {
    default_connection(&kind)
}

/// Check a device against the same rules the write path enforces.
#[tauri::command(rename_all = "snake_case")]
pub async fn validate_io_profile(
    app: tauri::AppHandle,
    profile: IOProfile,
) -> Result<Option<ProfileValidationError>, String> {
    // No `apply_defaults` here: `defaults_and_required_are_disjoint` pins that a
    // required field never has one, so it could only mutate a profile the caller
    // is about to save.
    let settings = crate::settings::load_settings(app).await?;
    Ok(validate_profile(&profile, &settings.io_profiles).err())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(kind: &str) -> IOProfile {
        IOProfile {
            id: "io_test".to_string(),
            name: "Test".to_string(),
            kind: kind.to_string(),
            connection: HashMap::new(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

    /// A kind whose reader takes a default must declare it here, or the reader
    /// reports it missing at connect time. Aliases included — the settings file
    /// has carried both spellings of the two GVRET kinds.
    #[test]
    fn every_kind_a_reader_handles_has_a_spec() {
        for kind in [
            "gvret_tcp",
            "gvret-tcp",
            "gvret_usb",
            "gvret-usb",
            "slcan",
            "gs_usb",
            "socketcan",
            "serial",
            "modbus_tcp",
            "virtual",
            "framelink",
            "mqtt",
            "wiretap",
        ] {
            assert!(spec(kind).is_some(), "no device_kinds entry for '{kind}'");
        }
    }

    /// Every declared default must come back out through the accessor of its own
    /// type — the invariant `missing()` is documented against.
    #[test]
    fn every_default_reads_back() {
        for (kind, spec) in KINDS.iter() {
            let p = profile(kind);
            for (key, val) in spec.defaults {
                let found = match val {
                    Val::Str(_) => conn_str(&p, key).is_some(),
                    Val::Int(_) => conn_i64(&p, key).is_some(),
                    Val::Float(_) => conn_f64(&p, key).is_some(),
                    Val::Bool(_) => conn_bool(&p, key).is_some(),
                };
                assert!(
                    found,
                    "{kind}.{key} does not read back through its accessor"
                );
            }
        }
    }

    /// A field cannot be both defaulted and required — the default would satisfy
    /// the check and the requirement would never fire.
    #[test]
    fn defaults_and_required_are_disjoint() {
        for (kind, spec) in KINDS.iter() {
            for field in spec.required {
                assert!(
                    !spec.defaults.iter().any(|(k, _)| k == field),
                    "{kind}.{field} is both defaulted and required"
                );
            }
        }
    }

    #[test]
    fn apply_defaults_is_idempotent_and_never_overwrites() {
        let mut p = profile("slcan");
        p.connection
            .insert("bitrate".to_string(), serde_json::Value::from("250000"));
        apply_defaults(&mut p);
        let once = p.connection.clone();
        apply_defaults(&mut p);
        assert_eq!(once, p.connection);
        assert_eq!(p.connection["bitrate"], serde_json::Value::from("250000"));
        assert_eq!(p.connection["baud_rate"], serde_json::Value::from(115_200));
    }

    /// The values that had drifted between the two languages, pinned by name so
    /// a future edit has to be deliberate.
    #[test]
    fn resolved_drifts_are_pinned() {
        for (kind, key, want) in [
            ("gvret_tcp", "host", Val::Str("192.168.1.100")),
            ("modbus_tcp", "host", Val::Str("192.168.1.100")),
            ("slcan", "silent_mode", Val::Bool(true)),
        ] {
            assert_eq!(default_value(kind, key), Some(want), "{kind}.{key}");
        }
    }

    #[test]
    fn accessors_tolerate_both_spellings() {
        let mut p = profile("modbus_tcp");
        p.connection
            .insert("port".to_string(), serde_json::Value::from("8502"));
        assert_eq!(conn_i64(&p, "port"), Some(8502));
        p.connection
            .insert("port".to_string(), serde_json::Value::from(8502));
        assert_eq!(conn_i64(&p, "port"), Some(8502));
    }

    #[test]
    fn accessors_fall_back_to_the_table() {
        let p = profile("modbus_tcp");
        assert_eq!(req_str(&p, "host").unwrap(), "192.168.1.100");
        assert_eq!(req_i64(&p, "port").unwrap(), 502);
        assert_eq!(req_i64(&p, "unit_id").unwrap(), 1);
    }

    /// A field the table does not declare stays absent — `socketcan.bitrate`
    /// means "leave the interface as the system configured it".
    #[test]
    fn an_undeclared_field_reports_missing() {
        let p = profile("socketcan");
        assert_eq!(conn_i64(&p, "bitrate"), None);
        assert!(req_i64(&p, "bitrate").unwrap_err().contains("bitrate"));
    }

    #[test]
    fn a_boolean_reads_from_either_spelling() {
        let mut p = profile("slcan");
        for (written, want) in [("false", false), ("true", true), ("0", false), ("1", true)] {
            p.connection
                .insert("silent_mode".to_string(), serde_json::Value::from(written));
            assert_eq!(conn_bool(&p, "silent_mode"), Some(want), "{written}");
        }
        p.connection
            .insert("silent_mode".to_string(), serde_json::Value::from(false));
        assert_eq!(conn_bool(&p, "silent_mode"), Some(false));
    }

    /// A blank string is not a value — the form writes `""` for a field the user
    /// cleared, and that must not shadow the default.
    #[test]
    fn a_blank_string_falls_through_to_the_default() {
        let mut p = profile("mqtt");
        p.connection
            .insert("host".to_string(), serde_json::Value::from(""));
        assert_eq!(conn_str(&p, "host").as_deref(), Some("localhost"));
    }

    #[test]
    fn validate_rejects_a_blank_name() {
        let mut p = profile("virtual");
        p.name = "  ".to_string();
        let err = validate_profile(&p, &[]).unwrap_err();
        assert_eq!(err.code, ValidationCode::NameRequired);
    }

    #[test]
    fn validate_rejects_a_duplicate_name() {
        let p = profile("virtual");
        let mut other = profile("virtual");
        other.id = "adhoc_1".to_string();
        let err = validate_profile(&p, &[other]).unwrap_err();
        assert_eq!(err.code, ValidationCode::NameDuplicate);
    }

    /// Editing a device keeps its own name — the exclusion is by id.
    #[test]
    fn validate_allows_a_profile_to_keep_its_own_name() {
        let p = profile("virtual");
        assert!(validate_profile(&p, &[p.clone()]).is_ok());
    }

    #[test]
    fn validate_reports_the_missing_required_field() {
        let err = validate_profile(&profile("slcan"), &[]).unwrap_err();
        assert_eq!(err.code, ValidationCode::PortRequired);
        assert_eq!(err.field.as_deref(), Some("port"));

        let err = validate_profile(&profile("framelink"), &[]).unwrap_err();
        assert_eq!(err.code, ValidationCode::HostRequired);
        assert_eq!(err.field.as_deref(), Some("host"));
    }

    /// `modbus_tcp` used to declare `hostRequired` in the TypeScript validator
    /// while also defaulting the host — so the check never fired. Now the host
    /// is simply defaulted, and this pins that it validates.
    #[test]
    fn validate_passes_modbus_on_its_default_host() {
        let mut p = profile("modbus_tcp");
        apply_defaults(&mut p);
        assert!(validate_profile(&p, &[]).is_ok());
    }

    fn serial_profile(framing: &str) -> IOProfile {
        let mut p = profile("serial");
        p.connection.insert(
            "framing_encoding".to_string(),
            serde_json::Value::String(framing.to_string()),
        );
        p
    }

    /// The broker decides which captures a session gets from these two answers,
    /// before any reader runs. A framed serial profile that resolved to "raw"
    /// here got a bytes capture nothing wrote to and no frames capture at all.
    #[test]
    fn a_framed_serial_profile_does_not_resolve_to_raw_bytes() {
        assert_eq!(
            resolve_serial_framing(&serial_profile("slip"), None, None),
            ("slip".to_string(), false)
        );
        assert_eq!(
            resolve_serial_framing(&serial_profile("raw"), None, None),
            ("raw".to_string(), true)
        );
    }

    /// An unset framing falls to the kind default, which is raw — so a profile
    /// predating the field still streams bytes rather than nothing.
    #[test]
    fn an_unset_framing_falls_back_to_the_kind_default() {
        assert_eq!(
            resolve_serial_framing(&profile("serial"), None, None),
            ("raw".to_string(), true)
        );
    }

    /// The picker's dropdown and its "Capture raw bytes" tick, which the single-
    /// source path used to drop on the floor.
    #[test]
    fn a_session_override_wins_over_the_profile() {
        assert_eq!(
            resolve_serial_framing(&serial_profile("raw"), Some("modbus_rtu"), None),
            ("modbus_rtu".to_string(), false)
        );
        assert_eq!(
            resolve_serial_framing(&serial_profile("slip"), None, Some(true)),
            ("slip".to_string(), true)
        );
    }

    /// A cleared form field writes `""`, which must not read as a framing name.
    #[test]
    fn a_blank_override_is_not_a_framing() {
        assert_eq!(
            resolve_serial_framing(&serial_profile("slip"), Some(""), None),
            ("slip".to_string(), false)
        );
    }
}
