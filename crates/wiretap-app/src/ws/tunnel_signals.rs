// Copyright 2026 Wired Square Pty Ltd

//! Turn a reassembled tunnel message into the shapes the Decoder already renders.
//!
//! `wiretap_catalog::modbus_rtu_stream` recovers the Modbus RTU message; this
//! decides what the Decoder *shows* for it. Two products per message:
//!
//! - **Signals**, so a tunnelled register lands in the signal table, graphs and
//!   dashboards like any other. Registers the catalogue describes decode
//!   through the ordinary [`wiretap_catalog::decode`] path — factor, offset,
//!   word order, enums, all of it — and uncatalogued ones fall back to raw
//!   values, so a tunnel is readable before anyone has mapped it.
//! - A **transaction** record for the Decoder's Modbus tab, carrying the raw
//!   reassembled bytes and how many frames they took.
//!
//! Request and response share one CAN id, so signals named the same on both
//! sides would overwrite each other in a store keyed by name. The synthesised
//! ones carry the direction in the name instead; register signals keep the
//! names the catalogue gave them, and only ever come from one side of a given
//! function code.

use wiretap_catalog::decode::Decoded;
use wiretap_catalog::modbus::{coils_to_bytes, exception_name, function_name};
use wiretap_catalog::{Catalog, Direction, ModbusRtuMessage, RegisterType, SignalFormat};

/// The code and its name; the crate owns the tables, this owns the presentation.
fn function_label(function: u8) -> String {
    let name = if function & 0x80 != 0 {
        "Exception"
    } else {
        function_name(function).unwrap_or("Unknown")
    };
    format!("0x{function:02X} {name}")
}

fn exception_label(code: u8) -> String {
    format!("0x{code:02X} {}", exception_name(code).unwrap_or("Unknown"))
}

/// Which bank a function code speaks to. Unmodelled codes fall to holding, which
/// is what the catalogue lookup below assumes when nothing else is known.
fn register_bank(function: u8) -> RegisterType {
    RegisterType::from_function_code(function).unwrap_or(RegisterType::Holding)
}

fn signal(name: String, value: f64, display: String, format: Option<SignalFormat>) -> Decoded {
    Decoded {
        name,
        value,
        scaled: value,
        display,
        unit: None,
        mux_value: None,
        format,
    }
}

/// The synthesised signals describing the message itself, named for the side
/// they came from so a request and its response can both be on screen.
fn header_signals(msg: &ModbusRtuMessage, function_label: &str) -> Vec<Decoded> {
    let side = match msg.direction {
        Direction::Request => "Request",
        Direction::Response => "Response",
    };
    let name = |field: &str| format!("Modbus_{side}_{field}");

    let mut out = vec![
        signal(
            name("Device"),
            f64::from(msg.device_address),
            msg.device_address.to_string(),
            None,
        ),
        signal(
            name("Function"),
            f64::from(msg.function),
            function_label.to_string(),
            Some(SignalFormat::Enum),
        ),
    ];
    if let Some(reg) = msg.start_register {
        out.push(signal(
            name("Register"),
            f64::from(reg),
            format!("0x{reg:04X}"),
            Some(SignalFormat::Hex),
        ));
    }
    if let Some(qty) = msg.quantity {
        out.push(signal(
            name("Quantity"),
            f64::from(qty),
            qty.to_string(),
            None,
        ));
    }
    if let Some(code) = msg.exception {
        out.push(signal(
            name("Exception"),
            f64::from(code),
            exception_label(code),
            Some(SignalFormat::Enum),
        ));
    }
    out
}

