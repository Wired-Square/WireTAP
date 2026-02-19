// DBC import module - converts DBC format to CANdor TOML catalog format

use can_dbc::{ByteOrder, Comment, MultiplexIndicator, ValueDescription, ValueType};
use std::collections::HashMap;
use std::fmt::Write;

/// Format an f64 as a TOML float, ensuring a decimal point is always present.
/// Rust's Display for f64 omits the decimal for whole numbers (e.g. `72057600000000000`),
/// which TOML parsers interpret as integers — exceeding JavaScript's safe integer range.
fn fmt_toml_float(v: f64) -> String {
    let s = v.to_string();
    if s.contains('.') || s.contains('e') || s.contains('E') || s.contains("inf") || s.contains("nan") {
        s
    } else {
        format!("{}.0", s)
    }
}

// ============================================================================
// Start bit conversion
// ============================================================================

/// Convert DBC start bit to internal LSB0 start bit.
/// This is the same formula as dbc_export.rs:dbc_start_bit — it is its own inverse.
/// Intel (little, @1): no conversion
/// Motorola (big, @0): 8*B + (7 - b) where B = floor(start/8), b = start % 8
fn convert_start_bit(dbc_start: u64, byte_order: &ByteOrder) -> i32 {
    match byte_order {
        ByteOrder::LittleEndian => dbc_start as i32,
        ByteOrder::BigEndian => {
            let b_byte = dbc_start / 8;
            let b_bit = dbc_start % 8;
            (8 * b_byte + (7 - b_bit)) as i32
        }
    }
}

// ============================================================================
// Physical min/max calculation (mirrors dbc_export.rs:phys_min_max)
// ============================================================================

fn raw_min_max(bit_length: u64, signed: bool) -> (i64, i64) {
    let bits = (bit_length as u32).clamp(1, 63);
    if signed {
        let hi = (1_i64 << (bits - 1)) - 1;
        let lo = -(1_i64 << (bits - 1));
        (lo, hi)
    } else if bits >= 63 {
        (0, i64::MAX)
    } else {
        (0, (1_i64 << bits) - 1)
    }
}

fn calculated_phys_min_max(bit_length: u64, signed: bool, factor: f64, offset: f64) -> (f64, f64) {
    let (lo, hi) = raw_min_max(bit_length, signed);
    let lo_p = lo as f64 * factor + offset;
    let hi_p = hi as f64 * factor + offset;
    if lo_p <= hi_p {
        (lo_p, hi_p)
    } else {
        (hi_p, lo_p)
    }
}

