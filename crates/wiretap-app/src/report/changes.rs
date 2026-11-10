// crates/wiretap-app/src/report/changes.rs
//
// The Payload Changes report, over `wiretap_analysis::summary::changes_counts`.

use wiretap_analysis::roles::{Endianness, Trend};
use wiretap_analysis::{changes_counts, ByteColumn, ByteRole, FrameKey, MultiBytePattern, MuxSelector, PatternKind};

use super::notes::{case_lines, frame_lines, mux_value};
use super::{frame_label, protocol_rank, Block, Cell, Doc, ReportLocale};
use crate::byte_roles::{ChangesFrame, PayloadChanges};

fn protocol(frame: &ChangesFrame) -> &str {
    frame.profile.protocol.as_deref().unwrap_or("can")
}

fn key(frame: &ChangesFrame) -> FrameKey {
    FrameKey::new(frame.profile.frame_id, frame.profile.is_extended)
}

fn labels(l: &ReportLocale, keys: &[&str]) -> Vec<String> {
    keys.iter().map(|k| l.label(k)).collect()
}

pub fn report(changes: &PayloadChanges, l: &ReportLocale) -> Doc {
    let mut frames: Vec<&ChangesFrame> = changes.frames.iter().collect();
    frames.sort_by_key(|f| (protocol_rank(protocol(f)), protocol(f), key(f), f.profile.bus));
    let counts = changes_counts(
        frames.iter().map(|f| (&f.profile.profile, f.burst)),
        changes.mirrors.iter().map(|m| m.groups.as_slice()),
    );
    let multi_bus = frames.iter().map(|f| f.profile.bus).collect::<std::collections::BTreeSet<_>>().len() > 1;

    let mut protocols: Vec<&str> = frames.iter().map(|f| protocol(f)).collect();
    protocols.dedup();
    let mut fields = vec![
        (l.label("reports:changes.field.framesRead"), l.grouped(changes.frame_count)),
        (l.label("reports:changes.field.framesProfiled"), l.grouped(counts.frames)),
    ];
    if !protocols.is_empty() {
        let labels: Vec<String> = protocols.iter().map(|p| l.protocol_label(p)).collect();
        fields.push((l.label("reports:changes.field.protocols"), labels.join(", ")));
    }
    for (label, n) in [
        ("reports:changes.field.notProfiled", changes.skipped_frames),
        ("reports:changes.mirrorGroups", counts.mirror_groups),
        ("reports:changes.field.identical", counts.identical),
        ("reports:changes.field.varyingLength", counts.varying_length),
        ("reports:changes.field.multiplexed", counts.mux),
        ("reports:changes.field.burst", counts.burst),
    ] {
        if n > 0 {
            fields.push((l.label(label), l.grouped(n)));
        }
    }

    let mut blocks = vec![Block::Section(l.label("reports:summary"), vec![Block::Fields(fields)])];
    let mirror_rows: Vec<Vec<Cell>> = changes
        .mirrors
        .iter()
        .flat_map(|m| m.groups.iter().map(move |g| (m.protocol.as_str(), g)))
        .map(|(protocol, g)| {
            let ids: Vec<String> = g.keys.iter().map(|k| frame_label(protocol, *k)).collect();
            vec![
                Cell::Code(ids.join(" ↔ ")),
                Cell::Plain(l.percent(g.match_percentage)),
                Cell::Plain(l.grouped(g.sample_count)),
                Cell::Code(hex(&g.sample_payload)),
            ]
        })
        .collect();
    if !mirror_rows.is_empty() {
        let header = labels(
            l,
            &[
                "reports:changes.column.frames",
                "reports:changes.column.match",
                "reports:changes.column.pairedSamples",
                "reports:changes.column.sample",
            ],
        );
        blocks.push(Block::Section(l.label("reports:changes.mirrorGroups"), vec![Block::Table(header, mirror_rows)]));
    }
    blocks.push(Block::Section(
        l.label("reports:changes.frames"),
        frames.into_iter().map(|f| frame(f, multi_bus, l)).collect(),
    ));
    Doc::new(l, l.label("reports:changes.title"), blocks)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

fn frame(f: &ChangesFrame, multi_bus: bool, l: &ReportLocale) -> Block {
    let p = &f.profile.profile;
    let length = if p.min_len == p.max_len {
        l.count("reports:count.byte", p.max_len)
    } else {
        l.t("reports:changes.lengthRange", &[("min", &p.min_len.to_string()), ("max", &p.max_len.to_string())])
    };
    let mut fields = vec![
        (l.label("reports:changes.field.samples"), l.grouped(p.sample_count)),
        (l.label("reports:changes.field.length"), length),
    ];
    let flags: Vec<String> = [
        (p.identical.is_some(), "reports:changes.flag.identical"),
        (p.mux.is_some(), "reports:changes.flag.multiplexed"),
        (f.burst, "reports:changes.flag.burst"),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, flag)| l.label(flag))
    .collect();
    if !flags.is_empty() {
        fields.push((l.label("reports:changes.field.flags"), flags.join(", ")));
    }
    let selector = p.mux.as_ref().map(|m| m.detection.selector);
    if let Some(selector) = selector {
        fields.push((l.label("reports:changes.field.selector"), selector_text(selector).into()));
    }

    let mut blocks = vec![Block::Fields(fields)];
    if !p.columns.is_empty() {
        let header = labels(
            l,
            &["reports:changes.column.byte", "reports:changes.column.role", "reports:changes.column.details"],
        );
        blocks.push(Block::Table(header, p.columns.iter().map(|c| role_row(c, l)).collect()));
    }
    if p.mux.is_none() && !p.patterns.is_empty() {
        blocks.push(pattern_table(&p.patterns, l));
    }
    let notes = frame_lines(l, &f.notes.frame, selector);
    if !notes.is_empty() {
        blocks.push(Block::List(notes));
    }
    if let (Some(mux), Some(selector)) = (&p.mux, selector) {
        for case in &mux.cases {
            let mut inner = Vec::new();
            if !case.patterns.is_empty() {
                inner.push(pattern_table(&case.patterns, l));
            }
            let notes = f.notes.cases.iter().find(|n| n.value == case.value);
            let lines = notes.map(|n| case_lines(l, &n.notes, selector)).unwrap_or_default();
            if !lines.is_empty() {
                inner.push(Block::List(lines));
            }
            let title = l.t(
                "reports:changes.case",
                &[
                    ("value", &mux_value(case.value, selector)),
                    ("samples", &l.count("reports:count.sample", case.sample_count)),
                ],
            );
            blocks.push(Block::Section(title, inner));
        }
    }
    let mut title = format!("{} {}", l.protocol_label(protocol(f)), frame_label(protocol(f), key(f)));
    if let Some(bus) = f.profile.bus.filter(|_| multi_bus) {
        title = l.t("reports:changes.onBus", &[("frame", &title), ("bus", &bus.to_string())]);
    }
    Block::Section(title, blocks)
}

