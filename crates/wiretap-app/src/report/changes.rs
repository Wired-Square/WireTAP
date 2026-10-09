// crates/wiretap-app/src/report/changes.rs
//
// The Payload Changes report, over `wiretap_analysis::summary::changes_counts`.

use std::collections::HashSet;

use wiretap_analysis::{changes_counts, ByteColumn, ByteRole, FrameKey, MultiBytePattern, MuxSelector, PatternKind};

use super::notes::{case_lines, frame_lines, mux_value};
use super::{count, frame_label, grouped, protocol_label, protocol_rank, Block, Cell, Doc};
use crate::byte_roles::{ChangesFrame, PayloadChanges};

fn protocol(frame: &ChangesFrame) -> &str {
    frame.profile.protocol.as_deref().unwrap_or("can")
}

fn key(frame: &ChangesFrame) -> FrameKey {
    FrameKey::new(frame.profile.frame_id, frame.profile.is_extended)
}

pub fn report(changes: &PayloadChanges) -> Doc {
    let mut frames: Vec<&ChangesFrame> = changes.frames.iter().collect();
    frames.sort_by_key(|f| (protocol_rank(protocol(f)), protocol(f), key(f)));

    let bursts: HashSet<(&str, FrameKey)> =
        frames.iter().filter(|f| f.burst).map(|f| (protocol(f), key(f))).collect();
    let counts = changes_counts(
        frames.iter().map(|f| (protocol(f), key(f), &f.profile.profile)),
        &bursts,
        changes.mirrors.iter().map(|m| m.groups.as_slice()),
    );

    let mut protocols: Vec<&str> = frames.iter().map(|f| protocol(f)).collect();
    protocols.dedup();
    let mut fields = vec![
        ("Frames read", grouped(changes.frame_count)),
        ("Frames profiled", grouped(counts.frames)),
    ];
    if !protocols.is_empty() {
        let labels: Vec<String> = protocols.iter().map(|p| protocol_label(p)).collect();
        fields.push(("Protocols", labels.join(", ")));
    }
    for (label, n) in [
        ("Not profiled", changes.skipped_frames),
        ("Mirror groups", counts.mirror_groups),
        ("Identical", counts.identical),
        ("Varying length", counts.varying_length),
        ("Multiplexed", counts.mux),
        ("Burst", counts.burst),
    ] {
        if n > 0 {
            fields.push((label, grouped(n)));
        }
    }

    let mut blocks = vec![Block::Section("Summary".into(), vec![Block::Fields(fields)])];
    let mirror_rows: Vec<Vec<Cell>> = changes
        .mirrors
        .iter()
        .flat_map(|m| m.groups.iter().map(move |g| (m.protocol.as_str(), g)))
        .map(|(protocol, g)| {
            let ids: Vec<String> = g.keys.iter().map(|k| frame_label(protocol, *k)).collect();
            vec![
                Cell::Code(ids.join(" ↔ ")),
                Cell::Plain(format!("{}%", g.match_percentage)),
                Cell::Plain(grouped(g.sample_count)),
                Cell::Code(hex(&g.sample_payload)),
            ]
        })
        .collect();
    if !mirror_rows.is_empty() {
        blocks.push(Block::Section(
            "Mirror groups".into(),
            vec![Block::Table(vec!["Frames", "Match", "Paired samples", "Sample"], mirror_rows)],
        ));
    }
    blocks.push(Block::Section("Frames".into(), frames.into_iter().map(frame).collect()));
    Doc { title: "Payload Changes Report".into(), blocks }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

fn frame(f: &ChangesFrame) -> Block {
    let p = &f.profile.profile;
    let length = if p.min_len == p.max_len {
        count(p.max_len, "byte")
    } else {
        format!("{}–{} bytes", p.min_len, p.max_len)
    };
    let mut fields = vec![("Samples", grouped(p.sample_count)), ("Length", length)];
    let flags: Vec<&str> = [
        (p.identical.is_some(), "identical"),
        (p.mux.is_some(), "multiplexed"),
        (f.burst, "burst"),
    ]
    .into_iter()
    .filter_map(|(on, flag)| on.then_some(flag))
    .collect();
    if !flags.is_empty() {
        fields.push(("Flags", flags.join(", ")));
    }
    let selector = p.mux.as_ref().map(|m| m.detection.selector);
    if let Some(selector) = selector {
        fields.push(("Selector", selector_text(selector).into()));
    }

    let mut blocks = vec![Block::Fields(fields)];
    if !p.columns.is_empty() {
        blocks.push(Block::Table(vec!["Byte", "Role", "Details"], p.columns.iter().map(role_row).collect()));
    }
    if p.mux.is_none() && !p.patterns.is_empty() {
        blocks.push(pattern_table(&p.patterns));
    }
    let notes = frame_lines(&f.notes.frame, selector);
    if !notes.is_empty() {
        blocks.push(Block::List(notes));
    }
    if let (Some(mux), Some(selector)) = (&p.mux, selector) {
        for case in &mux.cases {
            let mut inner = Vec::new();
            if !case.patterns.is_empty() {
                inner.push(pattern_table(&case.patterns));
            }
            let notes = f.notes.cases.iter().find(|n| n.value == case.value);
            let lines = notes.map(|n| case_lines(&n.notes, selector)).unwrap_or_default();
            if !lines.is_empty() {
                inner.push(Block::List(lines));
            }
            let title = format!("Case {} ({})", mux_value(case.value, selector), count(case.sample_count, "sample"));
            blocks.push(Block::Section(title, inner));
        }
    }
    let title = format!("{} {}", protocol_label(protocol(f)), frame_label(protocol(f), key(f)));
    Block::Section(title, blocks)
}

pub fn selector_text(selector: MuxSelector) -> &'static str {
    match selector {
        MuxSelector::OneByte => "byte[0]",
        MuxSelector::TwoByte => "byte[0:1]",
    }
}

