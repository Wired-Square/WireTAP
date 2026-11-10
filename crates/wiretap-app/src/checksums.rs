// ui/crates/wiretap-app/src/checksums.rs
//
// The frontend's door to `wslib-checksum`. The algorithms, the candidate
// sweep, the scoring and the notes all live in the crate — a catalogue's
// checksum config is a catalogue concern, and keeping one implementation is
// what stopped the serial dialog and the Serial Payload tool disagreeing about
// the same bytes. What is left here is the Tauri surface: argument shapes,
// wire types, and the string-to-enum parse the frontend needs.

use serde::Serialize;
use std::str::FromStr;

use wslib_checksum::{
    calculate_checksum, calculated_range, detect_checksum, extract_checksum, resolve_byte_index,
    sweep_specs, validate_checksum, ChecksumAlgorithm, ChecksumDetectionOptions,
    ChecksumDetectionResult, ChecksumSpec, ChecksumSpecResult, ChecksumValidationResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChecksumSweepResponse {
    pub results: Vec<ChecksumSpecResult>,
}

/// Calculate a checksum over a byte range.
///
/// `algorithm` is a catalogue id ("xor", "sum8", "crc16_modbus", …); offsets
/// support negative indexing.
#[tauri::command]
pub fn calculate_checksum_cmd(
    algorithm: String,
    data: Vec<u8>,
    calc_start_byte: i32,
    calc_end_byte: i32,
) -> Result<u16, String> {
    let algo = ChecksumAlgorithm::from_str(&algorithm)?;
    Ok(calculate_checksum(algo, &data, calc_start_byte, calc_end_byte))
}

/// Check a frame's stored checksum against a freshly calculated one.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn validate_checksum_cmd(
    algorithm: String,
    data: Vec<u8>,
    start_byte: i32,
    byte_length: usize,
    big_endian: bool,
    calc_start_byte: i32,
    calc_end_byte: i32,
) -> Result<ChecksumValidationResult, String> {
    let algo = ChecksumAlgorithm::from_str(&algorithm)?;
    Ok(validate_checksum(
        algo,
        &data,
        start_byte,
        byte_length,
        big_endian,
        calc_start_byte,
        calc_end_byte,
    ))
}

/// Check a frame against its serial catalogue's `[meta.serial.checksum]`.
/// `None` when the declaration is not coherent enough to evaluate.
pub fn validate_serial_checksum(
    config: &wslib_wiretap_catalogue::model::FrameChecksum,
    data: &[u8],
) -> Option<ChecksumValidationResult> {
    let specification = config.specification()?;
    let byte_length = config.byte_length as usize;
    let big_endian = config.endianness == Some(wslib_wiretap_catalogue::Endianness::Big);
    let range = calculated_range(
        data.len(),
        config.start_byte,
        byte_length,
        config.calc_start_byte,
        // Absent stops short of the last byte, as the Decoder has always read it.
        config.calc_end_byte.unwrap_or(-1),
    );
    let extracted = extract_checksum(data, config.start_byte, byte_length, big_endian).unwrap_or(0);
    let calculated = range.clone().map_or(0, |r| specification.calculate(&data[r]));
    Some(ChecksumValidationResult {
        extracted,
        calculated,
        valid: range.is_some() && extracted == calculated,
    })
}

/// Each index resolved against each frame length, one row per length; a
/// negative index counts from the end (-1 = last byte).
#[tauri::command(rename_all = "snake_case")]
pub fn resolve_byte_indices(indices: Vec<i32>, frame_lengths: Vec<usize>) -> Vec<Vec<usize>> {
    frame_lengths
        .iter()
        .map(|&length| indices.iter().map(|&index| resolve_byte_index(index, length)).collect())
        .collect()
}

/// Rank the checksum configurations that explain a set of frames.
#[tauri::command]
pub fn detect_checksum_cmd(
    frames: Vec<Vec<u8>>,
    options: Option<ChecksumDetectionOptions>,
) -> ChecksumDetectionResult {
    detect_checksum(&frames, &options.unwrap_or_default())
}

