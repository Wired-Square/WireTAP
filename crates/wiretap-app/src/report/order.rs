// crates/wiretap-app/src/report/order.rs
//
// The Frame Order report, over `wiretap_analysis::summary::order_totals`.

use wiretap_analysis::order::BurstFlag;
use wiretap_analysis::{order_totals, BusOrder, FrameKey};

use super::changes::selector_text;
use super::notes::mux_value;
use super::{frame_label, Block, Cell, Doc, ReportLocale};
use wiretap_analysis::source::ProtocolOrder;

const MAX_CANDIDATES: usize = 10;
const MAX_CASES: usize = 16;

pub fn report(orders: &[ProtocolOrder], l: &ReportLocale) -> Doc {
    let totals = order_totals(orders.iter().map(|o| (o.protocol.as_str(), &o.order)));
    let mut fields = vec![
        (l.label("reports:order.field.framesAnalysed"), l.grouped(totals.frames)),
        (l.label("reports:order.field.distinctFrames"), l.grouped(totals.unique_keys)),
        (l.label("reports:order.field.timeSpan"), l.ms(totals.time_span_ms)),
    ];
    if totals.patterns > 0 {
        fields.push((l.label("reports:order.cyclePatterns"), l.grouped(totals.patterns)));
    }
    if totals.multi_bus_frames > 0 {
        fields.push((l.label("reports:order.multiBusFrames"), l.grouped(totals.multi_bus_frames)));
    }
    let mut blocks = vec![Block::Section(l.label("reports:summary"), vec![Block::Fields(fields)])];
    for o in orders {
        for bus in &o.order.buses {
            let title = l.t(
                "reports:order.busSection",
                &[
                    ("protocol", &l.protocol_label(&o.protocol)),
                    ("bus", &bus.bus.to_string()),
                    ("frames", &l.count("reports:count.frame", bus.frame_count)),
                ],
            );
            blocks.push(Block::Section(title, bus_blocks(&o.protocol, bus, l)));
        }
    }
    let multi: Vec<Vec<Cell>> = orders
        .iter()
        .flat_map(|o| o.order.multi_bus.iter().map(move |m| (o.protocol.as_str(), m)))
        .map(|(protocol, m)| {
            let buses: Vec<String> = m
                .frames_per_bus
                .iter()
                .map(|(bus, n)| l.t("reports:order.busFrames", &[("bus", &bus.to_string()), ("count", &l.grouped(*n))]))
                .collect();
            vec![Cell::Code(frame_label(protocol, m.key)), Cell::Plain(buses.join(", "))]
        })
        .collect();
    if !multi.is_empty() {
        let header = vec![l.label("reports:order.column.frame"), l.label("reports:order.column.framesPerBus")];
        blocks.push(Block::Section(l.label("reports:order.multiBusFrames"), vec![Block::Table(header, multi)]));
    }
    Doc::new(l, l.label("reports:order.title"), blocks)
}

