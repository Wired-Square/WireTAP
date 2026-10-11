// crates/wiretap-app/src/decode_views.rs
//
// Thin commands over `wiretap_decode`'s readings: the Frame Calculator's groups,
// a Modbus scan's registers and the ids a CAN filter mask accepts.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wiretap_decode::frame_id::{matched_id_count, matched_range, MatchedRange};
use wiretap_decode::groups::{decode_groups, parse_sizes, Group, GroupMode, GroupOrder};
use wiretap_decode::register::{interpret_pair, interpret_register, RegisterPairView, RegisterView};
use wiretap_decode::Endianness;

/// A preset, or the widths typed into the calculator in a unit of bits.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum Grouping {
    Preset(GroupMode),
    Typed {
        text: String,
        #[serde(rename = "unitBits")]
        unit_bits: u32,
    },
}

#[tauri::command(rename_all = "snake_case")]
pub fn decode_groups_cmd(bytes: Vec<u8>, grouping: Grouping, order: GroupOrder) -> Vec<Group> {
    let mode = match grouping {
        Grouping::Preset(mode) => mode,
        Grouping::Typed { text, unit_bits } => GroupMode::Custom(parse_sizes(&text, unit_bits)),
    };
    decode_groups(&bytes, &mode, order)
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RegisterRead {
    pub address: u32,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RegisterReading {
    pub register: RegisterView,
    /// With the next address as its low or high word, when the scan found it.
    pub pair: Option<RegisterPairView>,
}

#[tauri::command(rename_all = "snake_case")]
pub fn interpret_registers_cmd(registers: Vec<RegisterRead>, word_order: Endianness) -> Vec<RegisterReading> {
    let by_address: HashMap<u32, &[u8]> = registers.iter().map(|r| (r.address, r.bytes.as_slice())).collect();
    registers
        .iter()
        .map(|r| RegisterReading {
            register: interpret_register(&r.bytes),
            pair: r
                .address
                .checked_add(1)
                .and_then(|next| by_address.get(&next))
                .map(|next| interpret_pair(&r.bytes, next, word_order)),
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct MaskMatch {
    pub count: u64,
    pub range: MatchedRange,
}

#[tauri::command(rename_all = "snake_case")]
pub fn can_mask_match_cmd(id: u32, mask: u32, width: u32) -> MaskMatch {
    MaskMatch { count: matched_id_count(mask, width), range: matched_range(id, mask, width) }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::{json, Value};

    use super::*;
    use crate::small_twin_tables::fixture;

    fn from<T: serde::de::DeserializeOwned>(v: &Value) -> T {
        serde_json::from_value(v.clone()).unwrap()
    }

    /// wiretap-decode's D6 case 1, a 1B mid-* group naming the byte its value came from.
    const ONE_BYTE_MID: &[&str] = &[
        "1B mid-big 12 mixed",
        "1B mid-big 123456789abcdef0",
        "1B mid-big 16 ascii+control",
        "1B mid-big 7fff",
        "1B mid-big 800000",
        "1B mid-big 80017f",
        "1B mid-big 8x 00",
        "1B mid-big 8x ff",
        "1B mid-big e808",
        "1B mid-big Hello",
        "1B mid-little 12 mixed",
        "1B mid-little 123456789abcdef0",
        "1B mid-little 16 ascii+control",
        "1B mid-little 800000",
        "1B mid-little 80017f",
        "1B mid-little 8x 00",
        "1B mid-little 8x ff",
        "1B mid-little Hello",
    ];

    /// D6 case 4, a big custom group's display bytes and text covering every byte its bits touch.
    const BIG_CUSTOM_SPAN: &[&str] = &[
        "custom-bits [1,7,12] big 12 mixed",
        "custom-bits [1,7,12] big 123456789abcdef0",
        "custom-bits [1,7,12] big 16 ascii+control",
        "custom-bits [1,7,12] big Hello",
        "custom-bits [3,8] big 12 mixed",
        "custom-bits [3,8] big 123456789abcdef0",
        "custom-bits [3,8] big 16 ascii+control",
        "custom-bits [3,8] big 80017f",
        "custom-bits [3,8] big e808",
        "custom-bits [3,8] big Hello",
        "custom-bits [3] big 123456789abcdef0",
        "custom-bits [3] big 80017f",
        "custom-bits [3] big e808",
        "custom-bits [3] big Hello",
    ];

    /// The fields of `got` that differ from `expected`, group by group.
    fn changed(got: &[Value], expected: &[Value]) -> BTreeSet<String> {
        assert_eq!(got.len(), expected.len());
        got.iter()
            .zip(expected)
            .flat_map(|(g, e)| {
                g.as_object().unwrap().iter().filter(|(k, v)| e[k.as_str()] != **v).map(|(k, _)| k.clone())
            })
            .collect()
    }

    #[test]
    fn the_calculator_matches_its_golden_but_the_libs_d6_fixes() {
        let golden = fixture("calculatorGolden.json");
        let cases = golden.as_array().unwrap();
        assert_eq!(cases.len(), 820);
        let (mut mid_custom, mut mid_custom_changed) = (0, 0);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let text = case["customInput"].as_str().unwrap().to_string();
            let grouping = match case["mode"].as_str().unwrap() {
                "custom-bits" => Grouping::Typed { text, unit_bits: 1 },
                "custom-bytes" => Grouping::Typed { text, unit_bits: 8 },
                _ => Grouping::Preset(from(&case["mode"])),
            };
            let custom = matches!(grouping, Grouping::Typed { .. });
            let got: Vec<Value> = decode_groups_cmd(from(&case["bytes"]), grouping, from(&case["endianness"]))
                .iter()
                .map(|g| serde_json::to_value(g).unwrap())
                .collect();
            let expected: Vec<Value> = from(&case["groups"]);
            let fields = changed(&got, &expected);
            let allowed: &[&str] = if ONE_BYTE_MID.contains(&name) {
                &["displayHex", "startByteIndex", "usedBitStart", "usedBitEnd", "bitOffset"]
            } else if BIG_CUSTOM_SPAN.contains(&name) {
                &["displayHex", "text"]
            } else if custom && name.contains(" mid-") {
                mid_custom += 1;
                mid_custom_changed += usize::from(!fields.is_empty());
                continue;
            } else {
                assert!(fields.is_empty(), "{name} changes {fields:?}");
                continue;
            };
            assert!(!fields.is_empty(), "{name} no longer differs from the golden");
            assert!(fields.iter().all(|f| allowed.contains(&f.as_str())), "{name} changes {fields:?}");
        }
        assert_eq!((mid_custom, mid_custom_changed), (278, 206));
    }

    #[test]
    fn a_grouping_is_a_preset_or_typed_widths() {
        let typed: Grouping = from(&json!({ "text": "4,4", "unitBits": 8 }));
        let groups = decode_groups_cmd(vec![0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], typed, GroupOrder::MidBig);
        let hexes: Vec<_> = groups.iter().map(|g| g.hex.as_str()).collect();
        assert_eq!(hexes, ["0x34127856", "0xbc9af0de"]);
        assert!(matches!(from::<Grouping>(&json!("2B")), Grouping::Preset(GroupMode::TwoBytes)));
    }

    fn reading(registers: &[(u32, &[u8])], word_order: Endianness) -> Vec<Value> {
        let reads = registers.iter().map(|&(address, bytes)| RegisterRead { address, bytes: bytes.to_vec() }).collect();
        interpret_registers_cmd(reads, word_order).iter().map(|r| serde_json::to_value(r).unwrap()).collect()
    }

    /// The golden spells a non-finite f32 as the pair does, and negative zero as `"-0"`.
    fn f32_matches(got: &Value, expected: &Value) -> bool {
        match expected.as_str() {
            Some("NaN" | "Infinity" | "-Infinity") => got == expected,
            Some("-0") => got.as_f64().is_some_and(|f| f == 0.0 && f.is_sign_negative()),
            Some(other) => panic!("no f32 spelt {other}"),
            None => got.as_f64().map(|f| f as f32) == expected.as_f64().map(|f| f as f32),
        }
    }

    #[test]
    fn register_readings_match_their_golden() {
        let golden = fixture("modbusValuesGolden.json");
        let cases = golden["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 60);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let (input, expected) = (&case["input"], &case["expected"]);
            if name.starts_with("interpretRegister") {
                let bytes: Vec<u8> = from(input);
                let got = reading(&[(7, &bytes)], Endianness::Big);
                assert_eq!(got[0]["register"], *expected, "{name}");
                assert!(got[0]["pair"].is_null(), "{name}");
                continue;
            }
            let order = input.get("order").map_or(Endianness::Big, from);
            let (first, second): (Vec<u8>, Vec<u8>) = (from(&input["first"]), from(&input["second"]));
            let got = reading(&[(40, &first), (41, &second)], order);
            let pair = &got[0]["pair"];
            assert_eq!((&pair["u32"], &pair["s32"]), (&expected["u32"], &expected["s32"]), "{name}");
            assert!(f32_matches(&pair["f32"], &expected["f32"]), "{name}: {} against {}", pair["f32"], expected["f32"]);
            assert!(got[1]["pair"].is_null(), "{name}");
        }
    }

    #[test]
    fn the_scan_tables_ts_column_is_the_commands_answer() {
        for row in crate::small_twin_tables::rows("modbusWords.json") {
            let (first, second): (Vec<u8>, Vec<u8>) = (from(&row["first"]), from(&row["second"]));
            let got = reading(&[(0, &first), (1, &second)], from(&row["word_order"]));
            let (register, pair) = (&got[0]["register"], &got[0]["pair"]);
            let ts = &row["ts"];
            assert_eq!((&register["u16"], &register["s16"]), (&ts["u16"], &ts["s16"]), "{row}");
            assert_eq!((&pair["u32"], &pair["s32"]), (&ts["u32"], &ts["s32"]), "{row}");
            assert_eq!(pair["f32"].as_f64().map(|f| f as f32), ts["f32"].as_f64().map(|f| f as f32), "{row}");
        }
    }

    #[test]
    fn can_mask_matches_match_their_golden() {
        let golden = fixture("canMaskGolden.json");
        let cases = golden["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 133);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let input = &case["input"];
            let field = |key: &str| from::<u32>(&input[key]);
            match name.split(' ').next().unwrap() {
                "matchedIdCount" => {
                    let got = can_mask_match_cmd(0, field("mask"), field("bitWidth")).count;
                    assert_eq!(json!(got), case["expected"], "{name}");
                }
                "matchedRange" => {
                    let got = can_mask_match_cmd(field("id"), field("mask"), field("bitWidth")).range;
                    assert_eq!(serde_json::to_value(got).unwrap(), case["expected"], "{name}");
                }
                // The set bits of TypeScript's `value >>> 0`, as the ids a 32-bit mask pins.
                "popcount" => {
                    let mask = input.as_i64().unwrap() as u32;
                    let free = 32 - case["expected"].as_u64().unwrap();
                    assert_eq!(can_mask_match_cmd(0, mask, 32).count, 1u64 << free, "{name}");
                }
                other => panic!("{name}: no function {other}"),
            }
        }
    }
}