/// Decode a message's register block against the catalogue, falling back to raw
/// values. Returns the signals and the name of the register frame that matched.
fn register_signals(
    msg: &ModbusRtuMessage,
    catalog: &Catalog,
    bank: RegisterType,
    coils: &[bool],
) -> (Vec<Decoded>, Option<String>) {
    // The crate decides which kind of body this is: `registers` and `coils()` are
    // each empty for the other's banks. Coils are re-packed rather than taken
    // from `data_block()`, which for a single-coil write is the register address
    // followed by a flag word rather than a block — decoding that against a
    // catalogue entry would read the address as data.
    let bytes = if coils.is_empty() {
        msg.register_bytes()
    } else {
        coils_to_bytes(coils)
    };
    if bytes.is_empty() {
        return (Vec::new(), None);
    }
    let matched = msg
        .start_register
        .and_then(|reg| catalog.modbus_register_frame(reg, bank, msg.device_address));

    if let Some(frame) = matched {
        let decoded = wiretap_catalog::decode::decode_frame(catalog, frame, &bytes);
        if !decoded.signals.is_empty() {
            return (decoded.signals, Some(frame.key.clone()));
        }
    }

    // No catalogue entry, or one that decodes nothing — show the values
    // themselves so the tunnel is still readable.
    let side = match msg.direction {
        Direction::Request => "Request",
        Direction::Response => "Response",
    };
    let name = |i: usize| format!("Modbus_{side}_Value_{i}");
    let signals = if coils.is_empty() {
        msg.registers
            .iter()
            .enumerate()
            .map(|(i, &r)| {
                signal(
                    name(i),
                    f64::from(r),
                    format!("0x{r:04X}"),
                    Some(SignalFormat::Hex),
                )
            })
            .collect()
    } else {
        coils
            .iter()
            .enumerate()
            // Displayed as 0/1 rather than false/true, to match the numeric value
            // beside it and every other signal in the table.
            .map(|(i, &on)| {
                let bit = u8::from(on);
                signal(name(i), f64::from(bit), bit.to_string(), None)
            })
            .collect()
    };
    (signals, None)
}

/// One decoded tunnel message: the signals to merge into the frame's entry, and
/// the transaction record for the Modbus tab.
pub struct DecodedTunnelMessage {
    pub signals: Vec<Decoded>,
    pub transaction: serde_json::Value,
}

