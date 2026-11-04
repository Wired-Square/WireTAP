// crates/wiretap-app/src/report/catalog.rs
//
// The catalogue report: every protocol's frames as the catalogue authors them,
// over `wslib_wiretap_catalogue::summary`.

use wslib_wiretap_catalogue::model::{Confidence, Endianness, Protocol, Signal};
use wslib_wiretap_catalogue::summary::{CatalogueSummary, FrameRow, MuxRow, SignalRow};

use super::{Block, Cell, Doc, ReportFormat, ReportLocale};

/// The report on a catalogue's text, a legacy `[id]` table read as CAN.
pub fn render(text: &str, format: ReportFormat, l: &ReportLocale) -> Result<String, String> {
    let summary = CatalogueSummary::from_text(text).map_err(|e| e.to_string())?;
    Ok(report(&summary, l).render(format))
}

pub fn report(summary: &CatalogueSummary, l: &ReportLocale) -> Doc {
    let name = summary.name.trim();
    let name = if name.is_empty() { l.label("reports:catalogue.untitled") } else { name.to_string() };
    let title = l.t("reports:catalogue.title", &[("name", &name)]);
    let mut blocks = vec![Block::Section(l.label("reports:summary"), vec![Block::Fields(overview(summary, l))])];
    for protocol in [Protocol::Can, Protocol::Modbus, Protocol::Serial] {
        let frames: Vec<Block> = summary
            .frames
            .iter()
            .filter(|f| f.protocol == protocol)
            .map(|f| frame(f, l))
            .collect();
        if !frames.is_empty() {
            let heading = l.t("reports:catalogue.protocolFrames", &[("protocol", &protocol_name(protocol, l))]);
            blocks.push(Block::Section(heading, frames));
        }
    }
    Doc::new(l, title, blocks)
}

fn protocol_name(protocol: Protocol, l: &ReportLocale) -> String {
    l.protocol_label(match protocol {
        Protocol::Can => "can",
        Protocol::Modbus => "modbus",
        Protocol::Serial => "serial",
    })
}

fn order_name(order: Endianness, l: &ReportLocale) -> String {
    l.label(match order {
        Endianness::Little => "reports:catalogue.littleEndian",
        Endianness::Big => "reports:catalogue.bigEndian",
    })
}

fn overview(summary: &CatalogueSummary, l: &ReportLocale) -> Vec<(String, String)> {
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
    let mut frames = l.count("reports:count.frame", total);
    if present.len() > 1 {
        let parts: Vec<String> = present
            .iter()
            .map(|(p, n)| {
                l.t("reports:catalogue.protocolCount", &[("count", &l.grouped(*n)), ("protocol", &protocol_name(*p, l))])
            })
            .collect();
        frames = l.t("reports:catalogue.framesByProtocol", &[("frames", &frames), ("protocols", &parts.join(", "))]);
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
            l.t(
                "reports:catalogue.protocolByteOrder",
                &[("protocol", &protocol_name(*p, l)), ("order", &order_name(order, l))],
            )
        })
        .collect();
    let conf = &c.confidence;
    let [high, medium, low, none] = [conf.high, conf.medium, conf.low, conf.none].map(|n| n.to_string());
    let (signals, enums) = (l.grouped(c.signals), l.grouped(c.enum_signals));
    let mut fields = vec![
        (l.label("reports:catalogue.field.version"), summary.version.to_string()),
        (l.label("reports:catalogue.field.frames"), frames),
        (l.label("reports:catalogue.field.multiplexed"), l.count("reports:count.frame", c.mux_frames)),
        (
            l.label("reports:catalogue.field.signals"),
            l.t("reports:catalogue.signalCount", &[("signals", &signals), ("enums", &enums)]),
        ),
        (
            l.label("reports:catalogue.field.confidence"),
            l.t(
                "reports:catalogue.confidenceCounts",
                &[("high", &high), ("medium", &medium), ("low", &low), ("none", &none)],
            ),
        ),
    ];
    if !orders.is_empty() {
        fields.push((l.label("reports:catalogue.field.byteOrder"), orders.join(", ")));
    }
    fields
}

fn frame_title(row: &FrameRow, l: &ReportLocale) -> String {
    let id = match (row.protocol, row.frame_id) {
        (Protocol::Can, Some(id)) => format!("0x{id:03X}"),
        (Protocol::Modbus, Some(id)) if row.key == id.to_string() => {
            l.t("reports:catalogue.register", &[("id", &id.to_string())])
        }
        (Protocol::Modbus, Some(id)) => {
            l.t("reports:catalogue.keyRegister", &[("key", &row.key), ("id", &id.to_string())])
        }
        (Protocol::Serial, Some(id)) => super::frame_label("serial", wiretap_analysis::FrameKey::new(id, false)),
        (_, None) => row.key.clone(),
    };
    match &row.name {
        Some(name) if *name != row.key => format!("{id} — {name}"),
        _ => id,
    }
}