fn approx_eq(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

// ============================================================================
// Frame ID formatting
// ============================================================================

fn format_frame_id(id: u32) -> String {
    if id > 0x7FF {
        format!("0x{:08X}", id)
    } else {
        format!("0x{:03X}", id)
    }
}

// ============================================================================
// TOML string escaping
// ============================================================================

fn escape_toml_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

// ============================================================================
// Internal signal representation for mux reconstruction
// ============================================================================

#[derive(Debug, Clone)]
struct ImportedSignal {
    name: String,
    start_bit: i32,
    bit_length: u64,
    byte_order_str: String,
    signed: bool,
    factor: f64,
    offset: f64,
    min: f64,
    max: f64,
    unit: String,
    receiver: Option<String>,
    notes: Option<String>,
    enum_values: Option<Vec<(i64, String)>>,
}

#[derive(Debug, Clone)]
struct MuxTree {
    name: String,
    start_bit: i32,
    bit_length: u64,
    cases: Vec<MuxCaseTree>,
}

#[derive(Debug, Clone)]
struct MuxCaseTree {
    value: u64,
    signals: Vec<ImportedSignal>,
    nested_mux: Option<Box<MuxTree>>,
}

// ============================================================================
// Main conversion function
// ============================================================================

/// Convert DBC file content to CANdor TOML catalog content.
pub fn convert_dbc_to_toml(dbc_content: &str) -> Result<String, String> {
    let dbc = can_dbc::Dbc::try_from(dbc_content)
        .map_err(|e| format!("Failed to parse DBC file: {:?}", e))?;

    // Build lookup tables
    let comment_map = build_comment_map(&dbc.comments);
    let value_desc_map = build_value_desc_map(&dbc.value_descriptions);
    let ext_mux_map = build_extended_mux_map(&dbc.extended_multiplex);

    // Detect default byte order (majority wins)
    let default_byte_order = detect_default_byte_order(&dbc.messages);

    // Detect extended IDs and FD
    let has_extended = dbc.messages.iter().any(|m| m.id.raw() > 0x7FF);
    let all_extended = !dbc.messages.is_empty() && dbc.messages.iter().all(|m| m.id.raw() > 0x7FF);
    let has_fd = dbc.messages.iter().any(|m| m.size > 8);
    let all_fd = !dbc.messages.is_empty() && dbc.messages.iter().all(|m| m.size > 8);

    // Collect nodes (filter Vector__XXX)
    let mut nodes: Vec<String> = Vec::new();
    for node in &dbc.nodes {
        let name = &node.0;
        if name != "Vector__XXX" && !name.is_empty() {
            nodes.push(name.clone());
        }
    }
    nodes.sort();
    nodes.dedup();

    // Extract catalog name from DBC version or default
    let version_str = &dbc.version.0;
    let catalog_name = if !version_str.is_empty() && version_str != "\"\"" {
        version_str.trim_matches('"').to_string()
    } else {
        "Imported DBC".to_string()
    };

    // Sort messages by ID
    let mut messages: Vec<_> = dbc.messages.iter().collect();
    messages.sort_by_key(|m| m.id.raw());

    // Start rendering TOML
    let mut out = String::new();

    // [meta]
    writeln!(out, "[meta]").unwrap();
    writeln!(out, "name = \"{}\"", escape_toml_string(&catalog_name)).unwrap();
    writeln!(out, "version = 1").unwrap();
    writeln!(out).unwrap();

    // [meta.can]
    writeln!(out, "[meta.can]").unwrap();
    writeln!(out, "default_byte_order = \"{}\"", default_byte_order).unwrap();
    if all_extended {
        writeln!(out, "default_extended = true").unwrap();
    }
    if all_fd {
        writeln!(out, "default_fd = true").unwrap();
    }
    writeln!(out).unwrap();

    // [node.*]
    for node_name in &nodes {
        writeln!(out, "[node.{}]", node_name).unwrap();
    }
    if !nodes.is_empty() {
        writeln!(out).unwrap();
    }

    // Process each message
    for message in &messages {
        let raw_id = message.id.raw();
        let frame_id_str = format_frame_id(raw_id);

        // Frame header
        writeln!(out, "[frame.can.\"{}\"]", frame_id_str).unwrap();

        // Frame name (if not the default MSG_xxx pattern)
        if !message.name.is_empty() {
            writeln!(out, "name = \"{}\"", escape_toml_string(&message.name)).unwrap();
        }

        // Length
        writeln!(out, "length = {}", message.size).unwrap();

        // Extended flag (per-frame, only if not all-extended default)
        if !all_extended && has_extended && raw_id > 0x7FF {
            writeln!(out, "extended = true").unwrap();
        }

        // FD flag (per-frame, only if not all-fd default)
        if !all_fd && has_fd && message.size > 8 {
            writeln!(out, "fd = true").unwrap();
        }

        // Transmitter
        if let can_dbc::Transmitter::NodeName(ref name) = message.transmitter {
            if name != "Vector__XXX" && !name.is_empty() {
                writeln!(out, "transmitter = \"{}\"", escape_toml_string(name)).unwrap();
            }
        }

        // Frame notes (from CM_ BO_)
        if let Some(comment) = comment_map.get(&CommentKey::Message(raw_id)) {
            writeln!(out, "notes = \"{}\"", escape_toml_string(comment)).unwrap();
        }

        // Classify signals by mux role
        let mut plain_signals: Vec<ImportedSignal> = Vec::new();
        let mut mux_selector: Option<ImportedSignal> = None;
        let mut muxed_by_value: HashMap<u64, Vec<ImportedSignal>> = HashMap::new();
        let mut nested_selectors: HashMap<u64, ImportedSignal> = HashMap::new();

        for signal in &message.signals {
            let imported = convert_signal(
                signal,
                raw_id,
                &default_byte_order,
                &comment_map,
                &value_desc_map,
            );

            match signal.multiplexer_indicator {
                MultiplexIndicator::Plain => {
                    plain_signals.push(imported);
                }
                MultiplexIndicator::Multiplexor => {
                    mux_selector = Some(imported);
                }
                MultiplexIndicator::MultiplexedSignal(n) => {
                    muxed_by_value.entry(n).or_default().push(imported);
                }
                MultiplexIndicator::MultiplexorAndMultiplexedSignal(n) => {
                    nested_selectors.insert(n, imported);
                }
            }
        }

        // Render plain (non-muxed) signals
        if !plain_signals.is_empty() {
            // Sort by start_bit
            plain_signals.sort_by_key(|s| s.start_bit);
            writeln!(out).unwrap();
            for signal in &plain_signals {
                render_signal_toml(&mut out, signal, &frame_id_str, &default_byte_order);
            }
        }

        // Render mux structure
        if let Some(ref selector) = mux_selector {
            writeln!(out).unwrap();

            // Build mux tree (possibly with nested mux from extended_multiplex)
            let mux_tree = build_mux_tree(
                selector,
                &muxed_by_value,
                &nested_selectors,
                raw_id,
                &ext_mux_map,
                &message.signals,
                &default_byte_order,
                &comment_map,
                &value_desc_map,
            );

            render_mux_toml(
                &mut out,
                &mux_tree,
                &format!("frame.can.\"{}\"", frame_id_str),
                &default_byte_order,
            );
        } else if plain_signals.is_empty() {
            // No signals at all — add empty signals array
            writeln!(out, "signals = []").unwrap();
        }

        writeln!(out).unwrap();
    }

    Ok(out)
}

// ============================================================================
// Comment / value description lookup
// ============================================================================

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
enum CommentKey {
    Message(u32),
    Signal(u32, String),
}

fn build_comment_map(comments: &[Comment]) -> HashMap<CommentKey, String> {
    let mut map = HashMap::new();
    for comment in comments {
        match comment {
            Comment::Message { id, comment, .. } => {
                map.insert(CommentKey::Message(id.raw()), comment.clone());
            }
            Comment::Signal {
                message_id,
                name,
                comment,
                ..
            } => {
                map.insert(
                    CommentKey::Signal(message_id.raw(), name.clone()),
                    comment.clone(),
                );
            }
            _ => {} // Ignore node/env/plain comments
        }
    }
    map
}

fn build_value_desc_map(
    vds: &[ValueDescription],
) -> HashMap<(u32, String), Vec<(i64, String)>> {
    let mut map: HashMap<(u32, String), Vec<(i64, String)>> = HashMap::new();
    for vd in vds {
        if let ValueDescription::Signal {
            message_id,
            name,
            value_descriptions,
            ..
        } = vd
        {
            let mut entries: Vec<(i64, String)> = value_descriptions
                .iter()
                .map(|v| (v.id as i64, v.description.clone()))
                .collect();
            entries.sort_by_key(|(k, _)| *k);
            map.insert((message_id.raw(), name.clone()), entries);
        }
    }
    map
}

fn build_extended_mux_map(
    ext_mux: &[can_dbc::ExtendedMultiplex],
) -> HashMap<u32, Vec<ExtMuxEntry>> {
    let mut map: HashMap<u32, Vec<ExtMuxEntry>> = HashMap::new();
    for em in ext_mux {
        let msg_id = em.message_id.raw();
        let entry = ExtMuxEntry {
            signal_name: em.signal_name.clone(),
            multiplexor_name: em.multiplexor_signal_name.clone(),
            ranges: em
                .mappings
                .iter()
                .map(|m| (m.min_value, m.max_value))
                .collect(),
        };
        map.entry(msg_id).or_default().push(entry);
    }
    map
}

#[derive(Debug, Clone)]
struct ExtMuxEntry {
    signal_name: String,
    multiplexor_name: String,
    ranges: Vec<(u64, u64)>,
}

// ============================================================================
// Signal conversion
// ============================================================================

fn convert_signal(
    signal: &can_dbc::Signal,
    msg_id: u32,
    _default_byte_order: &str,
    comment_map: &HashMap<CommentKey, String>,
    value_desc_map: &HashMap<(u32, String), Vec<(i64, String)>>,
) -> ImportedSignal {
    let byte_order_str = match signal.byte_order {
        ByteOrder::LittleEndian => "little".to_string(),
        ByteOrder::BigEndian => "big".to_string(),
    };
    let signed = matches!(signal.value_type, ValueType::Signed);
    let start_bit = convert_start_bit(signal.start_bit, &signal.byte_order);

    let notes = comment_map
        .get(&CommentKey::Signal(msg_id, signal.name.clone()))
        .cloned();

    let enum_values = value_desc_map
        .get(&(msg_id, signal.name.clone()))
        .cloned();

    let receiver = signal
        .receivers
        .first()
        .filter(|r| r.as_str() != "Vector__XXX" && !r.is_empty())
        .map(|r| r.to_string());

    ImportedSignal {
        name: signal.name.clone(),
        start_bit,
        bit_length: signal.size,
        byte_order_str,
        signed,
        factor: signal.factor,
        offset: signal.offset,
        min: signal.min,
        max: signal.max,
        unit: signal.unit.clone(),
        receiver,
        notes,
        enum_values,
    }
}

// ============================================================================
// Default byte order detection
// ============================================================================

fn detect_default_byte_order(messages: &[can_dbc::Message]) -> String {
    let mut little = 0usize;
    let mut big = 0usize;
    for msg in messages {
        for sig in &msg.signals {
            match sig.byte_order {
                ByteOrder::LittleEndian => little += 1,
                ByteOrder::BigEndian => big += 1,
            }
        }
    }
    if big > little {
        "big".to_string()
    } else {
        "little".to_string()
    }
}

// ============================================================================
// TOML rendering for signals
// ============================================================================

fn render_signal_toml(
    out: &mut String,
    signal: &ImportedSignal,
    frame_id_str: &str,
    default_byte_order: &str,
) {
    writeln!(out, "[[frame.can.\"{}\".signals]]", frame_id_str).unwrap();
    writeln!(out, "name = \"{}\"", escape_toml_string(&signal.name)).unwrap();
    writeln!(out, "start_bit = {}", signal.start_bit).unwrap();
    writeln!(out, "bit_length = {}", signal.bit_length).unwrap();

    if signal.signed {
        writeln!(out, "signed = true").unwrap();
    }

    if signal.byte_order_str != default_byte_order {
        writeln!(out, "endianness = \"{}\"", signal.byte_order_str).unwrap();
    }

    if !approx_eq(signal.factor, 1.0) {
        writeln!(out, "factor = {}", fmt_toml_float(signal.factor)).unwrap();
    }

    if !approx_eq(signal.offset, 0.0) {
        writeln!(out, "offset = {}", fmt_toml_float(signal.offset)).unwrap();
    }

    if !signal.unit.is_empty() {
        writeln!(out, "unit = \"{}\"", escape_toml_string(&signal.unit)).unwrap();
    }

    // Omit min/max if they match the calculated physical range
    let (calc_min, calc_max) =
        calculated_phys_min_max(signal.bit_length, signal.signed, signal.factor, signal.offset);
    if !approx_eq(signal.min, calc_min) || !approx_eq(signal.max, calc_max) {
        writeln!(out, "min = {}", fmt_toml_float(signal.min)).unwrap();
        writeln!(out, "max = {}", fmt_toml_float(signal.max)).unwrap();
    }

    if let Some(ref receiver) = signal.receiver {
        writeln!(out, "receiver = \"{}\"", escape_toml_string(receiver)).unwrap();
    }

    // Enum values → format = "enum" + enum table
    if let Some(ref vals) = signal.enum_values {
        if !vals.is_empty() {
            writeln!(out, "format = \"enum\"").unwrap();
            writeln!(out).unwrap();
            writeln!(
                out,
                "[frame.can.\"{}\".signals.enum]",
                frame_id_str
            )
            .unwrap();
            for (k, v) in vals {
                writeln!(out, "{} = \"{}\"", k, escape_toml_string(v)).unwrap();
            }
        }
    }

    if let Some(ref notes) = signal.notes {
        writeln!(out, "notes = \"{}\"", escape_toml_string(notes)).unwrap();
    }
}

// ============================================================================
// Mux signal rendering (inside mux cases)
// ============================================================================

fn render_mux_signal_toml(
    out: &mut String,
    signal: &ImportedSignal,
    case_path: &str,
    default_byte_order: &str,
) {
    writeln!(out, "[[{}.signals]]", case_path).unwrap();
    writeln!(out, "name = \"{}\"", escape_toml_string(&signal.name)).unwrap();
    writeln!(out, "start_bit = {}", signal.start_bit).unwrap();
    writeln!(out, "bit_length = {}", signal.bit_length).unwrap();

    if signal.signed {
        writeln!(out, "signed = true").unwrap();
    }

    if signal.byte_order_str != default_byte_order {
        writeln!(out, "endianness = \"{}\"", signal.byte_order_str).unwrap();
    }

    if !approx_eq(signal.factor, 1.0) {
        writeln!(out, "factor = {}", fmt_toml_float(signal.factor)).unwrap();
    }

    if !approx_eq(signal.offset, 0.0) {
        writeln!(out, "offset = {}", fmt_toml_float(signal.offset)).unwrap();
    }

    if !signal.unit.is_empty() {
        writeln!(out, "unit = \"{}\"", escape_toml_string(&signal.unit)).unwrap();
    }

    let (calc_min, calc_max) =
        calculated_phys_min_max(signal.bit_length, signal.signed, signal.factor, signal.offset);
    if !approx_eq(signal.min, calc_min) || !approx_eq(signal.max, calc_max) {
        writeln!(out, "min = {}", fmt_toml_float(signal.min)).unwrap();
        writeln!(out, "max = {}", fmt_toml_float(signal.max)).unwrap();
    }

    if let Some(ref receiver) = signal.receiver {
        writeln!(out, "receiver = \"{}\"", escape_toml_string(receiver)).unwrap();
    }

    if let Some(ref vals) = signal.enum_values {
        if !vals.is_empty() {
            writeln!(out, "format = \"enum\"").unwrap();
            writeln!(out).unwrap();
            writeln!(out, "[{}.signals.enum]", case_path).unwrap();
            for (k, v) in vals {
                writeln!(out, "{} = \"{}\"", k, escape_toml_string(v)).unwrap();
            }
        }
    }

    if let Some(ref notes) = signal.notes {
        writeln!(out, "notes = \"{}\"", escape_toml_string(notes)).unwrap();
    }
}

// ============================================================================
// Mux tree building
// ============================================================================

fn build_mux_tree(
    selector: &ImportedSignal,
    muxed_by_value: &HashMap<u64, Vec<ImportedSignal>>,
    nested_selectors: &HashMap<u64, ImportedSignal>,
    msg_id: u32,
    ext_mux_map: &HashMap<u32, Vec<ExtMuxEntry>>,
    all_signals: &[can_dbc::Signal],
    default_byte_order: &str,
    comment_map: &HashMap<CommentKey, String>,
    value_desc_map: &HashMap<(u32, String), Vec<(i64, String)>>,
) -> MuxTree {
    // Check if we have extended mux entries for this message
    let has_ext_mux = ext_mux_map.contains_key(&msg_id);

    if has_ext_mux {
        build_mux_tree_extended(
            selector,
            msg_id,
            ext_mux_map,
            all_signals,
            default_byte_order,
            comment_map,
            value_desc_map,
        )
    } else {
        build_mux_tree_standard(selector, muxed_by_value, nested_selectors)
    }
}

fn build_mux_tree_standard(
    selector: &ImportedSignal,
    muxed_by_value: &HashMap<u64, Vec<ImportedSignal>>,
    nested_selectors: &HashMap<u64, ImportedSignal>,
) -> MuxTree {
    // Collect all case values and sort
    let mut case_values: Vec<u64> = muxed_by_value.keys().copied().collect();
    for k in nested_selectors.keys() {
        if !case_values.contains(k) {
            case_values.push(*k);
        }
    }
    case_values.sort();

    let mut cases = Vec::new();
    for case_val in case_values {
        let mut signals = muxed_by_value
            .get(&case_val)
            .cloned()
            .unwrap_or_default();
        signals.sort_by_key(|s| s.start_bit);

        let nested_mux = nested_selectors.get(&case_val).map(|nested_sel| {
            // For standard mux with MultiplexorAndMultiplexedSignal,
            // we don't have case data for the nested mux. Create an empty tree.
            // The signals controlled by this nested selector would need
            // SG_MUL_VAL_ entries to be properly reconstructed.
            Box::new(MuxTree {
                name: nested_sel.name.clone(),
                start_bit: nested_sel.start_bit,
                bit_length: nested_sel.bit_length,
                cases: Vec::new(),
            })
        });

        cases.push(MuxCaseTree {
            value: case_val,
            signals,
            nested_mux,
        });
    }

    MuxTree {
        name: selector.name.clone(),
        start_bit: selector.start_bit,
        bit_length: selector.bit_length,
        cases,
    }
}

fn build_mux_tree_extended(
    root_selector: &ImportedSignal,
    msg_id: u32,
    ext_mux_map: &HashMap<u32, Vec<ExtMuxEntry>>,
    all_signals: &[can_dbc::Signal],
    default_byte_order: &str,
    comment_map: &HashMap<CommentKey, String>,
    value_desc_map: &HashMap<(u32, String), Vec<(i64, String)>>,
) -> MuxTree {
    let ext_entries = match ext_mux_map.get(&msg_id) {
        Some(entries) => entries,
        None => {
            return MuxTree {
                name: root_selector.name.clone(),
                start_bit: root_selector.start_bit,
                bit_length: root_selector.bit_length,
                cases: Vec::new(),
            };
        }
    };

    // Build a map of signal_name -> ImportedSignal for all signals in this message
    let mut signal_map: HashMap<String, ImportedSignal> = HashMap::new();
    let mut signal_mux_indicator: HashMap<String, MultiplexIndicator> = HashMap::new();
    for sig in all_signals {
        let imported = convert_signal(sig, msg_id, default_byte_order, comment_map, value_desc_map);
        signal_map.insert(sig.name.clone(), imported);
        signal_mux_indicator.insert(sig.name.clone(), sig.multiplexer_indicator);
    }

    // Build dependency map: signal_name -> (multiplexor_name, case_values)
    let mut dep_map: HashMap<String, (String, Vec<u64>)> = HashMap::new();
    for entry in ext_entries {
        let values: Vec<u64> = entry
            .ranges
            .iter()
            .flat_map(|&(min, max)| min..=max)
            .collect();
        dep_map.insert(
            entry.signal_name.clone(),
            (entry.multiplexor_name.clone(), values),
        );
    }

    // Identify which signals are multiplexors (have dependents)
    let mut is_multiplexor: std::collections::HashSet<String> = std::collections::HashSet::new();
    is_multiplexor.insert(root_selector.name.clone());
    for entry in ext_entries {
        is_multiplexor.insert(entry.multiplexor_name.clone());
    }

    // Recursively build the mux tree starting from the root selector
    build_mux_subtree(
        &root_selector.name,
        root_selector.start_bit,
        root_selector.bit_length,
        &dep_map,
        &signal_map,
        &is_multiplexor,
    )
}

fn build_mux_subtree(
    selector_name: &str,
    selector_start_bit: i32,
    selector_bit_length: u64,
    dep_map: &HashMap<String, (String, Vec<u64>)>,
    signal_map: &HashMap<String, ImportedSignal>,
    is_multiplexor: &std::collections::HashSet<String>,
) -> MuxTree {
    // Find all signals that depend on this selector
    let mut case_signals: HashMap<u64, Vec<String>> = HashMap::new();
    for (sig_name, (mux_name, values)) in dep_map {
        if mux_name == selector_name {
            for &val in values {
                case_signals.entry(val).or_default().push(sig_name.clone());
            }
        }
    }

    // Sort case values
    let mut case_values: Vec<u64> = case_signals.keys().copied().collect();
    case_values.sort();

    let mut cases = Vec::new();
    for case_val in case_values {
        let sig_names = case_signals.get(&case_val).cloned().unwrap_or_default();

        let mut signals = Vec::new();
        let mut nested_mux: Option<Box<MuxTree>> = None;

        for sig_name in &sig_names {
            if is_multiplexor.contains(sig_name) && sig_name != selector_name {
                // This signal is a nested mux selector
                if let Some(nested_sig) = signal_map.get(sig_name) {
                    nested_mux = Some(Box::new(build_mux_subtree(
                        sig_name,
                        nested_sig.start_bit,
                        nested_sig.bit_length,
                        dep_map,
                        signal_map,
                        is_multiplexor,
                    )));
                }
            } else if let Some(sig) = signal_map.get(sig_name) {
                signals.push(sig.clone());
            }
        }

        signals.sort_by_key(|s| s.start_bit);

        cases.push(MuxCaseTree {
            value: case_val,
            signals,
            nested_mux,
        });
    }

    MuxTree {
        name: selector_name.to_string(),
        start_bit: selector_start_bit,
        bit_length: selector_bit_length,
        cases,
    }
}

// ============================================================================
// Mux TOML rendering
// ============================================================================

fn render_mux_toml(
    out: &mut String,
    mux: &MuxTree,
    parent_path: &str,
    default_byte_order: &str,
) {
    let mux_path = format!("{}.mux", parent_path);

    writeln!(out, "[{mux_path}]").unwrap();
    writeln!(out, "name = \"{}\"", escape_toml_string(&mux.name)).unwrap();
    writeln!(out, "start_bit = {}", mux.start_bit).unwrap();
    writeln!(out, "bit_length = {}", mux.bit_length).unwrap();

    for case in &mux.cases {
        let case_path = format!("{}.\"{}\"", mux_path, case.value);

        // Render signals in this case
        for signal in &case.signals {
            writeln!(out).unwrap();
            render_mux_signal_toml(out, signal, &case_path, default_byte_order);
        }

        // Render nested mux if present
        if let Some(ref nested) = case.nested_mux {
            if !nested.cases.is_empty() {
                writeln!(out).unwrap();
                render_mux_toml(out, nested, &case_path, default_byte_order);
            }
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_start_bit_conversion_little() {
        // Intel/little-endian: no conversion
        assert_eq!(convert_start_bit(0, &ByteOrder::LittleEndian), 0);
        assert_eq!(convert_start_bit(8, &ByteOrder::LittleEndian), 8);
        assert_eq!(convert_start_bit(16, &ByteOrder::LittleEndian), 16);
    }

    #[test]
    fn test_start_bit_conversion_big() {
        // Motorola/big-endian: 8*B + (7 - b) — same formula is its own inverse
        assert_eq!(convert_start_bit(7, &ByteOrder::BigEndian), 0); // B=0, b=7 -> 0
        assert_eq!(convert_start_bit(0, &ByteOrder::BigEndian), 7); // B=0, b=0 -> 7
        assert_eq!(convert_start_bit(15, &ByteOrder::BigEndian), 8); // B=1, b=7 -> 8
    }

    #[test]
    fn test_simple_catalog() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_: ECU1

BO_ 256 EngineData: 8 ECU1
 SG_ Speed : 0|16@1+ (0.1,0) [0|6553.5] "km/h" Vector__XXX
 SG_ RPM : 16|16@1+ (1,0) [0|65535] "rpm" Vector__XXX

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        assert!(result.contains("[meta]"), "Missing [meta] section");
        assert!(
            result.contains("default_byte_order = \"little\""),
            "Missing default_byte_order"
        );
        assert!(
            result.contains("[frame.can.\"0x100\"]"),
            "Missing frame 0x100"
        );
        assert!(result.contains("name = \"EngineData\""), "Missing frame name");
        assert!(result.contains("length = 8"), "Missing length");
        assert!(
            result.contains("transmitter = \"ECU1\""),
            "Missing transmitter"
        );
        assert!(result.contains("name = \"Speed\""), "Missing Speed signal");
        assert!(result.contains("name = \"RPM\""), "Missing RPM signal");
        assert!(result.contains("factor = 0.1"), "Missing factor");
        assert!(
            result.contains("unit = \"km/h\""),
            "Missing unit: got {}",
            result
        );
    }

    #[test]
    fn test_signed_signal() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_:

BO_ 512 TempData: 8 Vector__XXX
 SG_ Temperature : 0|16@1- (0.1,-40) [-40|6513.5] "degC" Vector__XXX

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        assert!(result.contains("signed = true"), "Missing signed = true");
        assert!(result.contains("offset = -40"), "Missing offset");
    }

    #[test]
    fn test_enum_values() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_:

BO_ 256 Status: 8 Vector__XXX
 SG_ Mode : 0|4@1+ (1,0) [0|15] "" Vector__XXX

VAL_ 256 Mode 0 "Off" 1 "Standby" 2 "Run" ;

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        assert!(
            result.contains("format = \"enum\""),
            "Missing format = enum"
        );
        assert!(result.contains("0 = \"Off\""), "Missing enum value Off");
        assert!(
            result.contains("1 = \"Standby\""),
            "Missing enum value Standby"
        );
        assert!(result.contains("2 = \"Run\""), "Missing enum value Run");
    }

    #[test]
    fn test_comments() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_:

BO_ 256 EngineData: 8 Vector__XXX
 SG_ Speed : 0|16@1+ (1,0) [0|65535] "km/h" Vector__XXX

CM_ BO_ 256 "Engine data frame";
CM_ SG_ 256 Speed "Vehicle speed in km/h";

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        // Frame comment
        assert!(
            result.contains("notes = \"Engine data frame\""),
            "Missing frame comment: got {}",
            result
        );
        // Signal comment
        assert!(
            result.contains("notes = \"Vehicle speed in km/h\""),
            "Missing signal comment: got {}",
            result
        );
    }

    #[test]
    fn test_standard_mux() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_:

