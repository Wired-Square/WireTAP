// ui/crates/wiretap-app/src/checksums.rs
//
// The frontend's door to `wiretap-checksum`. The algorithms, the candidate
// sweep, the scoring and the notes all live in the crate — a catalogue's
// checksum config is a catalogue concern, and keeping one implementation is
// what stopped the serial dialog and the Serial Payload tool disagreeing about
// the same bytes. What is left here is the Tauri surface: argument shapes,
// wire types, and the string-to-enum parse the frontend needs.

use serde::Serialize;
use std::str::FromStr;

use wiretap_checksum::{
    calculate_checksum, detect_checksum, resolve_byte_index, sweep_specs, validate_checksum,
    ChecksumAlgorithm, ChecksumDetectionOptions, ChecksumDetectionResult, ChecksumSpec,
    ChecksumSpecResult, ChecksumValidationResult,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

/// Resolve a byte index, supporting negative indexing (-1 = last byte).
#[tauri::command]
pub fn resolve_byte_index_cmd(index: i32, frame_length: usize) -> usize {
    resolve_byte_index(index, frame_length)
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
    use wiretap_checksum::ALL_NOTES;

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

    #[test]
    fn an_unknown_algorithm_name_is_an_error_not_a_default() {
        assert!(calculate_checksum_cmd("nope".into(), vec![1, 2], 0, -1).is_err());
        assert_eq!(
            calculate_checksum_cmd("sum8".into(), vec![1, 2, 0], 0, -1),
            Ok(0x03)
        );
    }
}
