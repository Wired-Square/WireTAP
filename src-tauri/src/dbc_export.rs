// DBC export module - converts WireTAP TOML catalog format to DBC format

use std::collections::{HashMap, HashSet};

/// Signal from parsed TOML
#[derive(Debug, Clone)]
struct SignalDoc {
    name: String,
    start_bit: i32,
    bit_length: i32,
    factor: Option<f64>,
    offset: Option<f64>,
    unit: Option<String>,
    signed: Option<bool>,
    endianness: Option<String>,
    min: Option<f64>,
    max: Option<f64>,
    enum_map: Option<HashMap<String, String>>,
    receiver: Option<String>,
    notes: Option<String>,
}

impl SignalDoc {
    fn from_toml(value: &toml::Value) -> Option<Self> {
        let table = value.as_table()?;
        Some(SignalDoc {
            name: table.get("name")?.as_str()?.to_string(),
            start_bit: table.get("start_bit")?.as_integer()? as i32,
            bit_length: table.get("bit_length")?.as_integer()? as i32,
            factor: table
                .get("factor")
                .and_then(|v| v.as_float().or_else(|| v.as_integer().map(|i| i as f64))),
            offset: table
                .get("offset")
                .and_then(|v| v.as_float().or_else(|| v.as_integer().map(|i| i as f64))),
            unit: table.get("unit").and_then(|v| v.as_str()).map(String::from),
            signed: table.get("signed").and_then(|v| v.as_bool()),
            endianness: table
                .get("endianness")
                .and_then(|v| v.as_str())
                .map(String::from),
            min: table
                .get("min")
                .and_then(|v| v.as_float().or_else(|| v.as_integer().map(|i| i as f64))),
            max: table
                .get("max")
                .and_then(|v| v.as_float().or_else(|| v.as_integer().map(|i| i as f64))),
            enum_map: table.get("enum").and_then(|v| {
                v.as_table().map(|t| {
                    t.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
            }),
            receiver: table
                .get("receiver")
                .and_then(|v| v.as_str())
                .map(String::from),
            notes: parse_notes(table.get("notes")),
        })
    }
}

/// Parse notes field which can be a string or array of strings
fn parse_notes(value: Option<&toml::Value>) -> Option<String> {
    let v = value?;
    if let Some(s) = v.as_str() {
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    } else if let Some(arr) = v.as_array() {
        let lines: Vec<String> = arr
            .iter()
            .filter_map(|item| item.as_str().map(String::from))
            .collect();
        if lines.is_empty() {
            None
        } else {
            Some(lines.join(" "))
        }
    } else {
        None
    }
}

/// Mux case from parsed TOML
#[derive(Debug, Clone)]
struct MuxCase {
    value: String,
    signals: Vec<SignalDoc>,
    nested_mux: Option<Box<MuxDoc>>,
    #[allow(dead_code)] // Parsed but not used - DBC has no comment type for mux cases
    notes: Option<String>,
}

/// Mux from parsed TOML
#[derive(Debug, Clone)]
struct MuxDoc {
    name: Option<String>,
    start_bit: i32,
    bit_length: i32,
    cases: Vec<MuxCase>,
}

impl MuxDoc {
    fn from_toml(value: &toml::Value) -> Option<Self> {
        let table = value.as_table()?;

        let name = table.get("name").and_then(|v| v.as_str()).map(String::from);
        let start_bit = table.get("start_bit")?.as_integer()? as i32;
        let bit_length = table.get("bit_length")?.as_integer()? as i32;

        // Reserved keys that are not case values
        let reserved: HashSet<&str> = ["name", "start_bit", "bit_length", "default"]
            .iter()
            .copied()
            .collect();

        let mut cases = Vec::new();
        for (key, val) in table {
            if reserved.contains(key.as_str()) {
                continue;
            }
            // Case keys should be numeric
            if key.parse::<i64>().is_err() {
                continue;
            }

            if let Some(case_table) = val.as_table() {
                let signals = case_table
                    .get("signals")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(SignalDoc::from_toml).collect())
                    .unwrap_or_default();

                let nested_mux = case_table.get("mux").and_then(MuxDoc::from_toml).map(Box::new);
                let notes = parse_notes(case_table.get("notes"));

                cases.push(MuxCase {
                    value: key.clone(),
                    signals,
                    nested_mux,
                    notes,
                });
            }
        }

        // Sort cases numerically
        cases.sort_by(|a, b| {
            let av: i64 = a.value.parse().unwrap_or(i64::MAX);
            let bv: i64 = b.value.parse().unwrap_or(i64::MAX);
            av.cmp(&bv)
        });

        Some(MuxDoc {
            name,
            start_bit,
            bit_length,
            cases,
        })
    }
}

/// CAN frame from parsed TOML
#[derive(Debug, Clone)]
struct CanFrameDoc {
    name: Option<String>,
    length: Option<i32>,
    transmitter: Option<String>,
    signals: Vec<SignalDoc>,
    mux: Option<MuxDoc>,
    notes: Option<String>,
}

impl CanFrameDoc {
    fn from_toml(value: &toml::Value) -> Option<Self> {
        let table = value.as_table()?;

        // Try both "signal" and "signals" keys
        let signals = table
            .get("signal")
            .or_else(|| table.get("signals"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(SignalDoc::from_toml).collect())
            .unwrap_or_default();

        Some(CanFrameDoc {
            name: table.get("name").and_then(|v| v.as_str()).map(String::from),
            length: table
                .get("length")
                .and_then(|v| v.as_integer())
                .map(|i| i as i32),
            transmitter: table
                .get("transmitter")
                .and_then(|v| v.as_str())
                .map(String::from),
            signals,
            mux: table.get("mux").and_then(MuxDoc::from_toml),
            notes: parse_notes(table.get("notes")),
        })
    }
}

/// Escape special characters for DBC strings
fn escape_dbc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Generate DBC header with node list
fn render_header(nodes: &[&str]) -> String {
    let mut out = String::new();
    out.push_str("VERSION \"\"\n");
    out.push_str("NS_ :\n");
    out.push_str("\tNS_DESC_\n\tCM_\n\tBA_DEF_\n\tBA_\n\tVAL_\n\tCAT_DEF_\n\tCAT_\n\tFILTER\n");
    out.push_str(
        "\tBA_DEF_DEF_\n\tEV_DATA_\n\tENVVAR_DATA_\n\tSGTYPE_\n\tSGTYPE_VAL_\n\tBA_DEF_SGTYPE_\n",
    );
    out.push_str(
        "\tBA_SGTYPE_\n\tSIG_TYPE_REF_\n\tVAL_TABLE_\n\tSIG_GROUP_\n\tSIG_VALTYPE_\n\tSIGTYPE_VALTYPE_\n",
    );
    out.push_str(
        "\tBO_TX_BU_\n\tBA_DEF_REL_\n\tBA_REL_\n\tBA_DEF_DEF_REL_\n\tBU_SG_REL_\n\tBU_EV_REL_\n\tBU_BO_REL_\n",
    );
    out.push_str("\tSG_MUL_VAL_\n\n");
    out.push_str("BS_:\n");
    out.push_str(&format!("BU_: {}\n\n", nodes.join(" ")));
    out
}

/// Get DBC endianness character: '1' = Intel/little, '0' = Motorola/big
fn dbc_endianness_char(endianness: Option<&str>, default: &str) -> char {
    let end = endianness.unwrap_or(default);
    match end.to_lowercase().as_str() {
        "big" => '0',
        "little" | _ => '1',
    }
}

/// Convert internal LSB0 start bit to DBC start bit
/// Intel (little, @1): same as LSB0
/// Motorola (big, @0): DBC uses MSB position: 8*B + (7 - b) where B = floor(start/8), b = start % 8
fn dbc_start_bit(lsb0_start: i32, _length: i32, endc: char) -> i32 {
    if endc == '1' {
        lsb0_start
    } else {
        let b_byte = lsb0_start / 8;
        let b_bit = lsb0_start % 8;
        8 * b_byte + (7 - b_bit)
    }
}

/// Calculate raw min/max from bit length and signedness
fn raw_min_max(bit_length: i32, signed: bool) -> (i64, i64) {
    // Clamp to valid range for i64 operations
    let bits = bit_length.clamp(1, 63) as u32;

    if signed {
        let hi = (1_i64 << (bits - 1)) - 1;
        let lo = -(1_i64 << (bits - 1));
        (lo, hi)
    } else {
        if bits >= 63 {
            // For 63+ bits unsigned, use i64::MAX as approximation
            (0, i64::MAX)
        } else {
            (0, (1_i64 << bits) - 1)
        }
    }
}

/// Calculate physical min/max from signal parameters
fn phys_min_max(signal: &SignalDoc) -> (f64, f64) {
    // Prefer explicit min/max if present
    if let (Some(min), Some(max)) = (signal.min, signal.max) {
        return (min, max);
    }

    let factor = signal.factor.unwrap_or(1.0);
    let offset = signal.offset.unwrap_or(0.0);
    let signed = signal.signed.unwrap_or(false);
    let (lo, hi) = raw_min_max(signal.bit_length, signed);

    let lo_p = lo as f64 * factor + offset;
    let hi_p = hi as f64 * factor + offset;

    if lo_p <= hi_p {
        (lo_p, hi_p)
    } else {
        (hi_p, lo_p)
    }
}

/// Render a single signal line
fn render_signal(
    signal: &SignalDoc,
    multiplex: Option<&str>,
    default_receiver: &str,
    default_endianness: &str,
) -> String {
    let endc = dbc_endianness_char(signal.endianness.as_deref(), default_endianness);
    let start = dbc_start_bit(signal.start_bit, signal.bit_length, endc);
    let sign_char = if signal.signed.unwrap_or(false) {
        '-'
    } else {
        '+'
    };
    let (lo, hi) = phys_min_max(signal);
    let unit = signal.unit.as_deref().unwrap_or("");
    let factor = signal.factor.unwrap_or(1.0);
    let offset = signal.offset.unwrap_or(0.0);
    let receiver = signal.receiver.as_deref().unwrap_or(default_receiver);

    let mtag = multiplex
        .map(|m| format!(" {}", m))
        .unwrap_or_default();

    format!(
        "  SG_ {}{} : {}|{}@{}{} ({},{}) [{}|{}] \"{}\" {}\n",
        signal.name,
        mtag,
        start,
        signal.bit_length,
        endc,
        sign_char,
        factor,
        offset,
        lo,
        hi,
        escape_dbc(unit),
        receiver
    )
}

/// Render VAL_ line for enum values
fn render_enum_vals(frame_id: u32, signal: &SignalDoc) -> Option<String> {
    let enum_map = signal.enum_map.as_ref()?;
    if enum_map.is_empty() {
        return None;
    }

    // Sort by numeric key
    let mut items: Vec<_> = enum_map.iter().collect();
    items.sort_by(|a, b| {
        let ka = a.0.parse::<i64>().unwrap_or(i64::MAX);
        let kb = b.0.parse::<i64>().unwrap_or(i64::MAX);
        ka.cmp(&kb)
    });

    let parts: Vec<String> = items
        .into_iter()
        .filter_map(|(k, v)| {
            k.parse::<i64>()
                .ok()
                .map(|ik| format!("{} \"{}\"", ik, escape_dbc(v)))
        })
        .collect();

    if parts.is_empty() {
        return None;
    }

    Some(format!(
        "VAL_ {} {} {} ;\n",
        frame_id,
        signal.name,
        parts.join(" ")
    ))
}

/// Calculate DLC from signal usage
fn dlc_from_usage(frame: &CanFrameDoc) -> i32 {
    if let Some(length) = frame.length {
        return length;
    }

    let mut max_bit = 0;

    // Check plain signals
    for s in &frame.signals {
        max_bit = max_bit.max(s.start_bit + s.bit_length);
    }

    // Check mux
    if let Some(mux) = &frame.mux {
        max_bit = max_bit.max(mux.start_bit + mux.bit_length);
        for case in &mux.cases {
            for s in &case.signals {
                max_bit = max_bit.max(s.start_bit + s.bit_length);
            }
            // Include nested mux selector in sizing
            if let Some(nested) = &case.nested_mux {
                max_bit = max_bit.max(nested.start_bit + nested.bit_length);
            }
        }
    }

    ((max_bit + 7) / 8).max(1)
}

/// Parse frame ID from hex string (e.g., "0x123" or "123")
fn parse_frame_id(id_str: &str) -> Option<u32> {
    let s = id_str
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    u32::from_str_radix(s, 16).ok()
}

/// Flattened mux signal for export
struct FlattenedMuxSignal {
    signal: SignalDoc,
    composite_value: u64,
}

/// Flatten nested mux into single-level mux
fn flatten_mux(mux: &MuxDoc, outer_value: u64, outer_bit_length: i32) -> Vec<FlattenedMuxSignal> {
    let mut result = Vec::new();

    for case in &mux.cases {
        let case_value: u64 = match case.value.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Compute composite value
        let composite = if outer_bit_length > 0 {
            (outer_value << mux.bit_length) | case_value
        } else {
            case_value
        };

        // Add signals from this case
        for signal in &case.signals {
            result.push(FlattenedMuxSignal {
                signal: signal.clone(),
                composite_value: composite,
            });
        }

        // Recursively handle nested mux
        if let Some(nested_mux) = &case.nested_mux {
            let nested_results = flatten_mux(nested_mux, composite, mux.bit_length);
            result.extend(nested_results);
        }
    }

    result
}

/// Calculate total bit length needed for flattened mux selector
fn calculate_total_mux_bits(mux: &MuxDoc) -> i32 {
    let mut total = mux.bit_length;

    for case in &mux.cases {
        if let Some(nested) = &case.nested_mux {
            total = total.max(mux.bit_length + calculate_total_mux_bits(nested));
        }
    }

    total
}

// ============================================================================
// Extended Multiplexing Support (SG_MUL_VAL_)
// ============================================================================

/// Extended mux signal info for SG_MUL_VAL_ generation
#[derive(Debug)]
struct ExtendedMuxSignal {
    signal: SignalDoc,
    /// The multiplexor signal name this signal depends on
    multiplexor_name: String,
    /// The mux value(s) for which this signal is valid
    mux_values: Vec<u64>,
}

/// Extended mux selector info (for nested mux that is both multiplexed AND a multiplexor)
#[derive(Debug)]
struct ExtendedMuxSelector {
    name: String,
    start_bit: i32,
    bit_length: i32,
    /// The parent multiplexor signal name this selector depends on
    parent_multiplexor: String,
    /// The mux value(s) for which this selector is active
    mux_values: Vec<u64>,
}

/// Collect all signals and nested mux selectors with their mux dependencies
fn collect_extended_mux_info(
    mux: &MuxDoc,
    parent_multiplexor: &str,
    signals: &mut Vec<ExtendedMuxSignal>,
    nested_selectors: &mut Vec<ExtendedMuxSelector>,
) {
    for case in &mux.cases {
        let case_value: u64 = match case.value.parse() {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Add signals from this case
        for signal in &case.signals {
            signals.push(ExtendedMuxSignal {
                signal: signal.clone(),
                multiplexor_name: parent_multiplexor.to_string(),
                mux_values: vec![case_value],
            });
        }

        // Handle nested mux - it's both multiplexed by parent AND a multiplexor itself
        if let Some(nested_mux) = &case.nested_mux {
            let nested_name = nested_mux
                .name
                .clone()
                .unwrap_or_else(|| format!("{}_SUB", parent_multiplexor));

            // Record this nested selector
            nested_selectors.push(ExtendedMuxSelector {
                name: nested_name.clone(),
                start_bit: nested_mux.start_bit,
                bit_length: nested_mux.bit_length,
                parent_multiplexor: parent_multiplexor.to_string(),
                mux_values: vec![case_value],
            });

            // Recursively collect signals controlled by nested mux
            collect_extended_mux_info(nested_mux, &nested_name, signals, nested_selectors);
        }
    }
}

/// Merge signals with the same name and multiplexor (for signals valid in multiple mux cases)
fn merge_extended_signals(signals: Vec<ExtendedMuxSignal>) -> Vec<ExtendedMuxSignal> {
    let mut merged: HashMap<(String, String), ExtendedMuxSignal> = HashMap::new();

    for sig in signals {
        let key = (sig.signal.name.clone(), sig.multiplexor_name.clone());
        merged
            .entry(key)
            .and_modify(|existing| {
                for v in &sig.mux_values {
                    if !existing.mux_values.contains(v) {
                        existing.mux_values.push(*v);
                    }
                }
            })
            .or_insert(sig);
    }

    let mut result: Vec<_> = merged.into_values().collect();
    // Sort values for consistent output
    for sig in &mut result {
        sig.mux_values.sort();
    }
    result
}

/// Merge nested selectors with the same name
fn merge_nested_selectors(selectors: Vec<ExtendedMuxSelector>) -> Vec<ExtendedMuxSelector> {
    let mut merged: HashMap<String, ExtendedMuxSelector> = HashMap::new();

    for sel in selectors {
        merged
            .entry(sel.name.clone())
            .and_modify(|existing| {
                for v in &sel.mux_values {
                    if !existing.mux_values.contains(v) {
                        existing.mux_values.push(*v);
                    }
                }
            })
            .or_insert(sel);
    }

    let mut result: Vec<_> = merged.into_values().collect();
    for sel in &mut result {
        sel.mux_values.sort();
    }
    result
}

/// Convert a list of values to ranges (e.g., [0,1,2,5,6] -> [(0,2), (5,6)])
fn values_to_ranges(values: &[u64]) -> Vec<(u64, u64)> {
    if values.is_empty() {
        return vec![];
    }

    let mut sorted: Vec<u64> = values.to_vec();
    sorted.sort();
    sorted.dedup();

    let mut ranges = Vec::new();
    let mut start = sorted[0];
    let mut end = sorted[0];

    for &v in &sorted[1..] {
        if v == end + 1 {
            end = v;
        } else {
            ranges.push((start, end));
            start = v;
            end = v;
        }
    }
    ranges.push((start, end));

    ranges
}

/// Generate SG_MUL_VAL_ line for a signal
fn render_sg_mul_val(
    frame_id: u32,
    signal_name: &str,
    multiplexor_name: &str,
    values: &[u64],
) -> String {
    let ranges = values_to_ranges(values);
    let range_str: Vec<String> = ranges
        .iter()
        .map(|(start, end)| format!("{}-{}", start, end))
        .collect();

    format!(
        "SG_MUL_VAL_ {} {} {} {};\n",
        frame_id,
        signal_name,
        multiplexor_name,
        range_str.join(", ")
    )
}

/// Mux export mode
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MuxExportMode {
    /// Legacy mode: flatten nested mux into composite values
    Flattened,
    /// Extended mode: use SG_MUL_VAL_ with proper mNM notation
    Extended,
}

impl Default for MuxExportMode {
    fn default() -> Self {
        MuxExportMode::Extended
    }
}

/// Main export function: convert TOML catalog to DBC string
#[allow(dead_code)]
pub fn render_catalog_as_dbc(toml_content: &str, default_receiver: &str) -> Result<String, String> {
    render_catalog_as_dbc_with_mode(toml_content, default_receiver, MuxExportMode::default())
}

/// Export with explicit mux mode selection
pub fn render_catalog_as_dbc_with_mode(
    toml_content: &str,
    default_receiver: &str,
    mux_mode: MuxExportMode,
) -> Result<String, String> {
    // Parse TOML
    let parsed: toml::Value =
        toml::from_str(toml_content).map_err(|e| format!("Failed to parse TOML: {}", e))?;

    let table = parsed
        .as_table()
        .ok_or("Catalog must be a TOML table")?;

    // Get default endianness from meta section
    let default_endianness = table
        .get("meta")
        .and_then(|m| m.get("default_endianness"))
        .and_then(|e| e.as_str())
        .unwrap_or("little");

    let mut val_lines: Vec<String> = Vec::new();
    let mut sg_mul_val_lines: Vec<String> = Vec::new();
    let mut comment_lines: Vec<String> = Vec::new();

    // Get CAN frames
    let can_frames = table
        .get("frame")
        .and_then(|f| f.get("can"))
        .and_then(|c| c.as_table());

    // Collect unique nodes (transmitters and receivers) - use owned Strings
    let mut nodes_set: HashSet<String> = HashSet::new();
    nodes_set.insert(default_receiver.to_string());

    // Parse all frames first (two passes: collect then resolve mirrors)
    let mut frames: Vec<(u32, CanFrameDoc)> = Vec::new();

    if let Some(can_table) = can_frames {
        // First pass: collect all frames into a map for mirror lookups
        let mut frame_map: HashMap<String, CanFrameDoc> = HashMap::new();
        for (id_str, frame_value) in can_table {
            if let Some(frame) = CanFrameDoc::from_toml(frame_value) {
                frame_map.insert(id_str.clone(), frame);
            }
        }

        // Second pass: resolve mirrors and collect frames
        for (id_str, frame_value) in can_table {
            if let Some(mut frame) = frame_map.get(id_str).cloned() {
                let frame_id = parse_frame_id(id_str).unwrap_or(0);

                // Handle mirror_of: merge signals from primary frame
                if let Some(mirror_of) = frame_value.get("mirror_of").and_then(|v| v.as_str()) {
                    if let Some(primary) = frame_map.get(mirror_of) {
                        // Build map of mirror signals by bit position for override lookup
                        let mirror_by_position: HashMap<(i32, i32), SignalDoc> = frame
                            .signals
                            .iter()
                            .map(|s| ((s.start_bit, s.bit_length), s.clone()))
                            .collect();

                        // Start with primary signals, override by bit position
                        let mut merged: Vec<SignalDoc> = primary
                            .signals
                            .iter()
                            .map(|ps| {
                                let key = (ps.start_bit, ps.bit_length);
                                mirror_by_position
                                    .get(&key)
                                    .cloned()
                                    .unwrap_or_else(|| ps.clone())
                            })
                            .collect();

                        // Add mirror signals at new positions
                        let primary_positions: HashSet<(i32, i32)> = primary
                            .signals
                            .iter()
                            .map(|s| (s.start_bit, s.bit_length))
                            .collect();
                        for ms in &frame.signals {
                            if !primary_positions.contains(&(ms.start_bit, ms.bit_length)) {
                                merged.push(ms.clone());
                            }
                        }
                        frame.signals = merged;

                        // Inherit mux if not locally defined
                        if frame.mux.is_none() && primary.mux.is_some() {
                            frame.mux = primary.mux.clone();
                        }

                        // Inherit length if not locally defined
                        if frame.length.is_none() && primary.length.is_some() {
                            frame.length = primary.length;
                        }

                        // Inherit transmitter if not locally defined
                        if frame.transmitter.is_none() && primary.transmitter.is_some() {
                            frame.transmitter = primary.transmitter.clone();
                        }
                    }
                }

                // Collect transmitters
                if let Some(tx) = &frame.transmitter {
                    nodes_set.insert(tx.clone());
                }
                // Collect receivers from signals
                for signal in &frame.signals {
                    if let Some(rx) = &signal.receiver {
                        nodes_set.insert(rx.clone());
                    }
                }

                frames.push((frame_id, frame));
            }
        }
    }

    // Sort frames by ID
    frames.sort_by_key(|(id, _)| *id);

    let mut nodes: Vec<&str> = nodes_set.iter().map(|s| s.as_str()).collect();
    nodes.sort();

    let mut out = render_header(&nodes);

    for (frame_id, frame) in &frames {
        let dlc = dlc_from_usage(frame);
        let default_name = format!("MSG_{:03X}", frame_id);
        let name = frame.name.as_deref().unwrap_or(&default_name);
        let transmitter = frame.transmitter.as_deref().unwrap_or("WireTAP");

        out.push_str(&format!(
            "BO_ {} {}: {} {}\n",
            frame_id, name, dlc, transmitter
        ));

        // Collect frame comment
        if let Some(notes) = &frame.notes {
            comment_lines.push(format!(
                "CM_ BO_ {} \"{}\";\n",
                frame_id,
                escape_dbc(notes)
            ));
        }

        // Plain signals
        let mut sorted_signals: Vec<_> = frame.signals.iter().collect();
        sorted_signals.sort_by_key(|s| s.start_bit);

        for signal in sorted_signals {
            out.push_str(&render_signal(
                signal,
                None,
                default_receiver,
                default_endianness,
            ));
            if let Some(val_line) = render_enum_vals(*frame_id, signal) {
                val_lines.push(val_line);
            }
            // Collect signal comment
            if let Some(notes) = &signal.notes {
                comment_lines.push(format!(
                    "CM_ SG_ {} {} \"{}\";\n",
                    frame_id,
                    signal.name,
                    escape_dbc(notes)
                ));
            }
        }

        // Mux handling
        if let Some(mux) = &frame.mux {
            match mux_mode {
                MuxExportMode::Flattened => {
                    render_mux_flattened(
                        &mut out,
                        &mut val_lines,
                        &mut comment_lines,
                        *frame_id,
                        mux,
                        default_receiver,
                        default_endianness,
                    );
                }
                MuxExportMode::Extended => {
                    render_mux_extended(
                        &mut out,
                        &mut val_lines,
                        &mut sg_mul_val_lines,
                        &mut comment_lines,
                        *frame_id,
                        mux,
                        default_receiver,
                        default_endianness,
                    );
                }
            }
        }

        out.push('\n');
    }

    // Append VAL_ lines
    if !val_lines.is_empty() {
        for line in val_lines {
            out.push_str(&line);
        }
        out.push('\n');
    }

    // Append SG_MUL_VAL_ lines (only for extended mode)
    if !sg_mul_val_lines.is_empty() {
        for line in sg_mul_val_lines {
            out.push_str(&line);
        }
        out.push('\n');
    }

    // Append CM_ lines (comments)
    if !comment_lines.is_empty() {
        for line in comment_lines {
            out.push_str(&line);
        }
        out.push('\n');
    }

    Ok(out)
}

/// Render mux using flattened composite values (legacy mode)
fn render_mux_flattened(
    out: &mut String,
    val_lines: &mut Vec<String>,
    comment_lines: &mut Vec<String>,
    frame_id: u32,
    mux: &MuxDoc,
    default_receiver: &str,
    default_endianness: &str,
) {
    let total_mux_bits = calculate_total_mux_bits(mux);

    // Create synthetic selector signal
    let selector_name = mux.name.as_deref().unwrap_or("MUX");
    let selector = SignalDoc {
        name: selector_name.to_string(),
        start_bit: mux.start_bit,
        bit_length: total_mux_bits,
        factor: Some(1.0),
        offset: Some(0.0),
        unit: None,
        signed: Some(false),
        endianness: Some("little".to_string()),
        min: None,
        max: None,
        enum_map: None,
        receiver: None,
        notes: None,
    };
    out.push_str(&render_signal(
        &selector,
        Some("M"),
        default_receiver,
        "little",
    ));

    // Flatten all nested mux signals
    let flattened = flatten_mux(mux, 0, 0);

    // Sort by composite value then by start_bit
    let mut sorted: Vec<_> = flattened.iter().collect();
    sorted.sort_by(|a, b| {
        a.composite_value
            .cmp(&b.composite_value)
            .then(a.signal.start_bit.cmp(&b.signal.start_bit))
    });

    for flat in sorted {
        let mtag = format!("m{}", flat.composite_value);
        out.push_str(&render_signal(
            &flat.signal,
            Some(&mtag),
            default_receiver,
            default_endianness,
        ));
        if let Some(val_line) = render_enum_vals(frame_id, &flat.signal) {
            val_lines.push(val_line);
        }
        // Collect signal comment
        if let Some(notes) = &flat.signal.notes {
            comment_lines.push(format!(
                "CM_ SG_ {} {} \"{}\";\n",
                frame_id,
                flat.signal.name,
                escape_dbc(notes)
            ));
        }
    }
}

/// Render mux using extended multiplexing (SG_MUL_VAL_ with mNM notation)
fn render_mux_extended(
    out: &mut String,
    val_lines: &mut Vec<String>,
    sg_mul_val_lines: &mut Vec<String>,
    comment_lines: &mut Vec<String>,
    frame_id: u32,
    mux: &MuxDoc,
    default_receiver: &str,
    default_endianness: &str,
) {
    let root_selector_name = mux.name.clone().unwrap_or_else(|| "MUX".to_string());

    // Collect all extended mux info
    let mut ext_signals: Vec<ExtendedMuxSignal> = Vec::new();
    let mut nested_selectors: Vec<ExtendedMuxSelector> = Vec::new();
    collect_extended_mux_info(mux, &root_selector_name, &mut ext_signals, &mut nested_selectors);

    // Merge signals/selectors that appear in multiple cases
    let ext_signals = merge_extended_signals(ext_signals);
    let nested_selectors = merge_nested_selectors(nested_selectors);

    // Create root selector signal (M)
    let root_selector = SignalDoc {
        name: root_selector_name.clone(),
        start_bit: mux.start_bit,
        bit_length: mux.bit_length,
        factor: Some(1.0),
        offset: Some(0.0),
        unit: None,
        signed: Some(false),
        endianness: Some("little".to_string()),
        min: None,
        max: None,
        enum_map: None,
        receiver: None,
        notes: None,
    };
    out.push_str(&render_signal(
        &root_selector,
        Some("M"),
        default_receiver,
        "little",
    ));

    // Output nested selectors with mNM notation (multiplexed AND multiplexor)
    for nested in &nested_selectors {
        let nested_selector = SignalDoc {
            name: nested.name.clone(),
            start_bit: nested.start_bit,
            bit_length: nested.bit_length,
            factor: Some(1.0),
            offset: Some(0.0),
            unit: None,
            signed: Some(false),
            endianness: Some("little".to_string()),
            min: None,
            max: None,
            enum_map: None,
            receiver: None,
            notes: None,
        };

        // Use first mux value for the signal definition tag
        // The full range will be in SG_MUL_VAL_
        let first_val = nested.mux_values.first().copied().unwrap_or(0);
        let mtag = format!("m{}M", first_val);
        out.push_str(&render_signal(
            &nested_selector,
            Some(&mtag),
            default_receiver,
            "little",
        ));

        // Add SG_MUL_VAL_ entry for this nested selector
        sg_mul_val_lines.push(render_sg_mul_val(
            frame_id,
            &nested.name,
            &nested.parent_multiplexor,
            &nested.mux_values,
        ));
    }

    // Sort signals by multiplexor name, then mux value, then start_bit
    let mut sorted_signals: Vec<_> = ext_signals.iter().collect();
    sorted_signals.sort_by(|a, b| {
        a.multiplexor_name
            .cmp(&b.multiplexor_name)
            .then_with(|| {
                let a_first = a.mux_values.first().copied().unwrap_or(0);
                let b_first = b.mux_values.first().copied().unwrap_or(0);
                a_first.cmp(&b_first)
            })
            .then(a.signal.start_bit.cmp(&b.signal.start_bit))
    });

    // Output multiplexed signals
    for ext_sig in sorted_signals {
        // Use first mux value for the signal definition tag
        let first_val = ext_sig.mux_values.first().copied().unwrap_or(0);
        let mtag = format!("m{}", first_val);

        out.push_str(&render_signal(
            &ext_sig.signal,
            Some(&mtag),
            default_receiver,
            default_endianness,
        ));

        if let Some(val_line) = render_enum_vals(frame_id, &ext_sig.signal) {
            val_lines.push(val_line);
        }

        // Collect signal comment
        if let Some(notes) = &ext_sig.signal.notes {
            comment_lines.push(format!(
                "CM_ SG_ {} {} \"{}\";\n",
                frame_id,
                ext_sig.signal.name,
                escape_dbc(notes)
            ));
        }

        // Add SG_MUL_VAL_ entry if:
        // 1. Signal has multiple mux values, OR
        // 2. Signal's multiplexor is a nested selector (not the root)
        let needs_sg_mul_val = ext_sig.mux_values.len() > 1
            || ext_sig.multiplexor_name != root_selector_name;

        if needs_sg_mul_val {
            sg_mul_val_lines.push(render_sg_mul_val(
                frame_id,
                &ext_sig.signal.name,
                &ext_sig.multiplexor_name,
                &ext_sig.mux_values,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dbc_start_bit_little() {
        // Intel/little-endian: no conversion
        assert_eq!(dbc_start_bit(0, 8, '1'), 0);
        assert_eq!(dbc_start_bit(8, 16, '1'), 8);
    }

    #[test]
    fn test_dbc_start_bit_big() {
        // Motorola/big-endian: 8*B + (7 - b)
        assert_eq!(dbc_start_bit(0, 8, '0'), 7); // B=0, b=0 -> 7
        assert_eq!(dbc_start_bit(8, 8, '0'), 15); // B=1, b=0 -> 15
    }

    #[test]
    fn test_raw_min_max_unsigned() {
        assert_eq!(raw_min_max(8, false), (0, 255));
        assert_eq!(raw_min_max(16, false), (0, 65535));
    }

    #[test]
    fn test_raw_min_max_signed() {
        assert_eq!(raw_min_max(8, true), (-128, 127));
        assert_eq!(raw_min_max(16, true), (-32768, 32767));
    }

    #[test]
    fn test_simple_catalog_export() {
        let toml = r#"
[meta]
name = "Test"
version = 1
default_endianness = "little"

[frame.can."0x100"]
length = 8
transmitter = "ECU1"
signal = [
    { name = "Speed", start_bit = 0, bit_length = 16 },
    { name = "RPM", start_bit = 16, bit_length = 16 },
]
"#;
        let result = render_catalog_as_dbc(toml, "Vector__XXX").unwrap();
        assert!(result.contains("BO_ 256 MSG_100: 8 ECU1"));
        assert!(result.contains("SG_ Speed"));
        assert!(result.contains("SG_ RPM"));
    }

    #[test]
    fn test_values_to_ranges() {
        // Single value
        assert_eq!(values_to_ranges(&[5]), vec![(5, 5)]);
        // Consecutive values become a range
        assert_eq!(values_to_ranges(&[0, 1, 2]), vec![(0, 2)]);
        // Non-consecutive values
        assert_eq!(values_to_ranges(&[0, 1, 2, 5, 6]), vec![(0, 2), (5, 6)]);
        // Unsorted input
        assert_eq!(values_to_ranges(&[5, 0, 1, 6, 2]), vec![(0, 2), (5, 6)]);
        // Empty
        assert_eq!(values_to_ranges(&[]), vec![]);
    }

    #[test]
    fn test_nested_mux_extended_export() {
        // Test catalog with nested mux (S0 -> S1 -> signals)
        let toml = r#"
[meta]
name = "NestedMuxTest"
version = 1
default_endianness = "little"

[frame.can."0x200"]
length = 8
transmitter = "ECU1"

[frame.can."0x200".mux]
name = "S0"
start_bit = 0
bit_length = 4

[frame.can."0x200".mux."0"]
signals = [
    { name = "Signal_A", start_bit = 16, bit_length = 8 },
]

[frame.can."0x200".mux."0".mux]
name = "S1"
start_bit = 4
bit_length = 4

[frame.can."0x200".mux."0".mux."1"]
signals = [
    { name = "Signal_B", start_bit = 24, bit_length = 8 },
]

[frame.can."0x200".mux."0".mux."2"]
signals = [
    { name = "Signal_C", start_bit = 24, bit_length = 8 },
]

[frame.can."0x200".mux."1"]
signals = [
    { name = "Signal_D", start_bit = 16, bit_length = 16 },
]
"#;
        let result =
            render_catalog_as_dbc_with_mode(toml, "Vector__XXX", MuxExportMode::Extended).unwrap();

        // Should have root multiplexor S0 with M tag
        assert!(result.contains("SG_ S0 M :"), "Missing root multiplexor S0");

        // Should have nested multiplexor S1 with mNM tag (multiplexed AND multiplexor)
        assert!(
            result.contains("SG_ S1 m0M :"),
            "Missing nested multiplexor S1 with m0M"
        );

        // Should have SG_MUL_VAL_ entries
        assert!(result.contains("SG_MUL_VAL_"), "Missing SG_MUL_VAL_ section");

        // S1 depends on S0
        assert!(
            result.contains("SG_MUL_VAL_ 512 S1 S0 0-0;"),
            "Missing SG_MUL_VAL_ for S1 -> S0"
        );

        // Signal_B and Signal_C depend on S1
        assert!(
            result.contains("SG_MUL_VAL_ 512 Signal_B S1 1-1;"),
            "Missing SG_MUL_VAL_ for Signal_B -> S1"
        );
        assert!(
            result.contains("SG_MUL_VAL_ 512 Signal_C S1 2-2;"),
            "Missing SG_MUL_VAL_ for Signal_C -> S1"
        );
    }

    #[test]
    fn test_nested_mux_flattened_export() {
        // Same catalog but with flattened mode
        let toml = r#"
[meta]
name = "NestedMuxTest"
version = 1
default_endianness = "little"

[frame.can."0x200"]
length = 8
transmitter = "ECU1"

[frame.can."0x200".mux]
name = "MUX"
start_bit = 0
bit_length = 4

[frame.can."0x200".mux."0"]
signals = [
    { name = "Signal_A", start_bit = 16, bit_length = 8 },
]

[frame.can."0x200".mux."0".mux]
name = "SUB"
start_bit = 4
bit_length = 4

[frame.can."0x200".mux."0".mux."1"]
signals = [
    { name = "Signal_B", start_bit = 24, bit_length = 8 },
]
"#;
        let result =
            render_catalog_as_dbc_with_mode(toml, "Vector__XXX", MuxExportMode::Flattened).unwrap();

        // Should have single multiplexor with combined bit length
        assert!(result.contains("SG_ MUX M :"), "Missing flattened multiplexor");

        // Should NOT have SG_MUL_VAL_ entries (note: NS_ section lists SG_MUL_VAL_ as a keyword)
        assert!(
            !result.contains("SG_MUL_VAL_ 512"),
            "Flattened mode should not have SG_MUL_VAL_ entries"
        );

        // Signals should use composite values (outer << inner_bits | inner)
        // For mux case 0 with nested case 1: composite = (0 << 4) | 1 = 1
        assert!(
            result.contains("Signal_B m1 :"),
            "Missing Signal_B with composite mux value"
        );
    }

    #[test]
    fn test_comments_export() {
        // Test that notes are exported as CM_ comments
        let toml = r#"
[meta]
name = "CommentsTest"
version = 1
default_endianness = "little"

[frame.can."0x100"]
length = 8
transmitter = "ECU1"
notes = "This is a frame comment"
signal = [
    { name = "Speed", start_bit = 0, bit_length = 16, notes = "Vehicle speed in km/h" },
    { name = "RPM", start_bit = 16, bit_length = 16 },
]

[frame.can."0x200"]
length = 8
notes = "Another frame"
signal = [
    { name = "Temp", start_bit = 0, bit_length = 8, notes = ["Multi-line", "comment here"] },
]
"#;
        let result = render_catalog_as_dbc(toml, "Vector__XXX").unwrap();

        // Check frame comments
        assert!(
            result.contains("CM_ BO_ 256 \"This is a frame comment\";"),
            "Missing frame 0x100 comment"
        );
        assert!(
            result.contains("CM_ BO_ 512 \"Another frame\";"),
            "Missing frame 0x200 comment"
        );

        // Check signal comments
        assert!(
            result.contains("CM_ SG_ 256 Speed \"Vehicle speed in km/h\";"),
            "Missing Speed signal comment"
        );

        // Multi-line notes should be joined with space
        assert!(
            result.contains("CM_ SG_ 512 Temp \"Multi-line comment here\";"),
            "Missing Temp signal comment with joined multi-line notes"
        );

        // RPM has no notes, so should not have a comment
        assert!(
            !result.contains("CM_ SG_ 256 RPM"),
            "RPM should not have a comment"
        );
    }

    #[test]
    fn test_comments_escape_quotes() {
        // Test that quotes in notes are properly escaped
        let toml = r#"
[meta]
name = "EscapeTest"
version = 1

[frame.can."0x100"]
length = 8
notes = "Frame with \"quotes\" inside"
signal = [
    { name = "Sig", start_bit = 0, bit_length = 8, notes = "Signal \"test\"" },
]
"#;
        let result = render_catalog_as_dbc(toml, "Vector__XXX").unwrap();

        // Check escaped quotes
        assert!(
            result.contains(r#"CM_ BO_ 256 "Frame with \"quotes\" inside";"#),
            "Frame comment should have escaped quotes"
        );
        assert!(
            result.contains(r#"CM_ SG_ 256 Sig "Signal \"test\"";"#),
            "Signal comment should have escaped quotes"
        );
    }

    #[test]
    fn test_mirror_frames_export() {
        // Test that mirror frames inherit signals from primary frame
        let toml = r#"
[meta]
name = "MirrorTest"
version = 1

[frame.can."0x100"]
length = 8
transmitter = "ECU1"
signal = [
    { name = "Voltage", start_bit = 0, bit_length = 16 },
    { name = "Current", start_bit = 16, bit_length = 16 },
    { name = "Power", start_bit = 32, bit_length = 16 },
]

[frame.can."0x200"]
mirror_of = "0x100"
"#;
        let result = render_catalog_as_dbc(toml, "Vector__XXX").unwrap();

        // Primary frame should have all signals
        assert!(result.contains("BO_ 256 MSG_100:"), "Primary frame should exist");
        assert!(result.contains("SG_ Voltage"), "Primary should have Voltage");
        assert!(result.contains("SG_ Current"), "Primary should have Current");
        assert!(result.contains("SG_ Power"), "Primary should have Power");

        // Mirror frame should also have all signals (inherited)
        assert!(result.contains("BO_ 512 MSG_200:"), "Mirror frame should exist");
        // Both frames should have 3 signals each (6 total SG_ lines)
        let sg_count = result.matches("SG_ ").count();
        assert_eq!(sg_count, 6, "Should have 6 signals total (3 per frame)");
    }

    #[test]
    fn test_mirror_frames_override_by_position() {
        // Test that mirror frame signals override primary signals by bit position
        let toml = r#"
[meta]
name = "MirrorOverrideTest"
version = 1

[frame.can."0x100"]
length = 8
signal = [
    { name = "Voltage", start_bit = 0, bit_length = 16 },
    { name = "Current", start_bit = 16, bit_length = 16 },
]

[frame.can."0x200"]
mirror_of = "0x100"
signal = [
    { name = "CurrentOverride", start_bit = 16, bit_length = 16 },
]
"#;
        let result = render_catalog_as_dbc(toml, "Vector__XXX").unwrap();

        // Primary frame should have original signals
        assert!(result.contains("BO_ 256 MSG_100:"), "Primary frame should exist");

        // Mirror frame should have Voltage (inherited) and CurrentOverride (override)
        assert!(result.contains("BO_ 512 MSG_200:"), "Mirror frame should exist");
        // Check that CurrentOverride appears (from mirror) instead of Current
        assert!(
            result.contains("SG_ CurrentOverride"),
            "Mirror should have overridden signal"
        );
        // Voltage should appear twice (once per frame)
        let voltage_count = result.matches("SG_ Voltage").count();
        assert_eq!(voltage_count, 2, "Voltage should appear in both frames");
    }
}
