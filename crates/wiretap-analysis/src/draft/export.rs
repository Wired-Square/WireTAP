//! Discovery's catalogue export: the meta and protocol config a catalogue opens
//! with, a frame per id seen, and a Modbus frame per register found.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use wslib_bits::Endianness;
use wslib_wiretap_catalogue::edit::{
    CanConfigFields, EditOp, FrameFields, HeaderFieldFields, Mask, MetaFields, ModbusConfigFields,
    SerialChecksumFields, SerialConfigFields,
};
use wslib_wiretap_catalogue::model::{header_mask, Protocol, RegisterType, SerialConfig};
use wslib_wiretap_protocol::format_frame_id;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ExportMeta {
    pub name: String,
    /// Written as at least 1.
    pub version: i64,
    pub default_byte_order: Endianness,
    /// Milliseconds, written rounded and at least 0.
    pub default_interval: f64,
}

/// What the export could not write; the rest of it is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportFinding {
    /// An id or source-address field of no bytes, which the catalogue cannot place.
    HeaderFieldOutOfRange {
        field: String,
        start_byte: i32,
        bytes: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportError {
    UnsupportedProtocol(String),
}

impl fmt::Display for ExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedProtocol(p) => write!(f, "{p} frames cannot be saved as a catalogue"),
        }
    }
}

impl std::error::Error for ExportError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportFrame {
    pub id: u32,
    pub len: u32,
    #[serde(default)]
    pub is_extended: bool,
    #[serde(default)]
    pub protocol: Option<String>,
}

/// The first protocol a frame names, CAN when none does.
pub fn catalog_protocol(frames: &[ExportFrame]) -> Result<Protocol, ExportError> {
    match frames
        .iter()
        .filter_map(|f| f.protocol.as_deref())
        .find(|p| !p.is_empty())
        .unwrap_or("can")
    {
        "can" => Ok(Protocol::Can),
        "serial" => Ok(Protocol::Serial),
        "modbus" => Ok(Protocol::Modbus),
        other => Err(ExportError::UnsupportedProtocol(other.into())),
    }
}

fn set_meta(meta: &ExportMeta, protocol: Protocol) -> EditOp {
    EditOp::SetMeta {
        meta: MetaFields {
            name: meta.name.clone(),
            version: meta.version.clamp(1, u32::MAX.into()) as u32,
            default_frame: Some(protocol),
        },
    }
}

fn serial_config_fields(
    config: &SerialConfig,
    meta: &ExportMeta,
) -> (SerialConfigFields, Vec<ExportFinding>) {
    let mut fields = BTreeMap::new();
    let mut findings = Vec::new();
    for (name, start_byte, bytes, byte_order) in [
        (
            "id",
            config.frame_id_start_byte,
            config.frame_id_bytes,
            config.frame_id_byte_order,
        ),
        (
            "source_address",
            config.source_address_start_byte,
            config.source_address_bytes,
            config.source_address_byte_order,
        ),
    ] {
        let Some(start_byte) = start_byte else {
            continue;
        };
        let bytes = bytes.unwrap_or(1);
        if bytes == 0 {
            findings.push(ExportFinding::HeaderFieldOutOfRange {
                field: name.into(),
                start_byte,
                bytes,
            });
            continue;
        }
        let mask = header_mask(start_byte, bytes);
        fields.insert(
            name.to_string(),
            HeaderFieldFields {
                mask: mask.map_or_else(Mask::default, Mask::Value),
                start_byte: mask.is_none().then_some(start_byte),
                bytes: mask.is_none().then_some(bytes),
                byte_order,
                ..Default::default()
            },
        );
    }
    let fields = SerialConfigFields {
        encoding: config.encoding.map(|e| e.to_string()),
        byte_order: Some(meta.default_byte_order),
        frame_id_mask: config.frame_id_mask.map(Mask::Value),
        header_length: config.header_length,
        min_frame_length: config.min_frame_length,
        checksum: config.checksum.as_ref().map(|c| SerialChecksumFields {
            algorithm: c.algorithm.clone(),
            start_byte: c.start_byte,
            byte_length: c.byte_length,
            calc_start_byte: c.calc_start_byte,
            calc_end_byte: Some(c.calc_end_byte.unwrap_or(-1)),
            big_endian: c.big_endian,
        }),
        fields,
    };
    (fields, findings)
}