fn role_row(c: &ByteColumn) -> Vec<Cell> {
    let (role, details) = match &c.role {
        ByteRole::Static { value } => ("static", format!("0x{value:02X}")),
        ByteRole::Counter { step, looping: Some(l), .. } => {
            ("counter", format!("looping {}–{} (mod {}), step {step}", l.min, l.max, l.modulo))
        }
        ByteRole::Counter { step, rollover, .. } => {
            ("counter", format!("step {step}{}", if *rollover { ", rollover" } else { "" }))
        }
        ByteRole::Sensor { trend, .. } => ("sensor", format!("trend {}", format!("{trend:?}").to_lowercase())),
        ByteRole::Value => ("value", count(c.stats.distinct_values, "distinct value")),
        ByteRole::Unknown => ("unknown", String::new()),
    };
    vec![Cell::Plain(c.stats.position.to_string()), Cell::from(role), Cell::Plain(details)]
}

fn pattern_table(patterns: &[MultiBytePattern]) -> Block {
    let rows = patterns
        .iter()
        .map(|p| {
            let kind = match p.kind {
                PatternKind::Counter16 => "16-bit counter",
                PatternKind::Sensor16 => "16-bit sensor",
                PatternKind::Sensor32 => "32-bit sensor",
                PatternKind::Text => "text",
            };
            let mut details = Vec::new();
            if let Some(e) = p.endianness {
                details.push(format!("{} endian", format!("{e:?}").to_lowercase()));
            }
            if p.rollover {
                details.push("rollover".into());
            }
            if let Some((min, max)) = p.range {
                details.push(format!("range {min}–{max}"));
            }
            if let Some(text) = &p.sample_text {
                details.push(format!("\"{text}\""));
            }
            vec![
                Cell::Code(format!("byte[{}:{}]", p.start, p.start + p.len - 1)),
                Cell::from(kind),
                Cell::Plain(details.join(", ")),
            ]
        })
        .collect();
    Block::Table(vec!["Bytes", "Pattern", "Details"], rows)
}
