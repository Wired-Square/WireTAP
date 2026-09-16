// Copyright 2026 Wired Square Pty Ltd

//! Which framing a raw serial byte stream is using.
//!
//! Every mode is scored by running the framer that would actually read it —
//! [`SerialFramer`], the same one the port and `apply_framing_to_capture` use —
//! so the tool that says what a line is and the framer that reads it cannot
//! disagree. The Modbus arm used to be a brute-force CRC scan in TypeScript,
//! which is the algorithm `docs/session-flow.md` records as having been deleted
//! from Rust for taking the first CRC hit and eating the head of a split message.
//!
//! The bytes are read straight from the capture store, so nothing crosses the
//! wire to be analysed.

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
    use wiretap_catalog::modbus::{MAX_RTU_LEN, MIN_RTU_LEN};
    use wiretap_checksum::algorithms::crc16_modbus_valid;

    use crate::capture_store;
    use crate::io::serial::{FramingEncoding, SerialFramer};
    use crate::io::ModbusRtuOptions;

    /// How much of the tail to analyse. Matches what the frontend used to fetch.
    const DEFAULT_SAMPLE_BYTES: usize = 100_000;

    /// Delimiters worth testing, likeliest first.
    const DELIMITERS: [(&[u8], &str); 6] = [
        (&[0x0D, 0x0A], "CRLF"),
        (&[0x0A], "LF"),
        (&[0x0D], "CR"),
        (&[0x00], "NUL"),
        (&[0x03], "ETX"),
        (&[0x04], "EOT"),
    ];

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FramingCandidate {
        pub mode: &'static str,
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
    }

    /// Frame lengths → the shape every candidate reports.
    struct Stats {
        count: usize,
        avg: f64,
        min: usize,
        max: usize,
    }

    impl Stats {
        fn of(lengths: &[usize]) -> Option<Self> {
            let (&min, &max) = lengths.iter().min().zip(lengths.iter().max())?;
            Some(Stats {
                count: lengths.len(),
                avg: lengths.iter().sum::<usize>() as f64 / lengths.len() as f64,
                min,
                max,
            })
        }

        /// True where frame sizes barely vary, which suggests a structured protocol.
        fn consistent(&self) -> bool {
            ((self.max - self.min) as f64) < self.avg * 0.5
        }
    }

    fn candidate(
        mode: &'static str,
        confidence: i32,
        notes: Vec<String>,
        stats: &Stats,
    ) -> FramingCandidate {
        FramingCandidate {
            mode,
            confidence: confidence.clamp(0, 100),
            notes,
            delimiter: None,
            delimiter_hex: None,
            estimated_frame_count: stats.count,
            avg_frame_length: stats.avg.round() as usize,
            min_frame_length: stats.min,
            max_frame_length: stats.max,
        }
    }

    /// Every complete frame one encoding recovers from `bytes`.
    fn frames_for(bytes: &[u8], encoding: FramingEncoding) -> Vec<Vec<u8>> {
        let mut framer = SerialFramer::new(encoding);
        let fed = framer.feed(bytes);
        fed.into_iter()
            .chain(framer.flush())
            .filter(|f| !f.incomplete)
            .map(|f| f.bytes)
            .collect()
    }

    // ========================================================================
    // SLIP
    // ========================================================================

    fn test_slip(bytes: &[u8]) -> Option<FramingCandidate> {
        const SLIP_END: u8 = 0xC0;
        const SLIP_ESC: u8 = 0xDB;

        let end_count = bytes.iter().filter(|&&b| b == SLIP_END).count();
        let esc_count = bytes.iter().filter(|&&b| b == SLIP_ESC).count();
        if end_count < 2 {
            return None;
        }

        let frames = frames_for(bytes, FramingEncoding::Slip);
        let lengths: Vec<usize> = frames.iter().map(Vec::len).collect();
        let stats = Stats::of(&lengths)?;

        let mut notes = Vec::new();
        let mut confidence = match stats.count {
            50.. => 50,
            10..=49 => 40,
            3..=9 => 25,
            _ => 10,
        };
        if esc_count > 0 {
            notes.push(format!("Found {esc_count} SLIP escape sequences"));
            confidence += 25;
        }
        if (4.0..=256.0).contains(&stats.avg) {
            confidence += 15;
        }
        if stats.consistent() {
            confidence += 10;
            notes.push("Consistent frame sizes".to_string());
        }
        // SLIP spends one or two END markers per frame. Many more than that and
        // 0xC0 is probably data rather than a delimiter.
        let end_ratio = end_count as f64 / (stats.count * 2) as f64;
        if end_ratio > 2.0 {
            confidence -= 20;
            notes
                .push("0xC0 appears frequently within frames - may include data bytes".to_string());
        } else if end_ratio <= 1.5 {
            confidence += 15;
        }
        notes.push(format!("{} frames decoded", stats.count));

        (confidence >= 20).then(|| candidate("slip", confidence, notes, &stats))
    }

    // ========================================================================
    // Modbus RTU
    // ========================================================================

    /// Score a Modbus RTU line from what the framer recovered. What it could not
    /// frame is reported in the notes, and is what tells you the line needs declaring.
    fn test_modbus_rtu(
        bytes: &[u8],
        messages: &[Vec<u8>],
        unframed_functions: &[u8],
        unframed_broadcasts: usize,
    ) -> Option<FramingCandidate> {
        let lengths: Vec<usize> = messages.iter().map(Vec::len).collect();
        let stats = Stats::of(&lengths).filter(|s| s.count >= 2)?;

        let mut notes = Vec::new();
        let mut confidence = match stats.count {
            10.. => 50,
            5..=9 => 35,
            _ => 20,
        };
        let covered: usize = lengths.iter().sum();
        let coverage = covered as f64 / bytes.len() as f64;
        if coverage >= 0.8 {
            confidence += 30;
            notes.push(format!("{:.0}% of bytes in valid frames", coverage * 100.0));
        } else if coverage >= 0.5 {
            confidence += 15;
        }
        let addresses: std::collections::BTreeSet<u8> =
            messages.iter().filter_map(|m| m.first().copied()).collect();
        if addresses.len() <= 3 {
            confidence += 10;
            let plural = if addresses.len() == 1 { "" } else { "es" };
            notes.push(format!("{} unique device address{plural}", addresses.len()));
        }
        notes.push(format!("{} valid CRC frames found", stats.count));
        if !unframed_functions.is_empty() {
            let codes: Vec<String> = unframed_functions
                .iter()
                .map(|f| format!("0x{f:02X}"))
                .collect();
            notes.push(format!(
                "Unframed function codes: {} — declare them as vendor codes",
                codes.join(", ")
            ));
        }
        if unframed_broadcasts > 0 {
            notes.push(format!(
                "{unframed_broadcasts} unframed broadcast messages (address 0) — allow broadcast"
            ));
        }

        (confidence >= 30).then(|| candidate("modbus_rtu", confidence, notes, &stats))
    }

    /// What the framer could not frame: the function codes those messages
    /// carried, commonest first, and how many of them were broadcasts.
    ///
    /// Only the runs of bytes the framer skipped are searched, and there by CRC
    /// alone — shortest match wins, as the crate's own vendor search does. An
    /// unbounded search of that kind is what the framer refuses to do, because
    /// roughly one resync in 260 validates by chance and framing on that would
    /// invent messages. Here it only ranks a suggestion, so a stray hit costs a
    /// code that appears once against real ones appearing dozens of times, and
    /// the threshold below is what separates them.
    ///
    /// The search admits address 0 whether or not the options do: a hint that
    /// cannot see a broadcast can never say to allow one. Codes already declared
    /// are not re-reported — an undeclared broadcast swallows the messages behind
    /// it, declared or not.
    fn unframed(
        bytes: &[u8],
        messages: &[Vec<u8>],
        options: &ModbusRtuOptions,
    ) -> (Vec<u8>, usize) {
        // Nothing framed means this is not a Modbus line at all, and the Modbus
        // candidate is discarded either way — searching every byte of a text or
        // SLIP stream for a coincidental CRC would be the whole cost of the file
        // spent on a suggestion nobody sees.
        if messages.len() < 2 {
            return (Vec::new(), 0);
        }

        /// Could these two bytes open a message? Two compares reject most of a
        /// stream before any CRC work, which is what keeps the search below to
        /// the runs that plausibly hold one.
        fn opens_message(head: &[u8], device_address: Option<u8>) -> bool {
            let Some(&[address, function]) = head.get(..2) else {
                return false;
            };
            let addressed = match device_address {
                Some(want) => address == want || address == 0,
                None => (0..=247).contains(&address),
            };
            addressed && function & 0x80 == 0
        }

        let mut tally: std::collections::BTreeMap<u8, usize> = std::collections::BTreeMap::new();
        let mut broadcasts = 0usize;
        let mut cursor = 0usize;
        let mut search_gap = |gap: &[u8]| {
            let mut i = 0usize;
            while i + MIN_RTU_LEN <= gap.len() {
                if !opens_message(&gap[i..], options.device_address) {
                    i += 1;
                    continue;
                }
                let limit = (gap.len() - i).min(MAX_RTU_LEN);
                let hit = (MIN_RTU_LEN..=limit).find(|&n| crc16_modbus_valid(&gap[i..i + n]));
                match hit {
                    Some(n) => {
                        let (address, func) = (gap[i], gap[i + 1]);
                        if address == 0 && !options.allow_broadcast {
                            broadcasts += 1;
                        }
                        if wiretap_catalog::modbus::function_name(func).is_none()
                            && !options.any_function
                            && !options.vendor_functions.contains(&func)
                        {
                            *tally.entry(func).or_default() += 1;
                        }
                        i += n;
                    }
                    None => i += 1,
                }
            }
        };
        for msg in messages {
            // Messages come out in stream order, so each is the next occurrence
            // of its own bytes — almost always right at the cursor, which is why
            // the scan is a fallback rather than the rule.
            let rest = &bytes[cursor..];
            let offset = if rest.starts_with(msg) {
                0
            } else {
                match rest.windows(msg.len()).position(|w| w == msg.as_slice()) {
                    Some(n) => n,
                    None => break,
                }
            };
            search_gap(&rest[..offset]);
            cursor += offset + msg.len();
        }
        search_gap(&bytes[cursor..]);

        let mut ranked: Vec<(u8, usize)> = tally.into_iter().filter(|&(_, n)| n >= 3).collect();
        ranked.sort_by_key(|&(func, n)| (std::cmp::Reverse(n), func));
        let functions = ranked.into_iter().take(4).map(|(f, _)| f).collect();
        (functions, if broadcasts >= 3 { broadcasts } else { 0 })
    }

    // ========================================================================
    // Delimiters
    // ========================================================================

    fn test_delimiter(bytes: &[u8], delimiter: &[u8], name: &str) -> Option<FramingCandidate> {
        let positions: Vec<usize> = bytes
            .windows(delimiter.len())
            .enumerate()
            .filter(|(_, w)| *w == delimiter)
            .map(|(i, _)| i)
            .collect();
        if positions.len() < 2 {
            return None;
        }

        let lengths: Vec<usize> = positions
            .windows(2)
            .map(|p| p[1] - (p[0] + delimiter.len()))
            .filter(|&n| n > 0)
            .collect();
        let stats = Stats::of(&lengths)?;

        let mut notes = Vec::new();
        let mut confidence = match stats.count {
            10.. => 35,
            3..=9 => 20,
            _ => 10,
        };
        if (4.0..=256.0).contains(&stats.avg) {
            confidence += 20;
        } else if (1.0..=1024.0).contains(&stats.avg) {
            confidence += 10;
        }
        if stats.count >= 3 && stats.consistent() {
            confidence += 15;
            notes.push("Consistent frame sizes".to_string());
        }
        let printable = bytes
            .iter()
            .filter(|&&b| (0x20..=0x7E).contains(&b))
            .count();
        if printable as f64 / bytes.len() as f64 > 0.7 && matches!(name, "CRLF" | "LF" | "CR") {
            confidence += 15;
            notes.push("Data appears to be ASCII text".to_string());
        }
        // A delimiter turning up far more often than the frame count implies is
        // more likely to be data.
        if positions.len() as f64 > (bytes.len() as f64 / stats.avg).floor() * 2.0 {
            confidence -= 10;
        }
        notes.push(format!("{name} delimiter: {} frames", stats.count));

        (confidence >= 25).then(|| FramingCandidate {
            delimiter: Some(delimiter.to_vec()),
            delimiter_hex: Some(delimiter.iter().map(|b| format!("{b:02X}")).collect()),
            ..candidate("delimiter", confidence, notes, &stats)
        })
    }

    // ========================================================================
    // Entry point
    // ========================================================================

    /// Rank the framings that could explain `bytes`.
    pub fn detect(bytes: &[u8], modbus: &ModbusRtuOptions) -> FramingDetectionResult {
        if bytes.is_empty() {
            return FramingDetectionResult {
                byte_count: 0,
                candidates: Vec::new(),
                best_candidate: None,
                notes: vec!["No bytes to analyse".to_string()],
                unframed_functions: Vec::new(),
                unframed_broadcasts: 0,
            };
        }

        let mut notes = vec![format!("Analysing {} bytes", bytes.len())];
        let messages = frames_for(bytes, FramingEncoding::ModbusRtu(modbus.clone()));
        let (unframed_functions, unframed_broadcasts) = unframed(bytes, &messages, modbus);

        let mut candidates: Vec<FramingCandidate> = test_slip(bytes)
            .into_iter()
            .chain(test_modbus_rtu(
                bytes,
                &messages,
                &unframed_functions,
                unframed_broadcasts,
            ))
            .chain(
                DELIMITERS
                    .iter()
                    .filter_map(|(d, name)| test_delimiter(bytes, d, name)),
            )
            .collect();
        candidates.sort_by_key(|c| std::cmp::Reverse(c.confidence));

        match candidates.first() {
            None => notes.push("No clear framing pattern detected".to_string()),
            Some(best) => {
                let mode = best.mode.to_uppercase();
                let pct = best.confidence;
                notes.push(match best.confidence {
                    80.. => format!("Strong {mode} framing detected ({pct}% confidence)"),
                    50..=79 => format!("Possible {mode} framing detected ({pct}% confidence)"),
                    _ => format!("Weak framing signal - {mode} is best guess ({pct}% confidence)"),
                });
            }
        }

        FramingDetectionResult {
            byte_count: bytes.len(),
            best_candidate: candidates.first().cloned(),
            candidates,
            notes,
            unframed_functions,
            unframed_broadcasts,
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
    ) -> Result<FramingDetectionResult, String> {
        if capture_store::get_capture_kind(&capture_id) != Some(capture_store::CaptureKind::Bytes) {
            return Err(format!(
                "Capture '{}' not found or is not a byte capture",
                capture_id
            ));
        }
        let options = modbus.unwrap_or_default();
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
    use crate::io::ModbusRtuOptions;
    use wiretap_checksum::algorithms::crc16_modbus_checksum;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// A Modbus RTU message: the body, with its CRC appended.
    fn msg(body: &str) -> Vec<u8> {
        let mut out = hex(body);
        out.extend(crc16_modbus_checksum(&out).to_le_bytes());
        out
    }

    fn stock() -> ModbusRtuOptions {
        ModbusRtuOptions::default()
    }

    fn sungrow() -> ModbusRtuOptions {
        ModbusRtuOptions {
            vendor_functions: vec![0x20, 0x60, 0x65],
            allow_broadcast: true,
            ..Default::default()
        }
    }

    /// A read request and the response answering it, repeated.
    fn polling(pairs: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..pairs {
            out.extend(msg("01044DE20002"));
            out.extend(msg("010404CAFEF00D"));
        }
        out
    }

    fn best_mode(bytes: &[u8], options: &ModbusRtuOptions) -> Option<&'static str> {
        detect(bytes, options).best_candidate.map(|c| c.mode)
    }

    #[test]
    fn an_empty_stream_detects_nothing() {
        let out = detect(&[], &stock());
        assert_eq!(out.byte_count, 0);
        assert!(out.best_candidate.is_none());
    }

    #[test]
    fn a_modbus_line_is_recognised_by_its_crcs() {
        let bytes = polling(8);
        assert_eq!(best_mode(&bytes, &stock()), Some("modbus_rtu"));
        let out = detect(&bytes, &stock());
        let modbus = out
            .candidates
            .iter()
            .find(|c| c.mode == "modbus_rtu")
            .unwrap();
        assert_eq!(modbus.estimated_frame_count, 16);
    }

    #[test]
    fn a_slip_stream_is_recognised() {
        // 0xC0-delimited frames, one carrying an escape.
        let mut bytes = Vec::new();
        for i in 0..12u8 {
            bytes.push(0xC0);
            bytes.extend([0x01, 0x02, i, 0xDB, 0xDC]);
        }
        bytes.push(0xC0);
        assert_eq!(best_mode(&bytes, &stock()), Some("slip"));
    }

    #[test]
    fn a_crlf_text_stream_is_recognised_as_a_delimiter() {
        let bytes: Vec<u8> = std::iter::repeat_n(b"STATUS,OK,1234\r\n".as_slice(), 20)
            .flatten()
            .copied()
            .collect();
        let out = detect(&bytes, &stock());
        let best = out.best_candidate.unwrap();
        assert_eq!(best.mode, "delimiter");
        assert_eq!(best.delimiter_hex.as_deref(), Some("0D0A"));
    }

    #[test]
    fn an_exception_response_is_framed() {
        // Five bytes, shorter than its own function code's length rule.
        let mut bytes = polling(3);
        bytes.extend(msg("018402"));
        let out = detect(&bytes, &stock());
        let modbus = out
            .candidates
            .iter()
            .find(|c| c.mode == "modbus_rtu")
            .unwrap();
        assert_eq!(modbus.estimated_frame_count, 7);
        assert_eq!(modbus.min_frame_length, 5);
    }

    #[test]
    fn a_vendor_line_is_unreadable_until_its_codes_are_declared() {
        // What a Sungrow logger's RS-485 line looks like: vendor codes and a
        // broadcasting master, with a little standard polling mixed in.
        let mut bytes = polling(2);
        for _ in 0..6 {
            bytes.extend(msg("012001C803111A0002"));
            bytes.extend(msg("0060000000050A000401BB03E808"));
            bytes.extend(msg("0165000200"));
        }

        let stock_run = detect(&bytes, &stock());
        let stock_frames = stock_run
            .candidates
            .iter()
            .find(|c| c.mode == "modbus_rtu")
            .map_or(0, |c| c.estimated_frame_count);
        assert_eq!(stock_frames, 4, "only the standard polling should frame");

        let declared = detect(&bytes, &sungrow());
        let framed = declared
            .candidates
            .iter()
            .find(|c| c.mode == "modbus_rtu")
            .unwrap();
        assert_eq!(framed.estimated_frame_count, 22);
    }

    #[test]
    fn the_codes_it_could_not_frame_are_reported() {
        // The whole point of the hint: you should not have to already know them.
        let mut bytes = polling(2);
        for _ in 0..6 {
            bytes.extend(msg("012001C803111A0002"));
            bytes.extend(msg("0165000200"));
        }
        let out = detect(&bytes, &stock());
        assert!(
            out.unframed_functions.contains(&0x20),
            "{:?}",
            out.unframed_functions
        );
        assert!(
            out.unframed_functions.contains(&0x65),
            "{:?}",
            out.unframed_functions
        );

        // Declared, they are framed rather than reported.
        assert!(detect(&bytes, &sungrow()).unframed_functions.is_empty());
    }

    #[test]
    fn a_broadcast_needs_declaring_too() {
        let mut bytes = polling(2);
        for _ in 0..6 {
            bytes.extend(msg("0060000000050A000401BB03E808"));
        }
        let with_vendor = ModbusRtuOptions {
            vendor_functions: vec![0x60],
            ..Default::default()
        };
        let framed = |o: &ModbusRtuOptions| {
            detect(&bytes, o)
                .candidates
                .iter()
                .find(|c| c.mode == "modbus_rtu")
                .map_or(0, |c| c.estimated_frame_count)
        };
        assert_eq!(framed(&with_vendor), 4, "address 0 cannot start a message");
        assert_eq!(framed(&sungrow()), 10);

        // The hint has to say so, or the line stays unreadable with every code
        // declared. Allowed, the broadcasts frame and the hint goes quiet.
        let hint = detect(&bytes, &with_vendor);
        assert_eq!(hint.unframed_broadcasts, 6);
        assert!(
            hint.unframed_functions.is_empty(),
            "{:?}",
            hint.unframed_functions
        );
        assert_eq!(detect(&bytes, &sungrow()).unframed_broadcasts, 0);
    }

    #[test]
    fn a_split_message_is_not_resynced_through() {
        // The failure the old brute-force scan had: a message straddling the end
        // of the sample must not have its head eaten byte by byte.
        let mut bytes = polling(4);
        let tail = msg("01044DE20002");
        bytes.extend(&tail[..tail.len() - 1]);
        let out = detect(&bytes, &stock());
        let modbus = out
            .candidates
            .iter()
            .find(|c| c.mode == "modbus_rtu")
            .unwrap();
        assert_eq!(modbus.estimated_frame_count, 8);
    }
}

