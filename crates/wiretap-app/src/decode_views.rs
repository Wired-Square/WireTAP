// crates/wiretap-app/src/decode_views.rs
//
// Thin commands over `wiretap_decode`'s readings: the ids a CAN filter mask
// accepts.

use serde::Serialize;
use wiretap_decode::frame_id::{matched_id_count, matched_range, MatchedRange};

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
    use serde_json::{json, Value};

    use super::*;
    use crate::small_twin_tables::fixture;

    fn from<T: serde::de::DeserializeOwned>(v: &Value) -> T {
        serde_json::from_value(v.clone()).unwrap()
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
