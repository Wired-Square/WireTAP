use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wslib_wiretap_catalogue::serial_framing::DelimiterOptions;
use wslib_wiretap_catalogue::{FrameIdConfig, FramingEncoding, FramingMode, RtuSettings};
use super::*;

fn profile(kind: &str) -> IOProfile {
    IOProfile {
        id: "io_test".to_string(),
        name: "Test".to_string(),
        kind: kind.to_string(),
        ..IOProfile::default()
    }
}

fn set(p: &mut IOProfile, key: &str, value: impl Into<ConnValue>) {
    p.connection.insert(key.to_string(), value.into());
}

/// Alex-shaped settings: framelink and gvret_tcp `interfaces` of objects,
/// byte lists, floats, booleans, null, nested keys no reader knows, an
/// integer past `i64::MAX`.
const SETTINGS: &str = r#"[
  {"id":"io_fl","name":"FrameLink","kind":"framelink","connection":{"host":"10.0.0.5","port":"120","device_id":"FL1","timeout":5.0,"interfaces":[{"iface_type":1,"index":1,"name":"CAN1","type_name":"CAN"},{"iface_type":3,"index":2,"name":"CAN2","type_name":"CAN FD"}]},"preferred_catalog":"sbr.toml"},
  {"id":"io_gv","name":"M2","kind":"gvret_tcp","connection":{"host":"192.168.1.20","port":23,"interfaces":[{"device_bus":0,"enabled":true,"protocol":"can"},{"device_bus":1,"enabled":false,"protocol":"canfd"}],"_probed_bus_count":2},"preferred_catalog":null},
  {"id":"io_se","name":"RS485","kind":"serial","connection":{"port":"/dev/ttyUSB0","baud_rate":"9600","framing_encoding":"delimiter","delimiter":[13,10],"modbus_vendor_functions":[],"frame_id_start_byte":-2,"include_delimiter":null,"_meta":{"z":{"deep":[1,-2,3.5e-7,"x",null,{}]},"a":true},"huge":18446744073709551615,"neg_zero":-0.0,"big":1e300}},
  {"id":"io_vi","name":"Virtual","kind":"virtual","connection":{"frame_rate_hz":10.5,"loopback":false,"interfaces":[{"bus":"0"},{"bus":1}]},"ephemeral":true}
]"#;

#[test]
fn settings_round_trip_as_serde_json_writes_them() {
    let profiles: Vec<IOProfile> = serde_json::from_str(SETTINGS).unwrap();
    let original: Value = serde_json::from_str(SETTINGS).unwrap();
    // `preferred_catalog` absent and null both save as null, as the desktop's do.
    let mut expected = original.clone();
    for p in expected.as_array_mut().unwrap() {
        let p = p.as_object_mut().unwrap();
        p.entry("preferred_catalog").or_insert(Value::Null);
    }
    assert_eq!(serde_json::to_value(&profiles).unwrap(), expected);

    for (profile, json) in profiles.iter().zip(original.as_array().unwrap()) {
        for (key, value) in &profile.connection {
            assert_eq!(
                serde_json::to_string(value).unwrap(),
                serde_json::to_string(&json["connection"][key]).unwrap(),
                "{}.{key}",
                profile.id
            );
        }
    }
}

/// The desktop's `IOProfile`, `serde_json::Value` and all, as it is today.
#[derive(Serialize, Deserialize)]
struct DesktopProfile {
    id: String,
    name: String,
    kind: String,
    connection: HashMap<String, Value>,
    #[serde(default)]
    preferred_catalog: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    ephemeral: bool,
}