#[cfg(all(test, not(target_os = "ios")))]
mod feeder_check {
    use super::desktop::detect;
    use crate::io::ModbusRtuOptions;

    /// `scripts/modbus_rtu_feeder.py --start 8 --cycles 4`, verbatim. Four
    /// cycles so the vendor codes clear the hint's occurrence threshold as they
    /// would on any real line, starting at 8 so one of them carries an
    /// exception response.
    const CYCLE: &str = "01044de20002c69101040401340000bbb602030010000185fc02030200027d8501010000000abc0d0101022a02275d0105001aff00adfd012001c803111a0000650b0060000000050a000401bb03e80832e8016500020807aa01044de20002c69101040401350000ea7602030010000185fc0203020003bc4501010000000abc0d010102d50266ad0105001a0000ec0d012001c803111a0001a4cb0060000000050a000401bb03e80832e80165000209c66a01044de20002c691010404013600001a7602030010000185fc0203020004fd8701010000000abc0d0101022a02275d0105001aff00adfd012001c803111a0002e4ca0060000000050a000401bb03e80832e8016500020a866b018402c2c101044de20002c691010404013700004bb602030010000185fc02030200053c4701010000000abc0d010102d50266ad0105001aff00adfd012001c803111a0003250a0060000000050a000401bb03e80832e8016500020b47ab";