BO_ 512 MuxFrame: 8 Vector__XXX
 SG_ MuxSelector M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Signal_A m0 : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Signal_B m1 : 8|16@1+ (1,0) [0|65535] "" Vector__XXX

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        assert!(
            result.contains(".mux]"),
            "Missing mux section: got {}",
            result
        );
        assert!(
            result.contains("name = \"MuxSelector\""),
            "Missing mux name"
        );
        assert!(result.contains("start_bit = 0"), "Missing mux start_bit");
        assert!(result.contains("bit_length = 8"), "Missing mux bit_length");
        assert!(
            result.contains("name = \"Signal_A\""),
            "Missing Signal_A in mux case 0"
        );
        assert!(
            result.contains("name = \"Signal_B\""),
            "Missing Signal_B in mux case 1"
        );
    }

    #[test]
    fn test_big_endian_default() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_:

BO_ 256 Data: 8 Vector__XXX
 SG_ Sig1 : 7|16@0+ (1,0) [0|65535] "" Vector__XXX
 SG_ Sig2 : 23|8@0+ (1,0) [0|255] "" Vector__XXX

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        // Both signals are big-endian, so default should be big
        assert!(
            result.contains("default_byte_order = \"big\""),
            "Should detect big endian as default: got {}",
            result
        );
        // Signals should NOT have explicit endianness (matches default)
        assert!(
            !result.contains("endianness ="),
            "Should not have explicit endianness when matching default"
        );
    }

    #[test]
    fn test_omit_default_factor_offset() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_:

BO_ 256 Data: 8 Vector__XXX
 SG_ Counter : 0|8@1+ (1,0) [0|255] "" Vector__XXX

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        // Factor=1.0 and offset=0.0 should be omitted
        assert!(
            !result.contains("factor ="),
            "Factor 1.0 should be omitted"
        );
        assert!(
            !result.contains("offset ="),
            "Offset 0.0 should be omitted"
        );
    }

    #[test]
    fn test_nodes() {
        let dbc = r#"VERSION ""
NS_ :

BS_:
BU_: ECU1 ECU2 Vector__XXX

BO_ 256 Data: 8 ECU1
 SG_ Sig : 0|8@1+ (1,0) [0|255] "" ECU2

"#;
        let result = convert_dbc_to_toml(dbc).unwrap();

        assert!(result.contains("[node.ECU1]"), "Missing node ECU1");
        assert!(result.contains("[node.ECU2]"), "Missing node ECU2");
        // Vector__XXX should be filtered out
        assert!(
            !result.contains("Vector__XXX"),
            "Vector__XXX should be filtered"
        );
    }

    #[test]
    fn test_roundtrip_simple() {
        // Create a simple TOML, export to DBC, import back, verify key properties
        let toml_input = r#"[meta]
name = "RoundtripTest"
version = 1
default_endianness = "little"

[frame.can."0x100"]
length = 8
transmitter = "ECU1"
signal = [
    { name = "Speed", start_bit = 0, bit_length = 16, factor = 0.1, unit = "km/h" },
    { name = "RPM", start_bit = 16, bit_length = 16 },
]
"#;
        // Export to DBC
        let dbc =
            crate::dbc_export::render_catalog_as_dbc(toml_input, "Vector__XXX").unwrap();

        // Import back from DBC
        let toml_output = convert_dbc_to_toml(&dbc).unwrap();

        // Verify key properties survived the roundtrip
        assert!(toml_output.contains("\"0x100\""), "Frame ID 0x100 missing");
        assert!(toml_output.contains("length = 8"), "Length missing");
        assert!(
            toml_output.contains("transmitter = \"ECU1\""),
            "Transmitter missing"
        );
        assert!(
            toml_output.contains("name = \"Speed\""),
            "Speed signal missing"
        );
        assert!(
            toml_output.contains("name = \"RPM\""),
            "RPM signal missing"
        );
        assert!(
            toml_output.contains("factor = 0.1"),
            "Factor 0.1 missing: got {}",
            toml_output
        );
        assert!(
            toml_output.contains("unit = \"km/h\""),
            "Unit missing"
        );
        assert!(toml_output.contains("start_bit = 0"), "Start bit 0 missing");
        assert!(
            toml_output.contains("start_bit = 16"),
            "Start bit 16 missing"
        );
    }

    #[test]
    fn test_roundtrip_mux() {
        let toml_input = r#"[meta]
name = "MuxRoundtrip"
version = 1
default_endianness = "little"

[frame.can."0x200"]
length = 8
transmitter = "ECU1"
signals = []

[frame.can."0x200".mux]
name = "MuxSel"
start_bit = 0
bit_length = 8

[[frame.can."0x200".mux."0".signals]]
name = "Signal_A"
start_bit = 8
bit_length = 8

[[frame.can."0x200".mux."1".signals]]
name = "Signal_B"
start_bit = 8
bit_length = 16
"#;
        let dbc =
            crate::dbc_export::render_catalog_as_dbc(toml_input, "Vector__XXX").unwrap();
        let toml_output = convert_dbc_to_toml(&dbc).unwrap();

        assert!(toml_output.contains("\"0x200\""), "Frame ID 0x200 missing");
        assert!(
            toml_output.contains("name = \"MuxSel\""),
            "Mux selector name missing: got {}",
            toml_output
        );
        assert!(
            toml_output.contains("name = \"Signal_A\""),
            "Signal_A missing"
        );
        assert!(
            toml_output.contains("name = \"Signal_B\""),
            "Signal_B missing"
        );
    }
}
