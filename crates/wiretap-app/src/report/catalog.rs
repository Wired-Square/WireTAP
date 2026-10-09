// crates/wiretap-app/src/report/catalog.rs
//
// The catalogue report: every protocol's frames as the catalogue authors them,
// over `wiretap_catalog::summary`.

use wiretap_catalog::model::{Confidence, Endianness, Protocol, Signal};
use wiretap_catalog::summary::{CatalogSummary, FrameRow, MuxRow, SignalRow};

use super::{count, grouped, Block, Cell, Doc, ReportFormat};

/// The report on a catalogue's text, a legacy `[id]` table read as CAN.
pub fn render(text: &str, format: ReportFormat) -> Result<String, String> {
    let summary = CatalogSummary::from_text(text).map_err(|e| e.to_string())?;
    Ok(report(&summary).render(format))
}

pub fn report(summary: &CatalogSummary) -> Doc {
    let name = summary.name.trim();
    let title = format!("Catalogue Report — {}", if name.is_empty() { "Untitled" } else { name });
    let mut blocks = vec![Block::Section("Summary".into(), vec![Block::Fields(overview(summary))])];
    for protocol in [Protocol::Can, Protocol::Modbus, Protocol::Serial] {
        let frames: Vec<Block> = summary
            .frames
            .iter()
            .filter(|f| f.protocol == protocol)
            .map(frame)
            .collect();
        if !frames.is_empty() {
            blocks.push(Block::Section(format!("{} frames", protocol_name(protocol)), frames));
        }
    }
    Doc { title, blocks }
}

fn protocol_name(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Can => "CAN",
        Protocol::Modbus => "Modbus",
        Protocol::Serial => "Serial",
    }
}

fn order_name(order: Endianness) -> &'static str {
    match order {
        Endianness::Little => "little-endian",
        Endianness::Big => "big-endian",
    }
}

fn overview(summary: &CatalogSummary) -> Vec<(&'static str, String)> {
    let c = &summary.counts;
    let present: Vec<(Protocol, usize)> = [
        (Protocol::Can, c.frames.can),
        (Protocol::Modbus, c.frames.modbus),
        (Protocol::Serial, c.frames.serial),
    ]
    .into_iter()
    .filter(|(_, n)| *n > 0)
    .collect();
    let total = present.iter().map(|(_, n)| n).sum();
    let mut frames = count(total, "frame");
    if present.len() > 1 {
        let parts: Vec<String> =
            present.iter().map(|(p, n)| format!("{} {}", grouped(*n), protocol_name(*p))).collect();
        frames += &format!(" ({})", parts.join(", "));
    }
    let d = &summary.defaults;
    let orders: Vec<String> = present
        .iter()
        .map(|(p, _)| {
            let order = match p {
                Protocol::Can => d.can_byte_order,
                Protocol::Modbus => d.modbus_byte_order,
                Protocol::Serial => d.serial_byte_order,
            };
            format!("{} {}", protocol_name(*p), order_name(order))
        })
        .collect();
    let conf = &c.confidence;
    let mut fields = vec![
        ("Version", summary.version.to_string()),
        ("Frames", frames),
        ("Multiplexed", count(c.mux_frames, "frame")),
        ("Signals", format!("{} ({} enum)", grouped(c.signals), grouped(c.enum_signals))),
        (
            "Confidence",
            format!("{} high, {} medium, {} low, {} none", conf.high, conf.medium, conf.low, conf.none),
        ),
    ];
    if !orders.is_empty() {
        fields.push(("Byte order", orders.join(", ")));
    }
    fields
}

fn frame_title(row: &FrameRow) -> String {
    let id = match (row.protocol, row.frame_id) {
        (Protocol::Can, Some(id)) => format!("0x{id:03X}"),
        (Protocol::Modbus, Some(id)) if row.key == id.to_string() => format!("Register {id}"),
        (Protocol::Modbus, Some(id)) => format!("{} (register {id})", row.key),
        (Protocol::Serial, Some(id)) => super::frame_label("serial", wiretap_analysis::FrameKey::new(id, false)),
        (_, None) => row.key.clone(),
    };
    match &row.name {
        Some(name) if *name != row.key => format!("{id} — {name}"),
        _ => id,
    }
}

fn frame(row: &FrameRow) -> Block {
    let mut fields = Vec::new();
    if row.length > 0 {
        fields.push(("Length", count(row.length as usize, "byte")));
    }
    if let Some(t) = &row.transmitter {
        fields.push(("Transmitter", t.clone()));
    }
    if let Some(i) = row.interval {
        let default = if i.default { " (default)" } else { "" };
        fields.push(("Interval", format!("{} ms{default}", grouped(i.ms as usize))));
    }
    if let Some(bus) = row.bus {
        fields.push(("Bus", bus.to_string()));
    }
    if !row.notes.is_empty() {
        fields.push(("Notes", row.notes.join("; ")));
    }
    let inherited: Vec<&str> = ["signals", "mux"]
        .into_iter()
        .filter(|f| row.inherited_fields.iter().any(|i| i == f))
        .collect();
    if !inherited.is_empty() {
        fields.push(("Inherited", inherited.join(", ")));
    }

    let mut blocks = vec![Block::Fields(fields)];
    blocks.extend(signal_table(&row.signals));
    if let (Some(mux), false) = (&row.mux, inherited.contains(&"mux")) {
        blocks.push(mux_section(mux));
    }
    Block::Section(frame_title(row), blocks)
}