    fn bytes() -> Vec<u8> {
        (0..CYCLE.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&CYCLE[i..i + 2], 16).unwrap())
            .collect()
    }

    fn framed(options: &ModbusRtuOptions) -> usize {
        detect(&bytes(), options)
            .candidates
            .iter()
            .find(|c| c.mode == "modbus_rtu")
            .map_or(0, |c| c.estimated_frame_count)
    }

    #[test]
    fn the_feeders_stream_frames_as_advertised() {
        let stock = ModbusRtuOptions::default();
        let declared = ModbusRtuOptions {
            vendor_functions: vec![0x20, 0x60, 0x65],
            allow_broadcast: true,
            ..Default::default()
        };

        // 41 messages on the wire, 29 of them spec-defined. Undeclared, the 12
        // vendor ones do not merely fail to frame: the runs of bytes they leave
        // behind swallow the legitimate messages sitting after them, and barely
        // half the line survives. That is the point of the feeder — the cost of
        // not declaring is far more than the vendor traffic itself.
        assert_eq!(framed(&stock), 14);
        assert_eq!(framed(&declared), 41);

        // And the tool names everything standing in the way, first time —
        // including the broadcast it cannot itself frame — and, once the user has
        // declared what it said, does not name those again.
        let hint = detect(&bytes(), &stock);
        assert_eq!(hint.unframed_functions, vec![0x20, 0x60, 0x65]);
        assert_eq!(hint.unframed_broadcasts, 4);
        let partial = ModbusRtuOptions {
            vendor_functions: vec![0x20, 0x65],
            ..Default::default()
        };
        assert_eq!(framed(&partial), 17);
        let hint = detect(&bytes(), &partial);
        assert_eq!(hint.unframed_functions, vec![0x60]);
        assert_eq!(hint.unframed_broadcasts, 4);
    }
}
