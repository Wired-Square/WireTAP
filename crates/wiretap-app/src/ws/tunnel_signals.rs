// Copyright 2026 Wired Square Pty Ltd

//! Turn a reassembled tunnel message into the shapes the Decoder already renders:
//! its signals, decoded by `wiretap_catalog`, and a **transaction** record for
//! the Decoder's Modbus tab carrying the raw bytes and how many frames they took.

use wiretap_catalog::decode::Decoded;
use wiretap_catalog::modbus::{decode_rtu_message, exception_label, function_label};
use wiretap_catalog::{Catalog, ModbusRtuMessage};

/// One decoded tunnel message: the signals to merge into the frame's entry, and
/// the transaction record for the Modbus tab.
pub struct DecodedTunnelMessage {
    pub signals: Vec<Decoded>,
    pub transaction: serde_json::Value,
}

/// Render one reassembled message for the WS payload.
pub fn decode_message(msg: &ModbusRtuMessage, catalog: &Catalog) -> DecodedTunnelMessage {
    let d = decode_rtu_message(catalog, msg);

    // `registers` is register banks only, so it is already empty for a coil frame
    // and for a vendor code. `data` is the body either way, and the only route to
    // the payload of a function code nothing models.
    let transaction = serde_json::json!({
        "protocol": "modbus_rtu",
        "direction": msg.direction.as_str(),
        "device": msg.device_address,
        "function": msg.function,
        "functionLabel": function_label(msg.function),
        "register": msg.start_register,
        "quantity": msg.quantity,
        "values": msg.registers,
        "data": msg.data_block(),
        "exception": msg.exception,
        "exceptionLabel": msg.exception.map(exception_label),
        "frame": d.frame.map(|f| &f.key),
        "raw": msg.raw,
        "frames": msg.frame_count,
        // Only ever false under a lenient CRC policy, where the boundary came
        // from the length rules alone. It is what separates a recovered message
        // from a guessed one, so it has to reach the tab that shows them.
        "crcValid": msg.crc_valid,
    });

    DecodedTunnelMessage {
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

    #[test]
    fn a_coil_block_is_data_not_values() {
        let msgs = messages(&["0101000A000A", "010102D502"]);
        let out = decode_message(&msgs[0], &catalog());
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        let out = decode_message(&msgs[1], &catalog());
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        assert_eq!(out.transaction["data"].as_array().unwrap().len(), 2);

        for body in ["0105001AFF00", "0105001A0000"] {
            let msgs = messages(&[body]);
            let out = decode_message(&msgs[0], &catalog());
            assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        }
    }

    #[test]
    fn a_register_read_carries_its_values() {
        let msgs = messages(&["01044DE20002", "010404012C0000"]);
        let out = decode_message(msgs.last().unwrap(), &catalog());
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_vendor_message_reaches_the_tab_through_its_data_block() {
        let mut t = ModbusRtuStream::for_address(Some(1)).with_vendor_functions(&[0x20]);
        let msgs = t.push_bytes(&framed("012001C803111A0002"));
        assert_eq!(msgs.len(), 1);

        let out = decode_message(&msgs[0], &catalog());
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        let data: Vec<u64> = out.transaction["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(data, vec![0x01, 0xC8, 0x03, 0x11, 0x1A, 0x00, 0x02]);
        assert_eq!(out.transaction["functionLabel"], "0x20 Unknown");
    }

    #[test]
    fn a_transaction_names_its_frame_and_counts_its_can_frames() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "01040401F40000BB8A"]);
        assert_eq!(msgs.len(), 2);
        assert_eq!(decode_message(&msgs[0], &cat).transaction["frames"], 1);
        let d = decode_message(&msgs[1], &cat);
        assert_eq!(d.transaction["frame"], "charge_limits");
        assert_eq!(d.transaction["frames"], 2);

        // Holding registers, so the input-register catalogue entry must not match.
        let msgs = exchange(
            &cat,
            &["01034DE200067292", "01030C01F40000012C000000C80000D570"],
        );
        let d = decode_message(&msgs[1], &cat);
        assert!(d.transaction["frame"].is_null());
        assert_eq!(d.transaction["frames"], 3);
    }

    #[test]
    fn an_exception_response_is_labelled() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "018402C2C1"]);
        assert_eq!(msgs.len(), 2);
        let d = decode_message(&msgs[1], &cat);
        assert_eq!(d.transaction["exceptionLabel"], "0x02 Illegal Data Address");
    }
}
