// crates/wiretap-app/src/report/order.rs
//
// The Frame Order report, over `wiretap_analysis::summary::order_totals`.

use wiretap_analysis::order::BurstFlag;
use wiretap_analysis::{order_totals, BusOrder, FrameKey};

use super::changes::selector_text;
use super::notes::mux_value;
use super::{count, frame_label, grouped, ms, optional_ms, protocol_label, Block, Cell, Doc};
use crate::analysis::ProtocolOrder;

const MAX_CANDIDATES: usize = 10;
const MAX_CASES: usize = 16;

pub fn report(orders: &[ProtocolOrder]) -> Doc {
    let totals = order_totals(orders.iter().map(|o| (o.protocol.as_str(), &o.order)));
    let mut fields = vec![
        ("Frames analysed", grouped(totals.frames)),
        ("Distinct frames", grouped(totals.unique_keys)),
        ("Time span", ms(totals.time_span_ms)),
    ];
    if totals.patterns > 0 {
        fields.push(("Cycle patterns", grouped(totals.patterns)));
    }
    if totals.multi_bus_frames > 0 {
        fields.push(("Multi-bus frames", grouped(totals.multi_bus_frames)));
    }
    let mut blocks = vec![Block::Section("Summary".into(), vec![Block::Fields(fields)])];
    for o in orders {
        for bus in &o.order.buses {
            let title = format!("{} · bus {} ({})", protocol_label(&o.protocol), bus.bus, count(bus.frame_count, "frame"));
            blocks.push(Block::Section(title, bus_blocks(&o.protocol, bus)));
        }
    }
    let multi: Vec<Vec<Cell>> = orders
        .iter()
        .flat_map(|o| o.order.multi_bus.iter().map(move |m| (o.protocol.as_str(), m)))
        .map(|(protocol, m)| {
            let buses: Vec<String> =
                m.frames_per_bus.iter().map(|(bus, n)| format!("bus {bus}: {}", grouped(*n))).collect();
            vec![Cell::Code(frame_label(protocol, m.key)), Cell::Plain(buses.join(", "))]
        })
        .collect();
    if !multi.is_empty() {
        blocks.push(Block::Section("Multi-bus frames".into(), vec![Block::Table(vec!["Frame", "Frames per bus"], multi)]));
    }
    Doc { title: "Frame Order Report".into(), blocks }
}

fn bus_blocks(protocol: &str, bus: &BusOrder) -> Vec<Block> {
    let label = |k: &FrameKey| frame_label(protocol, *k);
    let mut blocks = Vec::new();
    let mut section = |title: &str, header: Vec<&'static str>, rows: Vec<Vec<Cell>>| {
        if !rows.is_empty() {
            blocks.push(Block::Section(title.into(), vec![Block::Table(header, rows)]));
        }
    };

    section(
        "Cycle patterns",
        vec!["#", "Start", "Sequence", "Occurrences", "Confidence", "Cycle"],
        bus.patterns
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let sequence: Vec<String> = p.sequence.iter().map(label).collect();
                vec![
                    Cell::Plain((i + 1).to_string()),
                    Cell::Code(label(&p.start)),
                    Cell::Code(sequence.join(" → ")),
                    Cell::Plain(grouped(p.occurrences)),
                    Cell::Plain(format!("{}%", (p.confidence * 100.0).round())),
                    Cell::Plain(optional_ms(p.cycle_ms)),
                ]
            })
            .collect(),
    );
    section(
        "Multiplexed frames",
        vec!["Frame", "Selector", "Cases", "Mux period", "Inter-message"],
        bus.mux
            .iter()
            .map(|m| {
                let selector = m.detection.selector;
                let cases: Vec<String> =
                    m.detection.occurrences.keys().take(MAX_CASES).map(|v| mux_value(*v, selector)).collect();
                let more = m.detection.occurrences.len().saturating_sub(MAX_CASES);
                let cases = if more > 0 { format!("{} (+{more} more)", cases.join(", ")) } else { cases.join(", ") };
                vec![
                    Cell::Code(label(&m.key)),
                    Cell::Code(selector_text(selector).into()),
                    Cell::Plain(cases),
                    Cell::Plain(optional_ms(m.mux_period_ms)),
                    Cell::Plain(ms(m.inter_message_ms)),
                ]
            })
            .collect(),
    );
    section(
        "Bursts",
        vec!["Frame", "Lengths", "Frames per burst", "Cycle", "Flags"],
        bus.bursts
            .iter()
            .map(|b| {
                let lengths: Vec<String> = b.lengths.iter().map(usize::to_string).collect();
                let size = if b.frames_per_burst == 1.0 { "—".into() } else { format!("~{:.1}", b.frames_per_burst) };
                let flags: Vec<&str> = b.flags.iter().map(flag_text).collect();
                vec![
                    Cell::Code(label(&b.key)),
                    Cell::Plain(lengths.join(", ")),
                    Cell::Plain(size),
                    Cell::Plain(ms(b.burst_period_ms)),
                    Cell::Plain(if flags.is_empty() { "—".into() } else { flags.join(", ") }),
                ]
            })
            .collect(),
    );
    section(
        "Repetition groups",
        vec!["Interval", "Frames", "Ids"],
        bus.interval_groups
            .iter()
            .map(|g| {
                let ids: Vec<String> = g.keys.iter().map(label).collect();
                vec![
                    Cell::Plain(format!("~{}", ms(g.interval_ms))),
                    Cell::Plain(grouped(g.keys.len())),
                    Cell::Code(ids.join(", ")),
                ]
            })
            .collect(),
    );
    section(
        "Start candidates",
        vec!["Frame", "Max gap", "Avg gap", "Min gap", "Count"],
        bus.start_candidates
            .iter()
            .take(MAX_CANDIDATES)
            .map(|c| {
                vec![
                    Cell::Code(label(&c.key)),
                    Cell::Plain(ms(c.max_gap_before_ms)),
                    Cell::Plain(ms(c.avg_gap_before_ms)),
                    Cell::Plain(ms(c.min_gap_before_ms)),
                    Cell::Plain(grouped(c.occurrences)),
                ]
            })
            .collect(),
    );
    blocks
}

fn flag_text(flag: &BurstFlag) -> &'static str {
    match flag {
        BurstFlag::VariableLength => "variable length",
        BurstFlag::BurstPattern => "burst pattern",
        BurstFlag::RequestResponse => "request/response",
    }
}
