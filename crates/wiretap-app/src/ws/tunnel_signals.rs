// Copyright 2026 Wired Square Pty Ltd

//! Turn a reassembled tunnel message into the shapes the Decoder already renders:
//! its signals, decoded by `wiretap_catalog`, and a **transaction** record for
//! the Decoder's Modbus tab carrying the raw bytes and how many frames they took.

use serde::Serialize;
use wiretap_catalog::decode::Decoded;
use wiretap_catalog::modbus::{decode_rtu_message, exception_label, function_label};
use wiretap_catalog::{Catalog, Direction, DirectionBasis, ModbusRtuMessage, Payload};

/// One decoded tunnel message: the signals to merge into the frame's entry, and
/// the transaction record for the Modbus tab.
pub struct TunnelDecode<'a> {
    pub signals: Vec<Decoded>,
    pub transaction: DecodedTunnelMessage<'a>,
}

/// One Modbus RTU message, from a tunnel or an RTU-framed serial port. A
/// tunnelled message rides the frame that completed it.
// Fields are in key order, as in `ws::decoded`.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DecodedTunnelMessage<'a> {
    /// Coil or discrete states; empty unless `payload` is `coils`.
    pub coils: &'a [bool],
    /// Only ever false under a lenient CRC policy, where the boundary came from
    /// the length rules alone and the message may have been guessed.
    pub crc_valid: bool,
    /// The body between the header and the CRC: the only route to the bytes of
    /// a function code nothing models.
    pub data: &'a [u8],
    pub device: u8,
    pub direction: TunnelDirection,
    pub direction_basis: TunnelDirectionBasis,
    pub exception: Option<u8>,
    pub exception_label: Option<String>,
    /// The catalogue register frame the values decoded through.
    pub frame: Option<&'a str>,
    /// How many CAN frames the message spanned.
    pub frames: u32,
    pub function: u8,
    pub function_label: String,
    /// µs since the request this response answers, when that request was seen.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub latency_us: Option<u64>,
    pub payload: TunnelPayload,
    pub protocol: TunnelProtocol,
    pub quantity: Option<u16>,
    /// The reassembled message, CRC included.
    pub raw: &'a [u8],
    /// Start register; null when a read response had no request to inherit from.
    pub register: Option<u16>,
    /// Register values; empty unless `payload` is `registers`.
    pub values: &'a [u16],
}

#[derive(Serialize, Clone, Copy)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum TunnelProtocol {
    ModbusRtu,
}

#[derive(Serialize, Clone, Copy)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TunnelDirection {
    Request,
    Response,
}

/// Which of `values` and `coils` holds the message's values, if either.
#[derive(Serialize, Clone, Copy)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TunnelPayload {
    Registers,
    Coils,
    None,
    Opaque,
}

/// What sided the message. `alternation` is a guess from the line's
/// request/response rhythm, and an unknown basis reads as one: a label that
/// overstates is worse than one that hedges.
#[derive(Serialize, Clone, Copy)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum TunnelDirectionBasis {
    Layout,
    Pairing,
    Alternation,
}

