//! The `rust` column of P5's small-twin rule tables, which the TypeScript's
//! `smallTwinsRuleTables.test.tsx` checks its own column of.

use framelink::protocol::{frame_def, types::interface_name};
use serde_json::Value;
use wiretap_decode::{extract_field, BitOrder, Endianness};
use wiretap_protocol::dlc::{dlc_to_len, len_to_dlc};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/tests/fixtures/data");

pub(crate) fn rows(file: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(format!("{FIXTURES}/{file}")).expect("fixture");
    let table: Value = serde_json::from_str(&text).expect("json");
    table["rows"].as_array().expect("rows").clone()
}

fn uint(v: &Value) -> u64 {
    v.as_u64().expect("unsigned")
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array().expect("bytes").iter().map(|b| uint(b) as u8).collect()
}

#[test]
fn framelink_bit_positions_match_the_rule_table() {
    for row in rows("framelinkBitPositions.json") {
        let positions = frame_def::signal_bit_positions(
            uint(&row["start_bit"]) as u16,
            uint(&row["bit_length"]) as u16,
            uint(&row["byte_order"]) as u8,
        );
        let expected: Vec<u16> = row["positions"].as_array().unwrap().iter().map(|p| uint(p) as u16).collect();
        assert_eq!(positions, expected, "{row}");
    }
}

#[test]
fn interface_type_names_match_the_rule_table() {
    for row in rows("interfaceTypeNames.json") {
        assert_eq!(interface_name(uint(&row["interface_type"]) as u8), row["rust"], "{row}");
    }
}

#[test]
fn can_fd_lengths_match_the_rule_table() {
    for row in rows("canFdDlc.json") {
        let len = uint(&row["length"]) as usize;
        assert_eq!(dlc_to_len(len_to_dlc(len), true) == len, row["rust"].as_bool().unwrap(), "{row}");
    }
}

#[test]
fn modbus_register_words_match_the_rule_table() {
    let read = |data: &[u8], bits: u32, word_order: Option<Endianness>, signed: bool| {
        let order = BitOrder::Registers { endianness: Endianness::Big, word_order };
        extract_field(data, 0, bits, order, signed)
    };
    for row in rows("modbusWords.json") {
        let first = bytes(&row["first"]);
        let pair = [first.clone(), bytes(&row["second"])].concat();
        let word_order = Some(if row["word_order"] == "little" { Endianness::Little } else { Endianness::Big });
        let rust = &row["rust"];
        assert_eq!(read(&first, 16, None, false), rust["u16"].as_f64().unwrap(), "{row}");
        assert_eq!(read(&first, 16, None, true), rust["s16"].as_f64().unwrap(), "{row}");
        assert_eq!(read(&pair, 32, word_order, false), rust["u32"].as_f64().unwrap(), "{row}");
        assert_eq!(read(&pair, 32, word_order, true), rust["s32"].as_f64().unwrap(), "{row}");
    }
}