/// A one-key connection has no `HashMap` order to differ by, so the whole
/// profile is byte for byte what the desktop's own type writes.
#[test]
fn a_profile_saves_byte_for_byte_as_the_desktops() {
    let original: Vec<Value> = serde_json::from_str(SETTINGS).unwrap();
    for json in original {
        for (key, value) in json["connection"].as_object().unwrap() {
            let mut one = json.clone();
            one["connection"] = json!({ key: value });
            let text = serde_json::to_string_pretty(&one).unwrap();
            let ours: IOProfile = serde_json::from_str(&text).unwrap();
            let theirs: DesktopProfile = serde_json::from_str(&text).unwrap();
            assert_eq!(
                serde_json::to_string_pretty(&ours).unwrap(),
                serde_json::to_string_pretty(&theirs).unwrap(),
                "{key}"
            );
        }
    }
}

#[test]
fn a_value_reads_as_the_variant_serde_json_would_keep() {
    let read = |text: &str| serde_json::from_str::<ConnValue>(text).unwrap();
    assert_eq!(read("5"), ConnValue::Int(5));
    assert_eq!(read("-5"), ConnValue::Int(-5));
    assert_eq!(read("5.0"), ConnValue::Float(5.0));
    assert_eq!(read("9223372036854775807"), ConnValue::Int(i64::MAX));
    assert_eq!(
        read("18446744073709551615"),
        ConnValue::UInt(u64::MAX),
        "past i64::MAX stays an integer"
    );
    assert_eq!(read("null"), ConnValue::Null);
    assert_eq!(read(r#""5""#), ConnValue::Str("5".into()));

    for text in [
        "5",
        "5.0",
        "-0.0",
        "1e300",
        "3.5e-7",
        "18446744073709551615",
        r#"[1,"a",null,true,[],{}]"#,
        r#"{"b":false,"a":{"b":[0.1]}}"#,
    ] {
        let theirs = serde_json::from_str::<Value>(text).unwrap();
        assert_eq!(
            serde_json::to_string(&read(text)).unwrap(),
            serde_json::to_string(&theirs).unwrap()
        );
    }
}

#[test]
fn a_value_reads_through_its_accessors() {
    let big = ConnValue::from(u64::MAX);
    assert_eq!(big.as_i64(), None);
    assert_eq!(big.as_u64(), Some(u64::MAX));
    assert_eq!(ConnValue::from(7u64), ConnValue::Int(7));
    assert_eq!(ConnValue::Int(-1).as_u64(), None);
    assert_eq!(ConnValue::Int(2).as_f64(), Some(2.0));
    assert_eq!(ConnValue::Float(2.0).as_i64(), None);

    let interfaces: ConnValue =
        serde_json::from_str(r#"[{"device_bus":1,"enabled":true,"protocol":"can"}]"#).unwrap();
    let first = interfaces.as_list().unwrap()[0].as_map().unwrap();
    assert_eq!(first["device_bus"].as_u64(), Some(1));
    assert_eq!(first["enabled"].as_bool(), Some(true));
    assert_eq!(first["protocol"].as_str(), Some("can"));
    assert!(ConnValue::Null.is_null());
}

#[test]
fn a_value_gets_a_key_only_from_a_map() {
    let map: ConnValue = serde_json::from_str(r#"{"bus":1}"#).unwrap();
    assert_eq!(map.get("bus"), Some(&ConnValue::Int(1)));
    assert_eq!(map.get("absent"), None);
    assert_eq!(ConnValue::Str("bus".into()).get("bus"), None);
    assert_eq!(ConnValue::Null.get("bus"), None);
}

/// A kind whose reader takes a default must declare it, aliases included.
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
        assert!(spec(kind).is_some(), "no kind table entry for '{kind}'");
    }
}

/// So `req_*`'s missing error can only ever be about a required field.
#[test]
fn every_default_reads_back() {
    for kind in kinds() {
        let p = profile(kind);
        for (key, val) in spec(kind).unwrap().defaults {
            let found = match val {
                DefaultValue::Str(_) => p.conn_str(key).is_some(),
                DefaultValue::Int(_) => p.conn_i64(key).is_some(),
                DefaultValue::Float(_) => p.conn_f64(key).is_some(),
                DefaultValue::Bool(_) => p.conn_bool(key).is_some(),
            };
            assert!(
                found,
                "{kind}.{key} does not read back through its accessor"
            );
        }
    }
}

#[test]
fn defaults_and_required_are_disjoint() {
    for kind in kinds() {
        let spec = spec(kind).unwrap();
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
    set(&mut p, "bitrate", "250000");
    apply_defaults(&mut p);
    let once = p.connection.clone();
    apply_defaults(&mut p);
    assert_eq!(once, p.connection);
    assert_eq!(p.connection["bitrate"], "250000".into());
    assert_eq!(p.connection["baud_rate"], "115200".into());
}

#[test]
fn default_connection_is_the_forms_seed() {
    assert_eq!(
        serde_json::to_value(default_connection("modbus_tcp")).unwrap(),
        json!({"host": "192.168.1.100", "port": 502, "unit_id": 1, "timeout": 5.0})
    );
    assert!(default_connection("capture").is_empty());
}

/// The values that had drifted between the two languages.
#[test]
fn resolved_drifts_are_pinned() {
    for (kind, key, want) in [
        ("gvret_tcp", "host", DefaultValue::Str("192.168.1.100")),
        ("modbus_tcp", "host", DefaultValue::Str("192.168.1.100")),
        ("slcan", "silent_mode", DefaultValue::Bool(true)),
    ] {
        assert_eq!(default_value(kind, key), Some(want), "{kind}.{key}");
    }
}

#[test]
fn accessors_tolerate_both_spellings() {
    let mut p = profile("modbus_tcp");
    set(&mut p, "port", "8502");
    assert_eq!(p.conn_i64("port"), Some(8502));
    set(&mut p, "port", 8502i64);
    assert_eq!(p.conn_i64("port"), Some(8502));
}

#[test]
fn accessors_fall_back_to_the_table() {
    let p = profile("modbus_tcp");
    assert_eq!(p.req_str("host").unwrap(), "192.168.1.100");
    assert_eq!(p.req_i64("port").unwrap(), 502);
    assert_eq!(p.req_i64("unit_id").unwrap(), 1);
}

/// `socketcan.bitrate` absent means "leave the interface as configured".
#[test]
fn an_undeclared_field_reports_missing() {
    let p = profile("socketcan");
    assert_eq!(p.conn_i64("bitrate"), None);
    assert_eq!(
        p.req_i64("bitrate").unwrap_err().to_string(),
        "socketcan profile is missing 'bitrate'"
    );
}

#[test]
fn a_missing_field_converts_to_a_string_through_question_mark() {
    fn bitrate(p: &IOProfile) -> Result<i64, String> {
        Ok(p.req_i64("bitrate")?)
    }
    assert_eq!(
        bitrate(&profile("socketcan")),
        Err("socketcan profile is missing 'bitrate'".to_string())
    );
}

#[test]
fn a_boolean_reads_from_either_spelling() {
    let mut p = profile("slcan");
    for (written, want) in [("false", false), ("true", true), ("0", false), ("1", true)] {
        set(&mut p, "silent_mode", written);
        assert_eq!(p.conn_bool("silent_mode"), Some(want), "{written}");
    }
    set(&mut p, "silent_mode", false);
    assert_eq!(p.conn_bool("silent_mode"), Some(false));
}

#[test]
fn a_blank_string_falls_through_to_the_default() {
    let mut p = profile("mqtt");
    set(&mut p, "host", "");
    assert_eq!(p.conn_str("host").as_deref(), Some("localhost"));
}

#[test]
fn a_byte_list_reads_from_a_list_or_hex() {
    let mut p = profile("serial");
    set(
        &mut p,
        "delimiter",
        vec![ConnValue::Int(13), 300i64.into(), 10i64.into()],
    );
    assert_eq!(p.conn_u8_list("delimiter"), Some(vec![13, 10]));
    set(&mut p, "delimiter", "0x20,0x60");
    assert_eq!(p.conn_u8_list("delimiter"), Some(vec![0x20, 0x60]));
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

#[test]
fn validate_allows_a_profile_to_keep_its_own_name() {
    let p = profile("virtual");
    assert!(validate_profile(&p, std::slice::from_ref(&p)).is_ok());
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

/// The frontend's translation map is keyed by the code.
#[test]
fn a_rejection_serialises_as_the_frontend_reads_it() {
    let err = validate_profile(&profile("slcan"), &[]).unwrap_err();
    assert_eq!(
        serde_json::to_value(err).unwrap(),
        json!({"code": "portRequired", "field": "port"})
    );
}

/// `modbus_tcp`'s host is defaulted, not required.
#[test]
fn validate_passes_modbus_on_its_default_host() {
    let mut p = profile("modbus_tcp");
    apply_defaults(&mut p);
    assert!(validate_profile(&p, &[]).is_ok());
}

/// The MQTT and WireTAP backend readers read the table, so a blank URL falls
/// back to the default rather than failing.
#[test]
fn a_blank_reader_field_reads_the_kind_default() {
    let mut backend = profile("wiretap");
    set(&mut backend, "url", "");
    assert_eq!(backend.req_str("url").unwrap(), "http://localhost:8423");
    assert_eq!(backend.req_str("database").unwrap(), "wiretap");

    let mqtt = profile("mqtt");
    assert_eq!(mqtt.req_str("host").unwrap(), "localhost");
    assert_eq!(mqtt.req_i64("port").unwrap(), 1883);
}

fn serial_profile(framing: &str) -> IOProfile {
    let mut p = profile("serial");
    set(&mut p, "framing_encoding", framing);
    p
}

#[test]
fn validate_rejects_an_empty_delimiter_or_a_zero_frame_length() {
    let mut p = serial_profile("delimiter");
    set(&mut p, "port", "/dev/ttyUSB0");
    assert!(validate_profile(&p, &[]).is_ok());

    let mut empty = p.clone();
    set(&mut empty, "delimiter", Vec::new());
    let err = validate_profile(&empty, &[]).unwrap_err();
    assert_eq!(err.code, ValidationCode::FieldInvalid);
    assert_eq!(err.field.as_deref(), Some("delimiter"));

    let mut zero = p;
    set(&mut zero, "max_frame_length", 0i64);
    let err = validate_profile(&zero, &[]).unwrap_err();
    assert_eq!(err.code, ValidationCode::FieldInvalid);
    assert_eq!(err.field.as_deref(), Some("max_frame_length"));
}

#[test]
fn a_session_framing_that_frames_every_byte_is_refused() {
    let mut profile = profile("serial");
    set(&mut profile, "port", "/dev/ttyUSB0");
    let session = |framing| SerialOverrides {
        framing_encoding: Some(framing),
        ..Default::default()
    };
    assert!(SerialSourceConfig::from_profile(&profile, &session(FramingMode::Delimiter)).is_ok());

    let empty = SerialOverrides {
        delimiter: Some(vec![]),
        ..session(FramingMode::Delimiter)
    };
    let err = SerialSourceConfig::from_profile(&profile, &empty).unwrap_err();
    assert!(err.to_string().contains("delimiter"), "{err}");

    for framing in [FramingMode::Delimiter, FramingMode::Slip] {
        let zero = SerialOverrides {
            max_frame_length: Some(0),
            ..session(framing)
        };
        let err = SerialSourceConfig::from_profile(&profile, &zero).unwrap_err();
        assert_eq!(
            err.to_string(),
            "Serial framing: 'max_frame_length' would release every byte as its own frame",
            "{framing}"
        );
    }
}

/// The broker decides a session's captures from these two answers.
#[test]
fn a_framed_serial_profile_does_not_resolve_to_raw_bytes() {
    assert_eq!(
        resolve_serial_framing(&serial_profile("slip"), None, None),
        (FramingMode::Slip, false)
    );
    assert_eq!(
        resolve_serial_framing(&serial_profile("raw"), None, None),
        (FramingMode::Raw, true)
    );
}

/// A profile predating the field still streams bytes.
#[test]
fn an_unset_framing_falls_back_to_the_kind_default() {
    assert_eq!(
        resolve_serial_framing(&profile("serial"), None, None),
        (FramingMode::Raw, true)
    );
}

#[test]
fn a_session_override_wins_over_the_profile() {
    assert_eq!(
        resolve_serial_framing(&serial_profile("raw"), Some(FramingMode::ModbusRtu), None),
        (FramingMode::ModbusRtu, false)
    );
    assert_eq!(
        resolve_serial_framing(&serial_profile("slip"), None, Some(true)),
        (FramingMode::Slip, true)
    );
}

#[test]
fn a_saved_framing_loads_as_the_session_spelling() {
    for (saved, mode) in [
        ("raw", FramingMode::Raw),
        ("delimiter", FramingMode::Delimiter),
        ("slip", FramingMode::Slip),
        ("modbus_rtu", FramingMode::ModbusRtu),
        ("", FramingMode::Raw),
        ("cobs", FramingMode::Raw),
    ] {
        assert_eq!(serial_profile(saved).conn_framing(), mode, "{saved:?}");
    }
}

#[test]
fn a_serial_source_reads_the_profile_under_the_session() {
    let mut p = serial_profile("modbus_rtu");
    set(&mut p, "port", "/dev/ttyUSB0");
    set(&mut p, "baud_rate", "9600");
    set(&mut p, "parity", "even");
    set(&mut p, "modbus_validate_crc", "false");
    set(&mut p, "modbus_vendor_functions", "0x41 0x42");
    set(&mut p, "frame_id_start_byte", 1i64);
    set(&mut p, "frame_id_bytes", "2");
    set(&mut p, "source_address_start_byte", 0i64);
    let session = SerialOverrides {
        modbus_device_address: Some(7),
        source_address_start_byte: Some(3),
        source_address_big_endian: Some(false),
        min_frame_length: Some(4),
        ..SerialOverrides::default()
    };

    let config = SerialSourceConfig::from_profile(&p, &session).unwrap();
    assert_eq!(config.port, "/dev/ttyUSB0");
    assert_eq!(config.line.to_string(), "9600 8E1");
    assert_eq!(
        config.framing_encoding,
        FramingEncoding::ModbusRtu(RtuSettings {
            device_address: Some(7),
            validate_crc: false,
            vendor_functions: vec![0x41, 0x42],
            ..RtuSettings::default()
        })
    );
    assert_eq!(
        config.frame_id_config,
        Some(FrameIdConfig {
            start_byte: 1,
            num_bytes: 2,
            big_endian: true
        })
    );
    assert_eq!(
        config.source_address_config,
        Some(FrameIdConfig {
            start_byte: 3,
            num_bytes: 1,
            big_endian: false
        })
    );
    assert_eq!(config.min_frame_length, 4);
    assert!(!config.emit_raw_bytes);
}

#[test]
fn a_delimited_source_defaults_to_newline() {
    let mut p = serial_profile("delimiter");
    set(&mut p, "port", "COM3");
    let config = SerialSourceConfig::from_profile(&p, &SerialOverrides::default()).unwrap();
    assert_eq!(
        config.framing_encoding,
        FramingEncoding::Delimiter(DelimiterOptions {
            delimiter: vec![0x0A],
            max_length: 1024,
            include_delimiter: false,
        })
    );
    assert_eq!(config.line.to_string(), "115200 8N1");
    assert_eq!(config.frame_id_config, None);
}

#[test]
fn a_serial_source_without_a_port_or_with_a_bad_line_is_refused() {
    let err = SerialSourceConfig::from_profile(&profile("serial"), &SerialOverrides::default());
    assert_eq!(err.unwrap_err().to_string(), "Serial port is required");

    let mut p = profile("serial");
    set(&mut p, "port", "/dev/ttyUSB0");
    set(&mut p, "parity", "mark");
    let err = SerialSourceConfig::from_profile(&p, &SerialOverrides::default()).unwrap_err();
    assert_eq!(
        err.to_string(),
        "parity must be none, even or odd, got \"mark\""
    );
}

#[test]
fn a_serial_source_error_converts_to_a_string_through_question_mark() {
    fn port(p: &IOProfile) -> Result<String, String> {
        Ok(SerialSourceConfig::from_profile(p, &SerialOverrides::default())?.port)
    }
    assert_eq!(
        port(&profile("serial")),
        Err("Serial port is required".to_string())
    );
}

/// The desktop flattens the overrides into each source's config, so the
/// frontend sends them as flat keys beside the source's own.
#[derive(Debug, Deserialize, Serialize)]
struct SourceConfig {
    profile_id: String,
    #[serde(flatten)]
    serial: SerialOverrides,
    #[serde(default)]
    max_register_errors: Option<u32>,
}

#[test]
fn overrides_read_flattened_into_a_source_config() {
    let source: SourceConfig = serde_json::from_value(json!({
        "profile_id": "io_se",
        "framing_encoding": "slip",
        "delimiter": [13, 10],
        "max_frame_length": 512,
        "frame_id_big_endian": null,
        "max_register_errors": 3,
        "display_name": "unknown to both",
    }))
    .unwrap();
    assert_eq!(
        source.serial,
        SerialOverrides {
            framing_encoding: Some(FramingMode::Slip),
            delimiter: Some(vec![13, 10]),
            max_frame_length: Some(512),
            ..SerialOverrides::default()
        }
    );
    assert_eq!(source.max_register_errors, Some(3));

    let saved = serde_json::to_value(&source).unwrap();
    assert_eq!(saved["framing_encoding"], "slip");
    assert_eq!(saved["min_frame_length"], Value::Null);
    assert_eq!(saved["profile_id"], "io_se");
}

// The profile's wire types as the desktop's generated `SerialOverrides.ts`,
// `ProfileValidationError.ts` and `ValidationCode.ts` declare them, doc
// comments aside.

use ts_rs::{Config, TS};

fn decl<T: TS>() -> String {
    T::decl(&Config::new().with_large_int("number"))
        .lines()
        .filter(|line| !line.starts_with("/**") && !line.starts_with(" *"))
        .collect()
}

#[test]
fn serial_overrides_are_every_field_optional_and_nullable() {
    assert_eq!(
        decl::<SerialOverrides>(),
        "type SerialOverrides = { framing_encoding?: FramingMode | null, delimiter?: Array<number> | null, \
max_frame_length?: number | null, min_frame_length?: number | null, emit_raw_bytes?: boolean | null, \
modbus_validate_crc?: boolean | null, modbus_device_address?: number | null, \
modbus_vendor_functions?: Array<number> | null, modbus_allow_broadcast?: boolean | null, \
modbus_any_function?: boolean | null, frame_id_start_byte?: number | null, frame_id_bytes?: number | null, \
frame_id_big_endian?: boolean | null, source_address_start_byte?: number | null, \
source_address_bytes?: number | null, source_address_big_endian?: boolean | null, };"
    );
}

#[test]
fn a_rejection_is_a_camel_case_code_and_a_field() {
    assert_eq!(
        decl::<ValidationCode>(),
        r#"type ValidationCode = "nameRequired" | "nameDuplicate" | "portRequired" | "hostRequired" | "fieldRequired" | "fieldInvalid";"#
    );
    assert_eq!(
        decl::<ProfileValidationError>(),
        "type ProfileValidationError = { code: ValidationCode, field: string | null, };"
    );
}