/// Render one reassembled message for the WS payload.
pub fn decode_message(msg: &ModbusRtuMessage, catalog: &Catalog) -> DecodedTunnelMessage {
    let label = function_label(msg.function);
    let coils = msg.coils();

    let mut signals = header_signals(msg, &label);
    let (register_signals, matched_frame) =
        register_signals(msg, catalog, register_bank(msg.function), &coils);
    signals.extend(register_signals);

    // `registers` is register banks only, so it is already empty for a coil frame
    // and for a vendor code. `data` is the body either way, and the only route to
    // the payload of a function code nothing models.
    let transaction = serde_json::json!({
        "protocol": "modbus_rtu",
        "direction": msg.direction.as_str(),
        "device": msg.device_address,
        "function": msg.function,
        "functionLabel": label,
        "register": msg.start_register,
        "quantity": msg.quantity,
        "values": msg.registers,
        "data": msg.data_block(),
        "exception": msg.exception,
        "exceptionLabel": msg.exception.map(exception_label),
        "frame": matched_frame,
        "raw": msg.raw,
        "frames": msg.frame_count,
        // Only ever false under a lenient CRC policy, where the boundary came
        // from the length rules alone. It is what separates a recovered message
        // from a guessed one, so it has to reach the tab that shows them.
        "crcValid": msg.crc_valid,
    });

    DecodedTunnelMessage {
        signals,
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

    /// Drive an exchange through one tunnel built from the catalogue's own
    /// declaration, chunked into 8-byte CAN payloads. One tunnel for the whole
    /// exchange on purpose — a response inherits its register address from the
    /// request that preceded it.
    fn exchange(catalog: &Catalog, messages: &[&str]) -> Vec<ModbusRtuMessage> {
        let declared = catalog.frame(0x1E0).unwrap().tunnel.as_ref().unwrap();
        let mut t = ModbusRtuStream::new(declared);
        let mut out = Vec::new();
        for hex in messages {
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            for chunk in bytes.chunks(8) {
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

    /// A message with its CRC appended, framed on its own.
    fn framed(hex: &str) -> Vec<u8> {
        let mut out: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        out.extend(wiretap_checksum::algorithms::crc16_modbus_checksum(&out).to_le_bytes());
        out
    }

    /// `exchange` appends no CRC, so build the pair here and feed them whole.
    fn messages(bodies: &[&str]) -> Vec<ModbusRtuMessage> {
        let mut t = ModbusRtuStream::for_address(Some(1));
        bodies
            .iter()
            .flat_map(|b| t.push_bytes(&framed(b)))
            .collect()
    }

    #[test]
    fn a_coil_response_reads_as_coils_not_registers() {
        // FC01: read 10 coils from 0. Two bytes, the second only partly used —
        // `registers` would pair them into one u16 and call it a register.
        let msgs = messages(&["0101000A000A", "010102D502"]);
        let response = msgs.last().unwrap();
        assert_eq!(response.function, 0x01);

        let out = decode_message(response, &catalog());
        let bit = |i: usize| display_of(&out.signals, &format!("Modbus_Response_Value_{i}"));
        // 0xD5 = 1010 1011 LSB-first, 0x02 = 0100 0000 LSB-first.
        assert_eq!(bit(0), "1");
        assert_eq!(bit(1), "0");
        assert_eq!(bit(2), "1");
        assert_eq!(bit(9), "1");
        // Bounded by the quantity the request asked for, not the byte count.
        assert!(!out
            .signals
            .iter()
            .any(|s| s.name == "Modbus_Response_Value_10"));
        // And not offered as registers, which is what they are not.
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        assert_eq!(out.transaction["data"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_coil_request_carries_no_coils() {
        // The regression this guards: a request's address and quantity bytes are
        // not a coil block, however much `data_block()` will hand them over.
        let msgs = messages(&["0101000A000A"]);
        let out = decode_message(&msgs[0], &catalog());
        assert!(!out.signals.iter().any(|s| s.name.contains("Value_")));
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_coil_frame_decodes_against_the_packed_block() {
        // The bytes handed to the catalogue are the coils re-packed, not
        // `data_block()`: for FC05 that block opens with the register address, so
        // decoding it directly would read the address as the coil data.
        let msgs = messages(&["0105001AFF00"]);
        let coils = msgs[0].coils();
        assert_eq!(coils, vec![true]);
        assert_eq!(
            wiretap_catalog::modbus::coils_to_bytes(&coils),
            vec![0x01],
            "one coil packs to one byte"
        );
        assert_eq!(
            msgs[0].data_block(),
            &hex_bytes("001AFF00")[..],
            "whereas the data block still carries the address"
        );
    }

    #[test]
    fn a_single_coil_write_is_one_coil() {
        // FC05 sets one coil with a flag word: 0xFF00 on, 0x0000 off. One coil,
        // not sixteen bits of a packed block and not a register.
        for (body, expected) in [("0105001AFF00", "1"), ("0105001A0000", "0")] {
            let msgs = messages(&[body]);
            let out = decode_message(&msgs[0], &catalog());
            assert_eq!(display_of(&out.signals, "Modbus_Request_Value_0"), expected);
            assert!(!out.signals.iter().any(|s| s.name.ends_with("_Value_1")));
            assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        }
    }

    #[test]
    fn a_register_read_is_unchanged() {
        let msgs = messages(&["01044DE20002", "010404012C0000"]);
        let out = decode_message(msgs.last().unwrap(), &catalog());
        // Decodes through the catalogue entry, factor and all.
        assert_eq!(display_of(&out.signals, "Charge_Current_Limit"), "30");
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn a_vendor_message_reaches_the_tab_through_its_data_block() {
        let mut t = ModbusRtuStream::for_address(Some(1)).with_vendor_functions(&[0x20]);
        let msgs = t.push_bytes(&framed("012001C803111A0002"));
        assert_eq!(msgs.len(), 1);

        let out = decode_message(&msgs[0], &catalog());
        // Nothing models the body, so there are no values and no register signals.
        assert!(msgs[0].registers.is_empty());
        assert_eq!(out.transaction["values"].as_array().unwrap().len(), 0);
        // The body is still reachable, which is the whole point.
        let data: Vec<u64> = out.transaction["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert_eq!(data, vec![0x01, 0xC8, 0x03, 0x11, 0x1A, 0x00, 0x02]);
        assert_eq!(out.transaction["functionLabel"], "0x20 Unknown");
    }

    fn display_of(signals: &[Decoded], name: &str) -> String {
        signals
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("no signal {name}"))
            .display
            .clone()
    }

    #[test]
    fn request_decodes_to_header_signals() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691"]);
        let d = decode_message(&msgs[0], &cat);
        assert_eq!(
            display_of(&d.signals, "Modbus_Request_Function"),
            "0x04 Read Input Registers"
        );
        assert_eq!(display_of(&d.signals, "Modbus_Request_Register"), "0x4DE2");
        assert_eq!(display_of(&d.signals, "Modbus_Request_Quantity"), "2");
        assert_eq!(d.transaction["frames"], 1);
    }

    #[test]
    fn response_registers_decode_through_the_catalogue() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "01040401F40000BB8A"]);
        assert_eq!(msgs.len(), 2);

        let d = decode_message(&msgs[1], &cat);
        // 500 * 0.1 = 50 A, via the ordinary decode path.
        assert_eq!(display_of(&d.signals, "Charge_Current_Limit"), "50");
        assert_eq!(d.transaction["frame"], "charge_limits");
        assert_eq!(d.transaction["frames"], 2);
    }

    #[test]
    fn request_and_response_signals_do_not_collide() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "01040401F40000BB8A"]);
        let req: Vec<String> = decode_message(&msgs[0], &cat)
            .signals
            .iter()
            .map(|s| s.name.clone())
            .collect();
        let rsp = decode_message(&msgs[1], &cat).signals;
        // Both sides land in a store keyed by signal name, so no name may
        // appear on both — the response would silently replace the request.
        assert!(rsp.iter().all(|s| !req.contains(&s.name)), "{req:?}");
        // And none of them fakes a mux, which the signal table would render as
        // a mux group with the wrong payload bytes.
        assert!(rsp.iter().all(|s| s.mux_value.is_none()));
    }

    #[test]
    fn an_uncatalogued_register_falls_back_to_raw_values() {
        let cat = catalog();
        // Holding registers, so the input-register catalogue entry must not match.
        let msgs = exchange(
            &cat,
            &["01034DE200067292", "01030C01F40000012C000000C80000D570"],
        );
        let d = decode_message(&msgs[1], &cat);
        assert_eq!(display_of(&d.signals, "Modbus_Response_Value_0"), "0x01F4");
        assert_eq!(display_of(&d.signals, "Modbus_Response_Value_2"), "0x012C");
        assert!(d.transaction["frame"].is_null());
        assert_eq!(d.transaction["frames"], 3);
    }

    #[test]
    fn an_exception_response_is_labelled() {
        let cat = catalog();
        let msgs = exchange(&cat, &["01044DE20002C691", "018402C2C1"]);
        assert_eq!(msgs.len(), 2);
        let d = decode_message(&msgs[1], &cat);
        assert_eq!(
            display_of(&d.signals, "Modbus_Response_Exception"),
            "0x02 Illegal Data Address"
        );
        assert_eq!(d.transaction["exceptionLabel"], "0x02 Illegal Data Address");
        // The exception answers the request, so it names the register that failed.
        assert_eq!(display_of(&d.signals, "Modbus_Response_Register"), "0x4DE2");
    }
}
