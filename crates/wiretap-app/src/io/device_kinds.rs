//! What each device kind is, beside what its connection map holds: the
//! connection table itself (defaults, required fields, validation) is
//! `wiretap_io::profile`'s, and this one is keyed by the same kinds.

use std::collections::HashMap;

use wiretap_io::profile::{canonical_kind, default_connection, ConnValue};

use crate::io::Protocol;

/// What a device kind is to this app.
pub struct KindTraits {
    /// Live traffic, as against an archive played back.
    pub realtime: bool,
    /// What the kind's buses carry unless its connection map says otherwise.
    pub protocol: Protocol,
    /// Whether a CAN bus of this kind transmits.
    pub can_tx: bool,
    /// Opens through `IOBroker`, and so can share a session with other sources.
    pub multi_source: bool,
    /// One session at a time holds the device.
    pub single_handle: bool,
    /// Whether this build can open it; must match the spawner's `cfg` arms.
    pub available: bool,
}

const LIVE_CAN: KindTraits = KindTraits {
    realtime: true,
    protocol: Protocol::Can,
    can_tx: true,
    multi_source: true,
    single_handle: false,
    available: true,
};

pub const VIRTUAL_FRAME_RATE_RANGE: (f64, f64) = (0.1, 1000.0);
pub const VIRTUAL_BUS_COUNT_RANGE: (u8, u8) = (1, 8);

/// One row per `wiretap_io::profile::kinds()`, in its order.
static TRAITS: &[(&str, KindTraits)] = &[
    ("framelink", LIVE_CAN),
    (
        "gs_usb",
        KindTraits {
            single_handle: true,
            // Linux drives these adapters through the kernel, as SocketCAN.
            available: cfg!(any(target_os = "windows", target_os = "macos")),
            ..LIVE_CAN
        },
    ),
    ("gvret_tcp", LIVE_CAN),
    (
        "gvret_usb",
        KindTraits {
            available: cfg!(not(target_os = "ios")),
            ..LIVE_CAN
        },
    ),
    (
        "modbus_tcp",
        KindTraits {
            protocol: Protocol::Modbus,
            can_tx: false,
            ..LIVE_CAN
        },
    ),
    (
        "mqtt",
        KindTraits {
            can_tx: false,
            // Read by its own reader: the broker's spawner has no arm for it.
            multi_source: false,
            ..LIVE_CAN
        },
    ),
    (
        "wiretap",
        KindTraits {
            realtime: false,
            can_tx: false,
            multi_source: false,
            ..LIVE_CAN
        },
    ),
    (
        "serial",
        KindTraits {
            protocol: Protocol::Serial,
            can_tx: false,
            single_handle: true,
            available: cfg!(not(target_os = "ios")),
            ..LIVE_CAN
        },
    ),
    (
        "slcan",
        KindTraits {
            single_handle: true,
            available: cfg!(not(target_os = "ios")),
            ..LIVE_CAN
        },
    ),
    (
        "socketcan",
        KindTraits {
            available: cfg!(target_os = "linux"),
            ..LIVE_CAN
        },
    ),
    ("virtual", LIVE_CAN),
];

/// `None` for a kind the profile table lacks (captures, recorded sources, the
/// Modbus scan pseudo-source).
pub fn traits(kind: &str) -> Option<&'static KindTraits> {
    let kind = canonical_kind(kind);
    TRAITS.iter().find(|(k, _)| *k == kind).map(|(_, t)| t)
}

/// Whether a kind opens through `IOBroker`; false for one the table lacks.
pub fn is_multi_source(kind: &str) -> bool {
    traits(kind).is_some_and(|t| t.multi_source)
}

/// The default connection map for a kind, for the form to seed from.
#[tauri::command(rename_all = "snake_case")]
pub fn default_connection_for_kind(kind: String) -> HashMap<String, ConnValue> {
    default_connection(&kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiretap_io::profile::{default_value, kinds, validate_profile, DefaultValue};

    use crate::settings::IOProfile;

    fn json(value: DefaultValue) -> serde_json::Value {
        serde_json::to_value(ConnValue::from(value)).unwrap()
    }

    fn profile(kind: &str) -> IOProfile {
        IOProfile {
            id: "io_test".to_string(),
            name: "Test".to_string(),
            kind: kind.to_string(),
            ..IOProfile::default()
        }
    }

    #[test]
    fn every_profile_kind_has_its_traits_and_no_more() {
        let ours: Vec<&str> = TRAITS.iter().map(|(k, _)| *k).collect();
        assert_eq!(ours, kinds().collect::<Vec<_>>());
    }

    /// The form's own TypeScript table, taken before it was deleted: every value
    /// it filled in is this table's too. Where the two required different fields
    /// this one stands, and the differences are listed here.
    #[test]
    fn the_retired_typescript_table_agrees_with_this_one() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("device_kinds/ts-golden.json")).unwrap();
        let text = |v: &serde_json::Value| v.as_str().map_or_else(|| v.to_string(), str::to_string);

        for (kind, fields) in golden["defaults"].as_object().unwrap() {
            for (key, value) in fields.as_object().unwrap() {
                let ours = default_value(kind, key).map(|v| text(&json(v)));
                assert_eq!(ours, Some(text(value)), "{kind}.{key}");
            }
        }

        let rust_differs = [
            ("gvret_usb", Some("portRequired")),
            ("framelink", Some("hostRequired")),
            ("modbus_tcp", None),
        ];
        for (kind, theirs) in golden["required"].as_object().unwrap() {
            let ours = validate_profile(&profile(kind), &[])
                .err()
                .map(|e| serde_json::to_value(e.code).unwrap());
            let expected = rust_differs
                .iter()
                .find(|(k, _)| k == kind)
                .map_or_else(|| theirs.clone(), |(_, code)| serde_json::json!(code));
            assert_eq!(ours.unwrap_or_default(), expected, "{kind}");
        }

        // The Modbus tools kept their own fallback address, 127.0.0.1 for the host.
        let tools = &golden["modbusTools"];
        for key in ["port", "unit_id"] {
            assert_eq!(default_value("modbus_tcp", key).map(json), Some(tools[key].clone()), "{key}");
        }
        assert_eq!(default_value("modbus_tcp", "host"), Some(DefaultValue::Str("192.168.1.100")));
    }
}
