// Copyright 2026 Wired Square Pty Ltd

//! Which framing a raw serial byte stream is using.
//!
//! The scoring is `wiretap_catalog::framing_detect`'s, framing RTU with the
//! session's catalogue as live does; this module reads the bytes straight from
//! the capture store and words the library's evidence for the frontend.

// ============================================================================
// iOS stub - serial framing not available
// ============================================================================

#[cfg(target_os = "ios")]
mod ios_stub {
    /// Untyped, deliberately: the command only ever errors here, and a stub
    /// struct mirroring the desktop shape is one more thing to keep in step.
    #[tauri::command(rename_all = "snake_case")]
    pub fn detect_serial_framing(
        _capture_id: String,
        _sample_bytes: Option<usize>,
        _modbus: Option<serde_json::Value>,
        _session_id: Option<String>,
    ) -> Result<serde_json::Value, String> {
        Err("Framing detection is not available on iOS".to_string())
    }
}

#[cfg(target_os = "ios")]
pub use ios_stub::*;

// ============================================================================
// Desktop implementation
// ============================================================================

#[cfg(not(target_os = "ios"))]
mod desktop {
    use serde::Serialize;
    use wiretap_catalog::framing_detect::{self, Candidate, Evidence, Framing};

    use crate::capture_store;
    use crate::io::{FramingMode, ModbusRtuOptions};