fn frame(row: &FrameRow, l: &ReportLocale) -> Block {
    let field = |key: &str, value: String| (l.label(key), value);
    let mut fields = Vec::new();
    if row.length > 0 {
        fields.push(field("reports:catalogue.field.length", l.count("reports:count.byte", row.length as usize)));
    }
    if let Some(t) = &row.transmitter {
        fields.push(field("reports:catalogue.field.transmitter", t.clone()));
    }
    if let Some(i) = row.interval {
        let interval = l.t("reports:milliseconds", &[("value", &l.grouped(i.ms as usize))]);
        let interval =
            if i.default { l.t("reports:catalogue.defaultInterval", &[("interval", &interval)]) } else { interval };
        fields.push(field("reports:catalogue.field.interval", interval));
    }
    if let Some(bus) = row.bus {
        fields.push(field("reports:catalogue.field.bus", bus.to_string()));
    }
    if !row.notes.is_empty() {
        fields.push(field("reports:catalogue.field.notes", row.notes.join("; ")));
    }
    let inherited: Vec<&str> = ["signals", "mux"]
        .into_iter()
        .filter(|f| row.inherited_fields.iter().any(|i| i == f))
        .collect();
    if !inherited.is_empty() {
        fields.push(field("reports:catalogue.field.inherited", inherited.join(", ")));
    }

    let mut blocks = vec![Block::Fields(fields)];
    blocks.extend(signal_table(&row.signals, l));
    if let (Some(mux), false) = (&row.mux, inherited.contains(&"mux")) {
        blocks.push(mux_section(mux, l));
    }
    Block::Section(frame_title(row, l), blocks)
}

fn mux_section(mux: &MuxRow, l: &ReportLocale) -> Block {
    let notes = |notes: &[String]| (l.label("reports:catalogue.field.notes"), notes.join("; "));
    let mut blocks = Vec::new();
    let mut fields = Vec::new();
    if let Some(default) = &mux.default {
        fields.push((l.label("reports:catalogue.field.defaultCase"), default.clone()));
    }
    if !mux.notes.is_empty() {
        fields.push(notes(&mux.notes));
    }
    if !fields.is_empty() {
        blocks.push(Block::Fields(fields));
    }
    for case in &mux.cases {
        let mut inner = Vec::new();
        if !case.notes.is_empty() {
            inner.push(Block::Fields(vec![notes(&case.notes)]));
        }
        inner.extend(signal_table(&case.signals, l));
        if let Some(nested) = &case.mux {
            inner.push(mux_section(nested, l));
        }
        blocks.push(Block::Section(l.t("reports:catalogue.case", &[("key", &case.key)]), inner));
    }
    let bits = format!("{}/{}", mux.start_bit, mux.bit_length);
    let title = match &mux.name {
        Some(name) => l.t("reports:catalogue.namedMux", &[("name", name), ("bits", &bits)]),
        None => l.t("reports:catalogue.mux", &[("bits", &bits)]),
    };
    Block::Section(title, blocks)
}

/// The signals the frame authors itself; a mirror's inherited ones are its source's.
fn signal_table(rows: &[SignalRow], l: &ReportLocale) -> Option<Block> {
    let rows: Vec<&SignalRow> = rows.iter().filter(|r| !r.signal.inherited).collect();
    if rows.is_empty() {
        return None;
    }
    let with_enum = rows.iter().any(|r| r.signal.enum_map.as_ref().is_some_and(|e| !e.is_empty()));
    let mut header = vec![
        "reports:catalogue.column.bits",
        "reports:catalogue.column.signal",
        "reports:catalogue.column.scale",
        "reports:catalogue.column.unit",
        "reports:catalogue.column.signed",
        "reports:catalogue.column.order",
        "reports:catalogue.column.confidence",
    ];
    if with_enum {
        header.push("reports:catalogue.column.enum");
    }
    header.push("reports:catalogue.column.notes");
    let table = rows
        .iter()
        .map(|r| {
            let s = &r.signal;
            let order =
                if r.byte_order == Endianness::Little { "reports:catalogue.littleShort" } else { "reports:catalogue.bigShort" };
            let order_class = if s.endianness.is_some() { "end-override" } else { "end-default" };
            let confidence = s.confidence.unwrap_or(Confidence::None);
            let confidence_word = l.label(match confidence {
                Confidence::High => "reports:catalogue.confidence.high",
                Confidence::Medium => "reports:catalogue.confidence.medium",
                Confidence::Low => "reports:catalogue.confidence.low",
                Confidence::None => "reports:catalogue.confidence.none",
            });
            let signed = if s.signed.unwrap_or(false) { "reports:catalogue.yes" } else { "reports:catalogue.no" };
            let mut cells = vec![
                Cell::Plain(format!("{}/{}", s.start_bit.unwrap_or(0), s.bit_length.unwrap_or(0))),
                Cell::Code(s.name.clone().unwrap_or_default()),
                Cell::Plain(scale(s, l)),
                Cell::Plain(s.unit.clone().unwrap_or_default()),
                Cell::Plain(l.label(signed)),
                Cell::Tag(l.label(order), order_class.into()),
                Cell::Tag(confidence_word, format!("conf-{}", confidence.as_str())),
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
    Some(Block::Table(header.into_iter().map(|h| l.label(h)).collect(), table))
}

fn scale(s: &Signal, l: &ReportLocale) -> String {
    let (factor, offset) = (s.factor.unwrap_or(1.0), s.offset.unwrap_or(0.0));
    if factor == 1.0 && offset == 0.0 {
        return "—".into();
    }
    let factor = l.decimal(factor);
    match offset {
        o if o < 0.0 => format!("×{factor} − {}", l.decimal(-o)),
        o if o > 0.0 => format!("×{factor} + {}", l.decimal(o)),
        _ => format!("×{factor}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(toml: &str, format: ReportFormat) -> String {
        report(&CatalogueSummary::from_text(toml).unwrap(), &ReportLocale::default()).render(format)
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