fn bus_blocks(protocol: &str, bus: &BusOrder, l: &ReportLocale) -> Vec<Block> {
    let label = |k: &FrameKey| frame_label(protocol, *k);
    let mut blocks = Vec::new();
    let mut section = |title: &str, header: &[&str], rows: Vec<Vec<Cell>>| {
        if !rows.is_empty() {
            let header = header.iter().map(|h| l.label(h)).collect();
            blocks.push(Block::Section(l.label(title), vec![Block::Table(header, rows)]));
        }
    };

    section(
        "reports:order.cyclePatterns",
        &[
            "reports:order.column.number",
            "reports:order.column.start",
            "reports:order.column.sequence",
            "reports:order.column.occurrences",
            "reports:order.column.confidence",
            "reports:order.column.cycle",
        ],
        bus.patterns
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let sequence: Vec<String> = p.sequence.iter().map(label).collect();
                vec![
                    Cell::Plain((i + 1).to_string()),
                    Cell::Code(label(&p.start)),
                    Cell::Code(sequence.join(" → ")),
                    Cell::Plain(l.grouped(p.occurrences)),
                    Cell::Plain(l.percent((p.confidence * 100.0).round())),
                    Cell::Plain(l.optional_ms(p.cycle_ms)),
                ]
            })
            .collect(),
    );
    section(
        "reports:order.section.multiplexedFrames",
        &[
            "reports:order.column.frame",
            "reports:order.column.selector",
            "reports:order.column.cases",
            "reports:order.column.muxPeriod",
            "reports:order.column.interMessage",
        ],
        bus.mux
            .iter()
            .map(|m| {
                let selector = m.detection.selector;
                let cases: Vec<String> =
                    m.detection.occurrences.keys().take(MAX_CASES).map(|v| mux_value(*v, selector)).collect();
                let more = m.detection.occurrences.len().saturating_sub(MAX_CASES);
                let cases = if more > 0 {
                    l.t("reports:order.moreCases", &[("cases", &cases.join(", ")), ("more", &more.to_string())])
                } else {
                    cases.join(", ")
                };
                vec![
                    Cell::Code(label(&m.key)),
                    Cell::Code(selector_text(selector).into()),
                    Cell::Plain(cases),
                    Cell::Plain(l.optional_ms(m.mux_period_ms)),
                    Cell::Plain(l.ms(m.inter_message_ms)),
                ]
            })
            .collect(),
    );
    section(
        "reports:order.section.bursts",
        &[
            "reports:order.column.frame",
            "reports:order.column.lengths",
            "reports:order.column.framesPerBurst",
            "reports:order.column.cycle",
            "reports:order.column.flags",
        ],
        bus.bursts
            .iter()
            .map(|b| {
                let lengths: Vec<String> = b.lengths.iter().map(usize::to_string).collect();
                let size = if b.frames_per_burst == 1.0 {
                    "—".into()
                } else {
                    format!("~{}", l.decimal(format!("{:.1}", b.frames_per_burst)))
                };
                let flags: Vec<String> = b.flags.iter().map(|f| l.label(flag_key(f))).collect();
                vec![
                    Cell::Code(label(&b.key)),
                    Cell::Plain(lengths.join(", ")),
                    Cell::Plain(size),
                    Cell::Plain(l.ms(b.burst_period_ms)),
                    Cell::Plain(if flags.is_empty() { "—".into() } else { flags.join(", ") }),
                ]
            })
            .collect(),
    );
    section(
        "reports:order.section.repetitionGroups",
        &["reports:order.column.interval", "reports:order.column.frames", "reports:order.column.ids"],
        bus.interval_groups
            .iter()
            .map(|g| {
                let ids: Vec<String> = g.keys.iter().map(label).collect();
                vec![
                    Cell::Plain(format!("~{}", l.ms(g.interval_ms))),
                    Cell::Plain(l.grouped(g.keys.len())),
                    Cell::Code(ids.join(", ")),
                ]
            })
            .collect(),
    );
    section(
        "reports:order.section.startCandidates",
        &[
            "reports:order.column.frame",
            "reports:order.column.maxGap",
            "reports:order.column.avgGap",
            "reports:order.column.minGap",
            "reports:order.column.count",
        ],
        bus.start_candidates
            .iter()
            .take(MAX_CANDIDATES)
            .map(|c| {
                vec![
                    Cell::Code(label(&c.key)),
                    Cell::Plain(l.ms(c.max_gap_before_ms)),
                    Cell::Plain(l.ms(c.avg_gap_before_ms)),
                    Cell::Plain(l.ms(c.min_gap_before_ms)),
                    Cell::Plain(l.grouped(c.occurrences)),
                ]
            })
            .collect(),
    );
    blocks
}

fn flag_key(flag: &BurstFlag) -> &'static str {
    match flag {
        BurstFlag::VariableLength => "reports:order.flag.variableLength",
        BurstFlag::BurstPattern => "reports:order.flag.burstPattern",
        BurstFlag::RequestResponse => "reports:order.flag.requestResponse",
    }
}