fn mux_section(mux: &MuxRow) -> Block {
    let name = mux.name.as_deref().map(|n| format!("{n} ")).unwrap_or_default();
    let mut blocks = Vec::new();
    let mut fields = Vec::new();
    if let Some(default) = &mux.default {
        fields.push(("Default case", default.clone()));
    }
    if !mux.notes.is_empty() {
        fields.push(("Notes", mux.notes.join("; ")));
    }
    if !fields.is_empty() {
        blocks.push(Block::Fields(fields));
    }
    for case in &mux.cases {
        let mut inner = Vec::new();
        if !case.notes.is_empty() {
            inner.push(Block::Fields(vec![("Notes", case.notes.join("; "))]));
        }
        inner.extend(signal_table(&case.signals));
        if let Some(nested) = &case.mux {
            inner.push(mux_section(nested));
        }
        blocks.push(Block::Section(format!("Case {}", case.key), inner));
    }
    Block::Section(format!("Mux {name}at bits {}/{}", mux.start_bit, mux.bit_length), blocks)
}

/// The signals the frame authors itself; a mirror's inherited ones are its source's.
fn signal_table(rows: &[SignalRow]) -> Option<Block> {
    let rows: Vec<&SignalRow> = rows.iter().filter(|r| !r.signal.inherited).collect();
    if rows.is_empty() {
        return None;
    }
    let with_enum = rows.iter().any(|r| r.signal.enum_map.as_ref().is_some_and(|e| !e.is_empty()));
    let mut header = vec!["Bits", "Signal", "Scale", "Unit", "Signed", "Order", "Confidence"];
    if with_enum {
        header.push("Enum");
    }
    header.push("Notes");
    let table = rows
        .iter()
        .map(|r| {
            let s = &r.signal;
            let order = if r.byte_order == Endianness::Little { "LE" } else { "BE" };
            let order_class = if s.endianness.is_some() { "end-override" } else { "end-default" };
            let confidence = s.confidence.unwrap_or(Confidence::None).as_str();
            let mut cells = vec![
                Cell::Plain(format!("{}/{}", s.start_bit.unwrap_or(0), s.bit_length.unwrap_or(0))),
                Cell::Code(s.name.clone().unwrap_or_default()),
                Cell::Plain(scale(s)),
                Cell::Plain(s.unit.clone().unwrap_or_default()),
                Cell::from(if s.signed.unwrap_or(false) { "yes" } else { "no" }),
                Cell::Tag(order.into(), order_class.into()),
                Cell::Tag(confidence.into(), format!("conf-{confidence}")),
            ];
            if with_enum {
                let values: Vec<String> = s
                    .enum_map
                    .iter()
                    .flatten()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect();
                cells.push(Cell::Plain(values.join(", ")));
            }
            cells.push(Cell::Plain(s.notes.join("; ")));
            cells
        })
        .collect();
    Some(Block::Table(header, table))
}

fn scale(s: &Signal) -> String {
    let (factor, offset) = (s.factor.unwrap_or(1.0), s.offset.unwrap_or(0.0));
    if factor == 1.0 && offset == 0.0 {
        return "—".into();
    }
    match offset {
        o if o < 0.0 => format!("×{factor} − {}", -o),
        o if o > 0.0 => format!("×{factor} + {o}"),
        _ => format!("×{factor}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(toml: &str, format: ReportFormat) -> String {
        report(&CatalogSummary::from_text(toml).unwrap()).render(format)
    }

    #[test]
    fn every_protocol_is_reported_under_its_own_name() {
        let text = render(
            "[meta]\nname = \"mixed\"\n[frame.can.\"0x100\"]\n[frame.modbus.speed]\nregister_number = 40\n[frame.serial.\"0x10\"]\n",
            ReportFormat::Markdown,
        );
        assert!(text.starts_with("# Catalogue Report — mixed\n"), "{text}");
        assert!(text.contains("- **Frames:** 3 frames (1 CAN, 1 Modbus, 1 Serial)"), "{text}");
        for heading in ["## CAN frames", "### 0x100", "## Modbus frames", "### speed (register 40)", "## Serial frames", "### 0x10"] {
            assert!(text.contains(&format!("{heading}\n")), "{heading} in {text}");
        }
    }

    #[test]
    fn a_nameless_catalogue_and_a_single_frame_read_naturally() {
        let text = render("[meta]\nname = \"\"\n[frame.can.\"0x1\"]\nlength = 1\nbus = 0\n", ReportFormat::Text);
        assert!(text.contains("CATALOGUE REPORT — UNTITLED"), "{text}");
        assert!(text.contains("Frames:      1 frame\n"), "{text}");
        assert!(text.contains("Length: 1 byte\n"), "{text}");
        assert!(text.contains("Bus:    0\n"), "{text}");
    }

    #[test]
    fn a_mirror_lists_none_of_its_sources_signals() {
        let text = render(
            "[meta]\nname = \"m\"\n[frame.can.\"0x100\"]\n[[frame.can.\"0x100\".signals]]\nname = \"speed\"\nstart_bit = 0\nbit_length = 8\n[frame.can.\"0x101\"]\nmirror_of = \"0x100\"\n",
            ReportFormat::Markdown,
        );
        assert_eq!(text.matches("`speed`").count(), 1, "{text}");
        assert!(text.contains("- **Inherited:** signals"), "{text}");
    }
}