/// Render one reassembled message for the WS payload.
pub fn decode_message<'a>(msg: &'a ModbusRtuMessage, catalog: &'a Catalog) -> TunnelDecode<'a> {
    let d = decode_rtu_message(catalog, msg);
    let transaction = DecodedTunnelMessage {
        coils: msg.coils(),
        crc_valid: msg.crc_valid,
        data: msg.data_block(),
        device: msg.device_address,
        direction: match msg.direction {
            Direction::Request => TunnelDirection::Request,
            Direction::Response => TunnelDirection::Response,
        },
        direction_basis: match msg.direction_basis {
            DirectionBasis::Layout => TunnelDirectionBasis::Layout,
            DirectionBasis::Pairing => TunnelDirectionBasis::Pairing,
            _ => TunnelDirectionBasis::Alternation,
        },
        exception: msg.exception,
        exception_label: msg.exception.map(exception_label),
        frame: d.frame.map(|f| f.key.as_str()),
        frames: msg.frame_count,
        function: msg.function,
        function_label: function_label(msg.function),
        latency_us: None,
        payload: match msg.payload {
            Payload::Registers(_) => TunnelPayload::Registers,
            Payload::Coils(_) => TunnelPayload::Coils,
            Payload::None => TunnelPayload::None,
            _ => TunnelPayload::Opaque,
        },
        protocol: TunnelProtocol::ModbusRtu,
        quantity: msg.quantity,
        raw: &msg.raw,
        register: msg.start_register,
        values: msg.registers(),
    };
    TunnelDecode {
        signals: [d.header, d.values].concat(),
        transaction,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiretap_catalog::ModbusRtuStream;

    const CATALOG: &str = r#"
[meta]
name = "sbr"
[frame.can."0x1E0"]
length = 8
[frame.can."0x1E0".tunnel]
protocol = "modbus_rtu"
device_address = 1

[frame.modbus.charge_limits]
register_number = 19938
register_type = "input"
length = 2
node_address = 1
[[frame.modbus.charge_limits.signals]]
name = "Charge_Current_Limit"
start_bit = 0
bit_length = 16
factor = 0.1
unit = "A"
"#;

    fn catalog() -> Catalog {
        Catalog::parse(CATALOG).unwrap()
    }

    /// One tunnel for the whole exchange, chunked into 8-byte CAN payloads: a
    /// response inherits its register address from the request before it.
    fn exchange(catalog: &Catalog, messages: &[&str]) -> Vec<ModbusRtuMessage> {
        let declared = catalog.frame(0x1E0).unwrap().tunnel.as_ref().unwrap();
        let mut t = catalog.tunnel_stream(declared);
        let mut out = Vec::new();
        for hex in messages {
            for chunk in hex_bytes(hex).chunks(8) {
                out.extend(t.push(chunk));
            }
        }
        out
    }

    fn hex_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn framed(hex: &str) -> Vec<u8> {
        let mut out = hex_bytes(hex);
        out.extend(wiretap_checksum::algorithms::crc16_modbus_checksum(&out).to_le_bytes());
        out
    }

    fn messages(bodies: &[&str]) -> Vec<ModbusRtuMessage> {
        let mut t = ModbusRtuStream::for_address(Some(1));
        bodies
            .iter()
            .flat_map(|b| t.push_bytes(&framed(b)))
            .collect()
    }

    fn transaction(msg: &ModbusRtuMessage, catalog: &Catalog) -> serde_json::Value {
        serde_json::to_value(decode_message(msg, catalog).transaction).unwrap()
    }

    fn coils(transaction: &serde_json::Value) -> Vec<bool> {
        transaction["coils"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_bool().unwrap())
            .collect()
    }

    #[test]
    fn a_coil_read_carries_coils_not_values() {
        let msgs = messages(&["0101000A000A", "010102D502"]);
        let request = transaction(&msgs[0], &catalog());
        assert_eq!(request["payload"], "none");
        assert!(coils(&request).is_empty());
        assert_eq!(request["directionBasis"], "layout");

        let response = transaction(&msgs[1], &catalog());
        assert_eq!(response["payload"], "coils");
        assert_eq!(response["values"].as_array().unwrap().len(), 0);
        assert_eq!(
            coils(&response),
            [true, false, true, false, true, false, true, true, false, true]
        );
        assert_eq!(response["data"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_single_coil_write_carries_its_state() {
        for (body, state) in [("0105001AFF00", true), ("0105001A0000", false)] {
            let msgs = messages(&[body]);
            let out = transaction(&msgs[0], &catalog());
            assert_eq!(out["payload"], "coils");
            assert_eq!(out["values"].as_array().unwrap().len(), 0);
            assert_eq!(coils(&out), [state]);
        }
    }

    #[test]
    fn a_register_read_carries_its_values() {
        let msgs = messages(&["01044DE20002", "010404012C0000"]);
        let out = transaction(msgs.last().unwrap(), &catalog());
        assert_eq!(out["payload"], "registers");
        assert_eq!(out["values"].as_array().unwrap().len(), 2);
        assert!(coils(&out).is_empty());
    }

    #[test]
    fn a_vendor_message_reaches_the_tab_through_its_data_block() {
        let mut t = ModbusRtuStream::for_address(Some(1)).with_vendor_functions(&[0x20]);
        let msgs = t.push_bytes(&framed("012001C803111A0002"));
        assert_eq!(msgs.len(), 1);

        let out = transaction(&msgs[0], &catalog());
        assert_eq!(out["payload"], "opaque");
        assert_eq!(out["directionBasis"], "alternation");
        assert_eq!(out["values"].as_array().unwrap().len(), 0);
        let data: Vec<u64> = out["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(data, vec![0x01, 0xC8, 0x03, 0x11, 0x1A, 0x00, 0x02]);
        assert_eq!(out["functionLabel"], "0x20 Unknown");
    }

    #[test]
    fn a_transaction_names_its_frame_and_counts_its_can_frames() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "01040401F40000BB8A"]);
        assert_eq!(msgs.len(), 2);
        assert_eq!(transaction(&msgs[0], &cat)["frames"], 1);
        let d = transaction(&msgs[1], &cat);
        assert_eq!(d["frame"], "charge_limits");
        assert_eq!(d["frames"], 2);

        // Holding registers, so the input-register catalogue entry must not match.
        let msgs = exchange(
            &cat,
            &["01034DE200067292", "01030C01F40000012C000000C80000D570"],
        );
        let d = transaction(&msgs[1], &cat);
        assert!(d["frame"].is_null());
        assert_eq!(d["frames"], 3);
    }

    #[test]
    fn an_exception_response_is_labelled() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "018402C2C1"]);
        assert_eq!(msgs.len(), 2);
        let d = transaction(&msgs[1], &cat);
        assert_eq!(d["exceptionLabel"], "0x02 Illegal Data Address");
    }
}