    /// How much of the tail to analyse. Matches what the frontend used to fetch.
    const DEFAULT_SAMPLE_BYTES: usize = 100_000;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FramingCandidate {
        pub mode: FramingMode,
        pub confidence: i32,
        pub notes: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub delimiter: Option<Vec<u8>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub delimiter_hex: Option<String>,
        pub estimated_frame_count: usize,
        pub avg_frame_length: usize,
        pub min_frame_length: usize,
        pub max_frame_length: usize,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FramingDetectionResult {
        pub byte_count: usize,
        pub candidates: Vec<FramingCandidate>,
        pub best_candidate: Option<FramingCandidate>,
        pub notes: Vec<String>,
        /// Function codes the Modbus arm could not frame, commonest first.
        /// Declaring these as vendor codes is what makes such a line readable.
        pub unframed_functions: Vec<u8>,
        /// Address-0 messages it could not frame because broadcast was not allowed.
        pub unframed_broadcasts: usize,
        /// Declared function codes their own length rules keep rejecting.
        pub rejected_functions: Vec<u8>,
    }

    fn hex_codes(codes: &[u8]) -> String {
        codes
            .iter()
            .map(|f| format!("0x{f:02X}"))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn note(evidence: &Evidence, framing: &Framing) -> Option<String> {
        Some(match evidence {
            Evidence::SlipEscapes(n) => format!("Found {n} SLIP escape sequences"),
            Evidence::SlipEndsInData => {
                "0xC0 appears frequently within frames - may include data bytes".to_string()
            }
            Evidence::SlipFrames(n) => format!("{n} frames decoded"),
            Evidence::ConsistentSizes => "Consistent frame sizes".to_string(),
            Evidence::CrcCoverage(fraction) => {
                format!("{:.0}% of bytes in valid frames", fraction * 100.0)
            }
            Evidence::DeviceAddresses(n) => {
                let plural = if *n == 1 { "" } else { "es" };
                format!("{n} unique device address{plural}")
            }
            Evidence::CrcFrames(n) => format!("{n} valid CRC frames found"),
            Evidence::UnframedFunctions(codes) => format!(
                "Unframed function codes: {} — declare them as vendor codes",
                hex_codes(codes)
            ),
            Evidence::UnframedBroadcasts(n) => {
                format!("{n} unframed broadcast messages (address 0) — allow broadcast")
            }
            Evidence::RejectedFunctions(codes) => format!(
                "Declared function codes rejected by their length rules: {} — check the catalogue",
                hex_codes(codes)
            ),
            Evidence::AsciiText => "Data appears to be ASCII text".to_string(),
            Evidence::DelimiterFrames(n) => match framing {
                Framing::Delimiter { name, .. } => format!("{name} delimiter: {n} frames"),
                _ => return None,
            },
            _ => return None,
        })
    }

    fn to_candidate(c: &Candidate) -> Option<FramingCandidate> {
        let (mode, delimiter) = match &c.framing {
            Framing::Slip => (FramingMode::Slip, None),
            Framing::ModbusRtu => (FramingMode::ModbusRtu, None),
            Framing::Delimiter { delimiter, .. } => (FramingMode::Delimiter, Some(delimiter.to_vec())),
            _ => return None,
        };
        Some(FramingCandidate {
            mode,
            confidence: c.confidence.into(),
            notes: c
                .evidence
                .iter()
                .filter_map(|e| note(e, &c.framing))
                .collect(),
            delimiter_hex: delimiter
                .as_ref()
                .map(|d| d.iter().map(|b| format!("{b:02X}")).collect()),
            delimiter,
            estimated_frame_count: c.frames.count,
            avg_frame_length: c.frames.avg.round() as usize,
            min_frame_length: c.frames.min,
            max_frame_length: c.frames.max,
        })
    }

    /// Rank the framings that could explain `bytes`, framing RTU as `rtu` would.
    pub fn detect(bytes: &[u8], rtu: &wiretap_catalog::ModbusRtuOptions) -> FramingDetectionResult {
        let detection = framing_detect::detect(bytes, rtu);
        if detection.byte_count == 0 {
            return FramingDetectionResult {
                byte_count: 0,
                candidates: Vec::new(),
                best_candidate: None,
                notes: vec!["No bytes to analyse".to_string()],
                unframed_functions: Vec::new(),
                unframed_broadcasts: 0,
                rejected_functions: Vec::new(),
            };
        }

        let candidates: Vec<FramingCandidate> = detection
            .candidates
            .iter()
            .filter_map(to_candidate)
            .collect();
        let mut notes = vec![format!("Analysing {} bytes", detection.byte_count)];
        match candidates.first() {
            None => notes.push("No clear framing pattern detected".to_string()),
            Some(best) => {
                let mode = best.mode.to_string().to_uppercase();
                let pct = best.confidence;
                notes.push(match best.confidence {
                    80.. => format!("Strong {mode} framing detected ({pct}% confidence)"),
                    50..=79 => format!("Possible {mode} framing detected ({pct}% confidence)"),
                    _ => format!("Weak framing signal - {mode} is best guess ({pct}% confidence)"),
                });
            }
        }

        FramingDetectionResult {
            byte_count: detection.byte_count,
            best_candidate: candidates.first().cloned(),
            candidates,
            notes,
            unframed_functions: detection.unframed.functions,
            unframed_broadcasts: detection.unframed.broadcasts,
            rejected_functions: detection.unframed.rejected,
        }
    }

    /// Detect the framing of a byte capture.
    ///
    /// Analyses the busiest bus on its own: two interfaces interleaved into one
    /// buffer are two serial lines, and scoring them together describes neither.
    ///
    /// Only the tail is read. An overnight serial capture is tens of millions of
    /// rows and the whole of it would come back to keep the last hundred
    /// kilobytes, holding the capture database's lock for the scan.
    #[tauri::command(rename_all = "snake_case")]
    pub fn detect_serial_framing(
        capture_id: String,
        sample_bytes: Option<usize>,
        modbus: Option<ModbusRtuOptions>,
        session_id: Option<String>,
    ) -> Result<FramingDetectionResult, String> {
        if capture_store::get_capture_kind(&capture_id) != Some(capture_store::CaptureKind::Bytes) {
            return Err(format!(
                "Capture '{}' not found or is not a byte capture",
                capture_id
            ));
        }
        let catalog = session_id
            .as_deref()
            .and_then(crate::ws::dispatch::attached_catalog);
        let options = modbus.unwrap_or_default().with_catalog(catalog.as_deref());
        let sample = sample_bytes.unwrap_or(DEFAULT_SAMPLE_BYTES);

        // The tail spans every bus, so read a few windows' worth to leave the
        // busiest one a full window once they are separated.
        let captured = capture_store::get_capture_bytes_tail(&capture_id, sample.saturating_mul(4));
        let mut by_bus: std::collections::BTreeMap<u8, Vec<u8>> = std::collections::BTreeMap::new();
        for b in &captured {
            by_bus.entry(b.bus).or_default().push(b.byte);
        }
        let buses = by_bus.len();
        let (bus, mut bytes) = by_bus
            .into_iter()
            .max_by_key(|(_, v)| v.len())
            .unwrap_or_default();
        if bytes.len() > sample {
            bytes.drain(..bytes.len() - sample);
        }

        let mut result = detect(&bytes, &options);
        if buses > 1 {
            result
                .notes
                .push(format!("{buses} interfaces captured; analysed bus {bus}"));
        }
        Ok(result)
    }
}

#[cfg(not(target_os = "ios"))]
pub use desktop::*;

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::desktop::detect;
    use crate::io::FramingMode;
    use wiretap_catalog::ModbusRtuOptions;
    use wiretap_checksum::algorithms::crc16_modbus_checksum;

    #[test]
    fn a_crlf_line_reads_as_its_delimiter_in_hex() {
        let bytes = b"STATUS,OK,1234\r\n".repeat(20);
        let best = detect(&bytes, &ModbusRtuOptions::default())
            .best_candidate
            .unwrap();
        assert_eq!(best.mode, FramingMode::Delimiter);
        assert_eq!(best.delimiter_hex.as_deref(), Some("0D0A"));
        assert_eq!(best.notes.last().unwrap(), "CRLF delimiter: 19 frames");
    }

    #[test]
    fn crc_coverage_reads_as_a_percentage() {
        let mut bytes = Vec::new();
        for body in ["01044DE20002", "010404CAFEF00D"].repeat(8) {
            let mut msg = wiretap_decode::hex::parse_bytes(body).unwrap();
            msg.extend(crc16_modbus_checksum(&msg).to_le_bytes());
            bytes.extend(msg);
        }
        let best = detect(&bytes, &ModbusRtuOptions::default())
            .best_candidate
            .unwrap();
        assert_eq!(best.mode, FramingMode::ModbusRtu);
        assert_eq!(
            best.notes,
            [
                "100% of bytes in valid frames",
                "1 unique device address",
                "16 valid CRC frames found",
            ]
        );
    }
}