pub fn selector_text(selector: MuxSelector) -> &'static str {
    match selector {
        MuxSelector::OneByte => "byte[0]",
        MuxSelector::TwoByte => "byte[0:1]",
    }
}

fn role_row(c: &ByteColumn, l: &ReportLocale) -> Vec<Cell> {
    let (role, details) = match &c.role {
        ByteRole::Static { value } => ("reports:changes.role.static", format!("0x{value:02X}")),
        ByteRole::Counter { step, looping: Some(lp), .. } => {
            let [min, max, modulo, step] = [lp.min.to_string(), lp.max.to_string(), lp.modulo.to_string(), step.to_string()];
            let details = l.t(
                "reports:changes.loopingCounter",
                &[("min", &min), ("max", &max), ("modulo", &modulo), ("step", &step)],
            );
            ("reports:changes.role.counter", details)
        }
        ByteRole::Counter { step, rollover, .. } => {
            let key = if *rollover { "reports:changes.stepRollover" } else { "reports:changes.step" };
            ("reports:changes.role.counter", l.t(key, &[("step", &step.to_string())]))
        }
        ByteRole::Sensor { trend, .. } => {
            let trend = l.label(match trend {
                Trend::Increasing => "reports:changes.trends.increasing",
                Trend::Decreasing => "reports:changes.trends.decreasing",
                Trend::Mixed => "reports:changes.trends.mixed",
            });
            ("reports:changes.role.sensor", l.t("reports:changes.trend", &[("trend", &trend)]))
        }
        ByteRole::Value => ("reports:changes.role.value", l.count("reports:count.distinctValue", c.stats.distinct_values)),
        ByteRole::Unknown => ("reports:changes.role.unknown", String::new()),
    };
    vec![Cell::Plain(c.stats.position.to_string()), Cell::Plain(l.label(role)), Cell::Plain(details)]
}

fn pattern_table(patterns: &[MultiBytePattern], l: &ReportLocale) -> Block {
    let rows = patterns
        .iter()
        .map(|p| {
            let kind = match p.kind {
                PatternKind::Counter16 => "reports:changes.patternKind.counter16",
                PatternKind::Sensor16 => "reports:changes.patternKind.sensor16",
                PatternKind::Sensor32 => "reports:changes.patternKind.sensor32",
                PatternKind::Text => "reports:changes.patternKind.text",
            };
            let mut details = Vec::new();
            if let Some(e) = p.endianness {
                let order = l.label(match e {
                    Endianness::Little => "reports:changes.order.little",
                    Endianness::Big => "reports:changes.order.big",
                    Endianness::Mixed => "reports:changes.order.mixed",
                });
                details.push(l.t("reports:changes.endian", &[("order", &order)]));
            }
            if p.rollover {
                details.push(l.label("reports:changes.rollover"));
            }
            if let Some((min, max)) = p.range {
                details.push(l.t("reports:changes.range", &[("min", &min.to_string()), ("max", &max.to_string())]));
            }
            if let Some(text) = &p.sample_text {
                details.push(format!("\"{text}\""));
            }
            vec![
                Cell::Code(format!("byte[{}:{}]", p.start, p.start + p.len - 1)),
                Cell::Plain(l.label(kind)),
                Cell::Plain(details.join(", ")),
            ]
        })
        .collect();
    let header = labels(
        l,
        &["reports:changes.column.bytes", "reports:changes.column.pattern", "reports:changes.column.details"],
    );
    Block::Table(header, rows)
}