/// Check specific checksum configurations against frames.
///
/// Used for the live match rate behind a hand-edited configuration, where the
/// caller has one spec rather than a space to search.
#[tauri::command]
pub fn sweep_checksum_specs_cmd(
    frames: Vec<Vec<u8>>,
    specs: Vec<ChecksumSpec>,
) -> ChecksumSweepResponse {
    ChecksumSweepResponse {
        results: sweep_specs(&frames, &specs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use wslib_checksum::ALL_NOTES;

    /// The TypeScript copy this replaced clamped the same way: past the start lands on byte 0.
    #[test]
    fn byte_indices_resolve_from_the_end_against_each_length() {
        assert_eq!(
            resolve_byte_indices(vec![0, 3, -1, -2, -8, -9], vec![8, 1, 0]),
            [vec![0, 3, 7, 6, 0, 0], vec![0, 3, 0, 0, 0, 0], vec![0, 3, 0, 0, 0, 0]]
        );
    }

    /// Rust decides *what* the checksum detector says; the frontend decides how.
    ///
    /// Notes cross as `{ code, values }` so the prose stays translatable, which
    /// means the two halves are joined by a string rather than by a type. A code
    /// with no key renders as the raw key to the user, and a renamed
    /// interpolation variable silently drops a value — neither is a compile
    /// error.
    ///
    /// This used to be a vitest suite parsing `checksums.rs?raw`. The engine now
    /// lives in another repository where Vite cannot reach it, so the pin moved
    /// here, where both the crate's `ALL_NOTES` manifest and the locale file are
    /// in scope.
    mod note_coverage {
        use super::*;

        fn translations() -> serde_json::Map<String, serde_json::Value> {
            let locale: serde_json::Value =
                serde_json::from_str(include_str!("../../../frontend/wiretap-ui/src/locales/en-AU/discovery.json"))
                    .expect("discovery.json parses");
            locale["serial"]["checksumNote"]
                .as_object()
                .expect("serial.checksumNote is an object")
                .clone()
        }

        /// `{{name}}` placeholders in a translation string.
        fn placeholders(text: &str) -> BTreeSet<String> {
            text.split("{{")
                .skip(1)
                .filter_map(|rest| rest.split_once("}}"))
                .map(|(name, _)| name.trim().to_string())
                .collect()
        }

        #[test]
        fn every_code_the_engine_emits_has_a_translation() {
            let notes = translations();
            let missing: Vec<&str> = ALL_NOTES
                .iter()
                .map(|n| n.code)
                .filter(|code| !notes.contains_key(*code))
                .collect();

            assert_eq!(missing, Vec::<&str>::new());
        }

        #[test]
        fn no_translation_exists_for_a_code_nothing_emits() {
            let notes = translations();
            let orphaned: Vec<&String> = notes
                .keys()
                .filter(|key| !ALL_NOTES.iter().any(|n| n.code == key.as_str()))
                .collect();

            assert_eq!(orphaned, Vec::<&String>::new());
        }

        #[test]
        fn translations_interpolate_exactly_the_values_the_engine_sends() {
            let notes = translations();
            let mismatched: Vec<String> = ALL_NOTES
                .iter()
                .filter_map(|note| {
                    let text = notes.get(note.code)?.as_str()?;
                    let used = placeholders(text);
                    let sent: BTreeSet<String> =
                        note.values.iter().map(|v| (*v).to_string()).collect();

                    (used != sent).then(|| {
                        format!(
                            "{}: engine sends {sent:?}, translation uses {used:?}",
                            note.code
                        )
                    })
                })
                .collect();

            assert_eq!(mismatched, Vec::<String>::new());
        }
    }

    /// The table the generated `CHECKSUM_OUTPUT_BYTES` is checked against.
    #[test]
    fn algorithm_widths_match_the_rule_table() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../frontend/wiretap-ui/src/tests/fixtures/catalog/checksumAlgorithms.json"
        ))
        .expect("table");
        let rows = table["algorithms"].as_array().expect("algorithms");
        let ids: Vec<&str> = rows.iter().map(|row| row["id"].as_str().expect("id")).collect();
        assert_eq!(ids, wslib_checksum::all_algorithm_ids());
        for (id, row) in ids.iter().zip(rows) {
            let width = ChecksumAlgorithm::from_str(id).ok().map(|a| a.output_bytes() as u64);
            assert_eq!(width, row["bytes"].as_u64(), "{id}");
        }
    }

    #[test]
    fn an_unknown_algorithm_name_is_an_error_not_a_default() {
        assert!(calculate_checksum_cmd("nope".into(), vec![1, 2], 0, -1).is_err());
        assert_eq!(
            calculate_checksum_cmd("sum8".into(), vec![1, 2, 0], 0, -1),
            Ok(0x03)
        );
    }

    mod serial_level_checksum {
        use super::*;
        use wslib_wiretap_catalogue::model::{ChecksumParameters, FrameChecksum};
        use wslib_wiretap_catalogue::Endianness;

        fn declared(algorithm: &str, start_byte: i32, byte_length: u32) -> FrameChecksum {
            FrameChecksum {
                name: None,
                algorithm: algorithm.into(),
                start_byte,
                byte_length,
                endianness: None,
                calc_start_byte: 0,
                calc_end_byte: None,
                parameters: ChecksumParameters::default(),
                notes: Vec::new(),
            }
        }

        fn verdicts(config: &FrameChecksum, good: &[u8]) -> (Option<bool>, Option<bool>) {
            let mut corrupted = good.to_vec();
            corrupted[0] ^= 0x01;
            (
                validate_serial_checksum(config, good).map(|r| r.valid),
                validate_serial_checksum(config, &corrupted).map(|r| r.valid),
            )
        }

        #[test]
        fn a_custom_crc_is_verified_with_its_parameters() {
            let config = FrameChecksum {
                endianness: Some(Endianness::Big),
                calc_end_byte: Some(-2),
                parameters: ChecksumParameters {
                    polynomial: Some(0x1021),
                    init: Some(0x1D0F),
                    xor_out: Some(0),
                    reflect_in: Some(false),
                    reflect_out: Some(false),
                    offset: None,
                },
                ..declared(wslib_checksum::CRC_CUSTOM, -2, 2)
            };
            let frame = [b"123456789".as_slice(), &[0xE5, 0xCC]].concat();
            assert_eq!(verdicts(&config, &frame), (Some(true), Some(false)));
        }

        #[test]
        fn a_negated_sum_is_verified() {
            let config = declared(wslib_checksum::SUM8_NEGATED, -1, 1);
            assert_eq!(verdicts(&config, &[1, 2, 3, 250]), (Some(true), Some(false)));
        }

        #[test]
        fn an_absent_calc_end_stops_short_of_the_last_byte() {
            assert_eq!(verdicts(&declared("xor", -1, 1), &[1, 2, 4, 7]), (Some(true), Some(false)));
        }

        #[test]
        fn a_named_two_byte_checksum_without_endianness_reads_little_endian() {
            let config = FrameChecksum {
                calc_end_byte: Some(-2),
                ..declared("crc16_modbus", -2, 2)
            };
            let mut frame = vec![1, 2, 3];
            let crc =
                wslib_checksum::calculate_checksum_simple(ChecksumAlgorithm::Crc16Modbus, &frame);
            frame.extend_from_slice(&crc.to_le_bytes());
            assert_eq!(verdicts(&config, &frame), (Some(true), Some(false)));
        }

        #[test]
        fn an_unknown_algorithm_gets_no_verdict() {
            assert_eq!(verdicts(&declared("crc99", -1, 1), &[1, 2, 3]), (None, None));
        }
    }
}