/// The meta and protocol config a Discovery catalogue opens with. `serial` is
/// read only for a serial catalogue.
pub fn head_ops(
    protocol: Protocol,
    meta: &ExportMeta,
    serial: &SerialConfig,
) -> (Vec<EditOp>, Vec<ExportFinding>) {
    let mut ops = vec![set_meta(meta, protocol)];
    let mut findings = Vec::new();
    match protocol {
        Protocol::Can => ops.push(EditOp::SetCanConfig {
            config: CanConfigFields {
                default_byte_order: Some(meta.default_byte_order),
                default_interval: Some(super::whole_ms(meta.default_interval)),
                ..Default::default()
            },
        }),
        Protocol::Serial => {
            let (config, found) = serial_config_fields(serial, meta);
            ops.push(EditOp::SetSerialConfig { config });
            findings = found;
        }
        Protocol::Modbus => {}
    }
    (ops, findings)
}

/// A catalogue declaring each frame's id and length, keyed by
/// [`format_frame_id`], or by the bare decimal id under `decimal_ids`.
pub fn frames_ops(
    frames: &[ExportFrame],
    meta: &ExportMeta,
    decimal_ids: bool,
) -> Result<(Vec<EditOp>, Vec<ExportFinding>), ExportError> {
    let protocol = catalog_protocol(frames)?;
    let (mut ops, findings) = head_ops(protocol, meta, &SerialConfig::default());
    ops.extend(frames.iter().map(|f| EditOp::SetFrame {
        protocol,
        key: if decimal_ids {
            f.id.to_string()
        } else {
            format_frame_id(f.id, f.is_extended)
        },
        rename_from: None,
        frame: FrameFields {
            length: Some(f.len),
            ..Default::default()
        },
    }));
    Ok((ops, findings))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ModbusExportConfig {
    pub device_address: u8,
    pub register_base: u8,
    pub register_type: RegisterType,
    /// Milliseconds, written rounded and at least 0.
    pub default_interval: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModbusRegister {
    pub frame_id: u16,
    /// Bytes read.
    pub dlc: u32,
}

/// A catalogue with one frame per register, in register order: two bytes to a
/// register, one coil or discrete input to a frame.
pub fn modbus_ops(
    registers: &[ModbusRegister],
    meta: &ExportMeta,
    config: &ModbusExportConfig,
) -> Vec<EditOp> {
    let mut registers = registers.to_vec();
    registers.sort_by_key(|r| r.frame_id);
    let length = |dlc: u32| match config.register_type.is_register_bank() {
        true => (dlc / 2).max(1),
        false => 1,
    };
    [
        set_meta(meta, Protocol::Modbus),
        EditOp::SetModbusConfig {
            config: ModbusConfigFields {
                device_address: Some(config.device_address),
                register_base: Some(config.register_base),
                default_interval: Some(super::whole_ms(config.default_interval)),
                ..Default::default()
            },
        },
    ]
    .into_iter()
    .chain(registers.into_iter().map(|r| EditOp::SetFrame {
        protocol: Protocol::Modbus,
        key: r.frame_id.to_string(),
        rename_from: None,
        frame: FrameFields {
            length: Some(length(r.dlc)),
            register_number: Some(r.frame_id),
            register_type: Some(config.register_type),
            ..Default::default()
        },
    }))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wslib_wiretap_catalogue::model::ChecksumConfig;
    use wslib_wiretap_catalogue::FramingMode;

    fn meta(version: i64, default_interval: f64) -> ExportMeta {
        ExportMeta {
            name: "Bench".into(),
            version,
            default_byte_order: Endianness::Little,
            default_interval,
        }
    }

    fn frame(id: u32, protocol: Option<&str>) -> ExportFrame {
        ExportFrame {
            id,
            len: 8,
            is_extended: false,
            protocol: protocol.map(Into::into),
        }
    }

    fn serial_config(ops: &[EditOp]) -> &SerialConfigFields {
        match &ops[1] {
            EditOp::SetSerialConfig { config } => config,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn meta_keeps_version_at_least_one_and_interval_at_least_zero() {
        let (ops, findings) = head_ops(Protocol::Can, &meta(0, -5.0), &SerialConfig::default());
        assert!(findings.is_empty());
        let EditOp::SetMeta { meta: written } = &ops[0] else {
            panic!("{:?}", ops[0]);
        };
        assert_eq!(
            written,
            &MetaFields {
                name: "Bench".into(),
                version: 1,
                default_frame: Some(Protocol::Can)
            }
        );
        let EditOp::SetCanConfig { config } = &ops[1] else {
            panic!("{:?}", ops[1]);
        };
        assert_eq!(
            config,
            &CanConfigFields {
                default_byte_order: Some(Endianness::Little),
                default_interval: Some(0),
                ..Default::default()
            }
        );
        assert_eq!(
            head_ops(Protocol::Modbus, &meta(3, 10.0), &SerialConfig::default())
                .0
                .len(),
            1
        );
    }

    #[test]
    fn the_interval_is_written_as_whole_milliseconds() {
        let written =
            |ms: f64| match &head_ops(Protocol::Can, &meta(1, ms), &SerialConfig::default()).0[1] {
                EditOp::SetCanConfig { config } => config.default_interval,
                other => panic!("{other:?}"),
            };
        assert_eq!(written(99.5), Some(100));
        assert_eq!(written(99.4), Some(99));
        assert_eq!(written(-0.6), Some(0));
        assert_eq!(written(f64::NAN), Some(0));
    }

    #[test]
    fn a_serial_head_writes_the_header_fields_as_exact_masks() {
        let config = SerialConfig {
            encoding: Some(FramingMode::Slip),
            byte_order: Some(Endianness::Big),
            frame_id_mask: Some(0xFF00),
            min_frame_length: Some(4),
            header_length: Some(3),
            frame_id_start_byte: Some(0),
            frame_id_bytes: Some(2),
            frame_id_byte_order: Some(Endianness::Little),
            source_address_start_byte: Some(3),
            source_address_bytes: Some(1),
            checksum: Some(ChecksumConfig {
                algorithm: "sum8".into(),
                start_byte: -1,
                byte_length: 1,
                calc_start_byte: 0,
                calc_end_byte: None,
                big_endian: false,
            }),
            ..Default::default()
        };
        let (ops, findings) = head_ops(Protocol::Serial, &meta(2, 0.0), &config);
        assert!(findings.is_empty());
        let written = serial_config(&ops);
        assert_eq!(written.encoding.as_deref(), Some("slip"));
        assert_eq!(
            written.byte_order,
            Some(Endianness::Little),
            "the meta's, not the config's"
        );
        assert_eq!(written.frame_id_mask, Some(Mask::Value(0xFF00)));
        assert_eq!(
            (written.min_frame_length, written.header_length),
            (Some(4), Some(3))
        );
        assert_eq!(written.fields["id"].mask, Mask::Value(0xFFFF));
        assert_eq!(written.fields["id"].byte_order, Some(Endianness::Little));
        assert_eq!(
            written.fields["source_address"].mask,
            Mask::Value(0xFF00_0000)
        );
        assert_eq!(written.fields["source_address"].byte_order, None);
        let checksum = written.checksum.as_ref().unwrap();
        assert_eq!(
            (checksum.start_byte, checksum.calc_end_byte),
            (-1, Some(-1))
        );
    }

    #[test]
    fn an_end_relative_or_past_byte_four_header_field_is_written_as_its_position() {
        let config = SerialConfig {
            frame_id_start_byte: Some(-2),
            frame_id_bytes: Some(2),
            source_address_start_byte: Some(3),
            source_address_bytes: Some(2),
            ..Default::default()
        };
        let (ops, findings) = head_ops(Protocol::Serial, &meta(1, 0.0), &config);
        assert!(findings.is_empty());
        let written = serial_config(&ops);
        for (name, start_byte, bytes) in [("id", -2, 2), ("source_address", 3, 2)] {
            let field = &written.fields[name];
            assert_eq!(field.mask, Mask::default(), "{name}");
            assert_eq!(
                (field.start_byte, field.bytes),
                (Some(start_byte), Some(bytes))
            );
        }
    }

    #[test]
    fn a_header_field_of_no_bytes_is_a_finding_and_a_start_alone_is_one_byte() {
        let config = SerialConfig {
            frame_id_start_byte: Some(0),
            frame_id_bytes: Some(1),
            source_address_start_byte: Some(-3),
            source_address_bytes: Some(0),
            ..Default::default()
        };
        let (ops, findings) = head_ops(Protocol::Serial, &meta(1, 0.0), &config);
        assert_eq!(
            findings,
            [ExportFinding::HeaderFieldOutOfRange {
                field: "source_address".into(),
                start_byte: -3,
                bytes: 0
            }]
        );
        let written = serial_config(&ops);
        assert_eq!(written.fields.keys().collect::<Vec<_>>(), ["id"]);
        assert_eq!(written.fields["id"].mask, Mask::Value(0xFF));
        let config = SerialConfig {
            frame_id_start_byte: Some(1),
            ..Default::default()
        };
        let (ops, none) = head_ops(Protocol::Serial, &meta(1, 0.0), &config);
        assert!(none.is_empty());
        assert_eq!(serial_config(&ops).fields["id"].mask, Mask::Value(0xFF00));
        assert_eq!(
            serde_json::to_value(&findings[0]).unwrap(),
            serde_json::json!({
                "code": "headerFieldOutOfRange", "field": "source_address", "startByte": -3, "bytes": 0
            })
        );
    }

    #[test]
    fn frames_take_the_first_named_protocol_and_their_formatted_id() {
        let frames = [
            frame(0x7B, Some("")),
            ExportFrame {
                is_extended: true,
                ..frame(0x18FF_50E5, None)
            },
            frame(0x10, Some("can")),
        ];
        let (ops, findings) = frames_ops(&frames, &meta(1, 100.0), false).unwrap();
        assert!(findings.is_empty());
        let keys: Vec<_> = ops[2..]
            .iter()
            .map(|op| match op {
                EditOp::SetFrame {
                    protocol: Protocol::Can,
                    key,
                    frame,
                    ..
                } => (key.as_str(), frame.length),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            keys,
            [
                ("0x07B", Some(8)),
                ("0x18FF50E5", Some(8)),
                ("0x010", Some(8))
            ]
        );
        assert_eq!(
            catalog_protocol(&[frame(1, None), frame(2, Some("serial"))]),
            Ok(Protocol::Serial)
        );
        assert_eq!(catalog_protocol(&[]), Ok(Protocol::Can));
    }

    #[test]
    fn a_protocol_without_a_catalogue_is_an_error() {
        let err = frames_ops(&[frame(1, Some("lin"))], &meta(1, 0.0), false).unwrap_err();
        assert_eq!(err, ExportError::UnsupportedProtocol("lin".into()));
        assert_eq!(err.to_string(), "lin frames cannot be saved as a catalogue");
    }

    #[test]
    fn modbus_frames_are_in_register_order_with_a_register_or_coil_length() {
        let registers = [
            ModbusRegister {
                frame_id: 40,
                dlc: 4,
            },
            ModbusRegister {
                frame_id: 3,
                dlc: 1,
            },
            ModbusRegister {
                frame_id: 10,
                dlc: 5,
            },
        ];
        let config = |register_type| ModbusExportConfig {
            device_address: 7,
            register_base: 1,
            register_type,
            default_interval: 499.5,
        };
        let frames = |register_type| -> Vec<(String, u32)> {
            modbus_ops(&registers, &meta(0, 0.0), &config(register_type))[2..]
                .iter()
                .map(|op| match op {
                    EditOp::SetFrame {
                        protocol: Protocol::Modbus,
                        key,
                        frame,
                        ..
                    } => {
                        assert_eq!(
                            frame.register_number.map(|n| n.to_string()),
                            Some(key.clone())
                        );
                        assert_eq!(frame.register_type, Some(register_type));
                        (key.clone(), frame.length.unwrap())
                    }
                    other => panic!("{other:?}"),
                })
                .collect()
        };
        assert_eq!(
            frames(RegisterType::Holding),
            [("3".into(), 1), ("10".into(), 2), ("40".into(), 2)]
        );
        assert_eq!(
            frames(RegisterType::Coil),
            [("3".into(), 1), ("10".into(), 1), ("40".into(), 1)]
        );
        let ops = modbus_ops(&registers, &meta(0, 0.0), &config(RegisterType::Input));
        let EditOp::SetModbusConfig { config: written } = &ops[1] else {
            panic!("{:?}", ops[1]);
        };
        assert_eq!(
            written,
            &ModbusConfigFields {
                device_address: Some(7),
                register_base: Some(1),
                default_interval: Some(500),
                ..Default::default()
            }
        );
        for ms in [-5.0, f64::NAN] {
            let config = ModbusExportConfig {
                default_interval: ms,
                ..config(RegisterType::Input)
            };
            match &modbus_ops(&registers, &meta(0, 0.0), &config)[1] {
                EditOp::SetModbusConfig { config } => assert_eq!(config.default_interval, Some(0)),
                other => panic!("{other:?}"),
            }
        }
    }
}
