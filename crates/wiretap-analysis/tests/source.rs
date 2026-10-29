//! The levers over a source, driven on the in-memory one without a runtime.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use serde_json::json;
use wiretap_analysis::source::{
    byte_profile, byte_profiles, catalog_coverage, checksum_scan, message_order, timed_by_protocol,
    FrameSelection, FrameSource, InventoryRow, MemorySource, OrderStart, PayloadQuery,
    PayloadSource, ProtocolFrames, Sampling, ScanFilter, Source,
};
use wiretap_analysis::{analyse_order, ByteRole, Direction, FrameKey};
use wslib_wiretap_catalogue::Catalogue;

/// Every future here is ready on its first poll, or polled until it is.
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
            return output;
        }
    }
}

fn counter_source(frames: u8) -> MemorySource {
    let mut source = MemorySource::default();
    for i in 0..frames {
        source.push("can", 0x100, false, vec![0xC0, i]);
    }
    source
}

#[test]
fn byte_profiles_read_each_frames_most_recent_run() {
    let source = counter_source(50);

    let profiles = block_on(byte_profiles(
        &source,
        &ScanFilter::Ids(vec![]),
        10,
        usize::MAX,
    ))
    .unwrap();

    let profile = &profiles.frames[0].profile;
    assert_eq!(profile.sample_count, 10);
    assert_eq!(
        profile.columns[1].stats.min, 40,
        "the newest ten, not the first"
    );
    assert!(matches!(
        profile.columns[1].role,
        ByteRole::Counter {
            direction: Direction::Up,
            step: 1,
            ..
        }
    ));
}

#[test]
fn a_checksum_scan_samples_across_the_recording() {
    let source = counter_source(50);

    block_on(checksum_scan(
        &source,
        &ScanFilter::Ids(vec![]),
        10,
        Default::default(),
    ))
    .unwrap();

    assert_eq!(source.asked(), vec![(0x100, None, Sampling::Spread)]);
}

#[test]
fn a_checksum_scan_over_more_ids_than_a_chunk_counts_every_one() {
    let mut source = MemorySource::default();
    for id in 0..40 {
        for i in 0..20u8 {
            source.push("can", id, false, vec![i, i ^ 0x5A]);
        }
    }

    let result = block_on(checksum_scan(
        &source,
        &ScanFilter::Ids(vec![]),
        20,
        Default::default(),
    ))
    .unwrap();

    assert_eq!(result.unique_frame_ids, 40);
    assert_eq!(result.frame_count, 800);
}

#[test]
fn only_an_id_seen_both_standard_and_extended_is_fetched_by_its_width() {
    let mut source = MemorySource::default();
    source.push("can", 0x100, false, vec![1]);
    source.push("can", 0x100, true, vec![2]);
    source.push("can", 0x200, false, vec![3]);

    let profiles = block_on(byte_profiles(
        &source,
        &ScanFilter::Ids(vec![]),
        10,
        usize::MAX,
    ))
    .unwrap();

    assert_eq!(profiles.frames.len(), 3);
    let asked: Vec<_> = source.asked().iter().map(|a| (a.0, a.1)).collect();
    assert_eq!(
        asked,
        vec![(0x100, Some(false)), (0x100, Some(true)), (0x200, None)]
    );
}

#[test]
fn frames_past_max_frames_are_counted_not_profiled() {
    let mut source = MemorySource::default();
    for id in 0..5 {
        source.push("can", id, false, vec![0]);
    }

    let profiles = block_on(byte_profiles(&source, &ScanFilter::Ids(vec![]), 10, 2)).unwrap();

    assert_eq!(profiles.frames.len(), 2);
    assert_eq!(profiles.skipped_frames, 3);
}

#[test]
fn a_selection_scans_only_its_protocols_ids() {
    let mut source = MemorySource::default();
    source.push("can", 0x100, false, vec![1]);
    source.push("modbus", 0x100, false, vec![2]);
    let selection = FrameSelection::from_groups(vec![ProtocolFrames::ids("can", vec![0x100])]);

    let profiles = block_on(byte_profiles(
        &source,
        &ScanFilter::Selection(selection),
        10,
        usize::MAX,
    ))
    .unwrap();

    assert_eq!(profiles.frames.len(), 1);
    assert_eq!(profiles.frames[0].protocol.as_deref(), Some("can"));
}

/// Two ids carrying one counter together, and a third sent in bursts of two.
fn mirrored_and_bursty() -> MemorySource {
    let mut source = MemorySource::default();
    for i in 0..20u8 {
        let t = i as u64 * 100_000;
        source.push_at("can", 0, 0x100, false, t, vec![i, 0xA0]);
        source.push_at("can", 0, 0x200, false, t + 1_000, vec![i, 0xA0]);
        source.push_at("can", 1, 0x300, false, t + 2_000, vec![0x80 + i, 0x55]);
        source.push_at("can", 1, 0x300, false, t + 4_000, vec![0x80 + i, 0x66]);
    }
    source
}

#[test]
fn frame_order_is_the_libs_answer_per_protocol() {
    let mut source = mirrored_and_bursty();
    source.push_at("modbus", 0, 0x100, false, 5_000_000, vec![1]);
    let start = OrderStart {
        protocol: Some("can".into()),
        frame_id: 0x200,
        is_extended: false,
    };

    let orders = block_on(message_order(
        &source,
        &FrameSelection::default(),
        None,
        Some(&start),
    ))
    .unwrap();

    let protocols: Vec<&str> = orders.iter().map(|o| o.protocol.as_str()).collect();
    assert_eq!(protocols, vec!["can", "modbus"]);
    let frames =
        timed_by_protocol(block_on(source.frames(&FrameSelection::default(), None)).unwrap());
    assert_eq!(
        orders[0].order,
        analyse_order(&frames["can"], Some(FrameKey::new(0x200, false)))
    );
    assert_eq!(orders[1].order, analyse_order(&frames["modbus"], None));
    assert_eq!(orders[0].order.buses.len(), 2, "each bus its own schedule");
}

#[test]
fn a_live_window_reads_only_the_newest_frames() {
    let source = mirrored_and_bursty();

    let orders = block_on(message_order(
        &source,
        &FrameSelection::default(),
        Some(10),
        None,
    ))
    .unwrap();

    assert_eq!(orders[0].order.total_frames, 10);
}

async fn profiles_then_order<S: PayloadSource + FrameSource>(
    source: &S,
) -> Result<(usize, usize), S::Error> {
    let profiles = byte_profiles(source, &ScanFilter::Ids(vec![]), 10, usize::MAX).await?;
    let orders = message_order(source, &FrameSelection::default(), None, None).await?;
    Ok((profiles.frames.len(), orders.len()))
}

#[test]
fn a_source_read_both_ways_has_one_error() {
    let counts = block_on(profiles_then_order(&mirrored_and_bursty())).unwrap();

    assert_eq!(counts, (3, 1));
}

fn groups(entries: &[(&str, &[u32])]) -> Vec<ProtocolFrames> {
    entries
        .iter()
        .map(|(protocol, ids)| ProtocolFrames::ids(*protocol, ids.to_vec()))
        .collect()
}

/// Empty means "select everything" at every call site, so a group carrying no ids must
/// not leave the selection looking non-empty — that would invert "select nothing".
#[test]
fn groups_with_no_ids_normalise_to_an_empty_selection() {
    assert!(FrameSelection::from_groups(groups(&[("can", &[])])).is_empty());
    assert!(FrameSelection::from_groups(Vec::new()).is_empty());
    assert!(!FrameSelection::from_groups(groups(&[("can", &[256])])).is_empty());
}

#[test]
fn repeated_groups_merge_and_deduplicate() {
    let selection = FrameSelection::from_groups(groups(&[("can", &[256, 256]), ("can", &[257])]));
    assert_eq!(selection.pairs(), vec![(256, "can"), (257, "can")]);
}

/// Keyed on the bare id, a CAN-only selection wrongly "covered" a capture holding
/// Modbus too, and the tail silently returned unfiltered rows.
#[test]
fn covers_is_protocol_aware() {
    let seen: &[(&str, &[u32])] = &[("can", &[256]), ("modbus", &[256])];
    let covers = |selection: FrameSelection| selection.covers(seen.iter().copied());

    assert!(!covers(FrameSelection::from_groups(groups(&[(
        "can",
        &[256, 257]
    )]))));
    assert!(covers(FrameSelection::from_groups(groups(seen))));
}

/// A protocol tab selects its protocol whole: not empty (which would select
/// everything), covering every id of that protocol including ones not yet seen,
/// and contributing no pairs — the predicate matches it by name.
#[test]
fn a_protocol_selected_whole_covers_ids_it_has_not_seen() {
    let selection = FrameSelection::from_groups(vec![ProtocolFrames::whole("modbus_rtu")]);
    assert!(!selection.is_empty());
    assert!(selection.contains("modbus_rtu", 0x0265));
    assert!(!selection.contains("can", 0x0265));
    let modbus: &[(&str, &[u32])] = &[("modbus_rtu", &[288, 613])];
    assert!(selection.covers(modbus.iter().copied()));
    let mixed_seen: &[(&str, &[u32])] = &[("modbus_rtu", &[288]), ("can", &[256])];
    assert!(!selection.covers(mixed_seen.iter().copied()));
    assert!(selection.pairs().is_empty());
    assert_eq!(selection.protocols(), vec!["modbus_rtu"]);

    let mut mixed = groups(&[("can", &[256]), ("modbus_rtu", &[288])]);
    mixed.push(ProtocolFrames::whole("modbus_rtu"));
    let mixed = FrameSelection::from_groups(mixed);
    assert_eq!(mixed.pairs(), vec![(256, "can")]);
    assert_eq!(mixed.protocols(), vec!["modbus_rtu"]);
}

#[test]
fn pairs_are_sorted_regardless_of_insertion_order() {
    let a = FrameSelection::from_groups(groups(&[("modbus", &[257, 256]), ("can", &[256])]));
    let b = FrameSelection::from_groups(groups(&[("can", &[256]), ("modbus", &[256, 257])]));
    assert_eq!(a.pairs(), b.pairs());
    assert_eq!(
        a.pairs(),
        vec![(256, "can"), (256, "modbus"), (257, "modbus")]
    );
}

const COVERED: &str = r#"
[meta]
name = "covered"

[frame.can.0x100]
length = 2

[[frame.can.0x100.signals]]
name = "high"
start_bit = 0
bit_length = 8
confidence = "high"

[[frame.can.0x100.signals]]
name = "said_none"
start_bit = 8
bit_length = 4
confidence = "none"

[[frame.can.0x100.signals]]
name = "said_nothing"
start_bit = 12
bit_length = 4

[frame.can.0x200]
length = 1
"#;

/// Inventory from memory, and payloads that never read.
struct UnreadablePayloads(MemorySource);

impl Source for UnreadablePayloads {
    type Error = String;
}

impl PayloadSource for UnreadablePayloads {
    async fn inventory(
        &self,
        start_us: Option<i64>,
        end_us: Option<i64>,
    ) -> Result<Vec<InventoryRow>, String> {
        Ok(self.0.inventory(start_us, end_us).await.unwrap())
    }

    async fn payloads(&self, _: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
        Err("unreadable".into())
    }
}

#[test]
fn coverage_is_snake_case_and_says_unset_for_none_and_absent_alike() {
    let catalog = Catalogue::parse(COVERED).unwrap();
    let mut source = MemorySource::default();
    source.push("can", 0x100, false, vec![1, 2]);
    source.push("can", 0x300, false, vec![3]);

    let report = block_on(catalog_coverage(
        &source, "covered", &catalog, false, 10, None, None,
    ))
    .unwrap();

    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        json!({
            "catalog": "covered",
            "catalog_frames": 2,
            "data_frames": 2,
            "present": [{
                "frame_id": 0x100,
                "frame_id_hex": "0x100",
                "name": null,
                "count": 1,
                "first_us": 0,
                "last_us": 0,
                "signals": [
                    { "name": "high", "confidence": "high" },
                    { "name": "said_none", "confidence": "unset" },
                    { "name": "said_nothing", "confidence": "unset" },
                ],
            }],
            "missing": [{ "frame_id": 0x200, "frame_id_hex": "0x200", "name": null }],
            "uncatalogued": [{
                "frame_id": 0x300,
                "frame_id_hex": "0x300",
                "is_extended": false,
                "count": 1,
            }],
            "confidence": { "high": 1, "medium": 0, "low": 0, "unset": 2 },
        })
    );
}

#[test]
fn a_payload_read_failure_costs_coverage_its_byte_roles_not_the_report() {
    let catalog = Catalogue::parse(COVERED).unwrap();
    let mut memory = MemorySource::default();
    memory.push("can", 0x100, false, vec![1, 2]);

    let report = block_on(catalog_coverage(
        &UnreadablePayloads(memory),
        "covered",
        &catalog,
        true,
        10,
        None,
        None,
    ))
    .unwrap();

    let roles = report.present[0].byte_roles.as_ref().unwrap();
    assert_eq!(roles.sample_count, 0);
}

#[test]
fn a_frames_byte_roles_read_only_its_own_protocols_payloads() {
    let catalog = Catalogue::parse(COVERED).unwrap();
    let mut source = MemorySource::default();
    for i in 0..3 {
        source.push("can", 0x100, false, vec![i, 0]);
    }
    source.push("modbus", 256, false, vec![9, 9, 9, 9]);

    let report = block_on(catalog_coverage(
        &source, "covered", &catalog, true, 10, None, None,
    ))
    .unwrap();

    let roles = report.present[0].byte_roles.as_ref().unwrap();
    assert_eq!(
        (roles.sample_count, roles.max_len),
        (3, 2),
        "Modbus register 256 is not CAN 0x100"
    );
}

#[test]
fn the_mcp_shapes_keep_their_casing() {
    let mut source = MemorySource::default();
    source.push("can", 0x100, false, vec![1]);

    let profile = serde_json::to_value(
        block_on(byte_profile(&source, Some("can"), 0x100, None, 10)).unwrap(),
    )
    .unwrap();
    assert_eq!(profile["frameId"], 0x100);
    assert_eq!(profile["isExtended"], false);
    assert_eq!(profile["frameIdHex"], "0x100");
    assert_eq!(profile["protocol"], "can");
    assert_eq!(profile["sampleCount"], 1, "the profile flattened in");

    let orders = block_on(message_order(
        &source,
        &FrameSelection::default(),
        None,
        None,
    ))
    .unwrap();
    let order = serde_json::to_value(&orders[0]).unwrap();
    assert_eq!(order["protocol"], "can");
    assert_eq!(order["order"]["totalFrames"], 1);

    let start: OrderStart =
        serde_json::from_value(json!({ "frameId": 1, "isExtended": true })).unwrap();
    assert_eq!(start.protocol, None);
    assert_eq!(
        serde_json::to_value(&start).unwrap(),
        json!({ "protocol": null, "frameId": 1, "isExtended": true })
    );

    let rows = block_on(source.inventory(None, None)).unwrap();
    assert_eq!(
        serde_json::to_value(&rows[0]).unwrap(),
        json!({
            "protocol": "can",
            "frame_id": 0x100,
            "frame_id_hex": "0x100",
            "is_extended": false,
            "count": 1,
            "first_us": 0,
            "last_us": 0,
            "max_dlc": 1,
        })
    );
}

const METERED: &str = r#"
[meta]
name = "metered"

[frame.modbus.voltage]
register_number = 260
register_type = "input"
length = 2

[frame.modbus.power]
register_number = 500
register_type = "input"
length = 2

[frame.modbus.energy]
register_number = 502
register_type = "input"
length = 2

[frame.modbus.setpoint]
register_number = 100
register_type = "holding"
length = 1
"#;

fn with_crc(body: &[u8]) -> Vec<u8> {
    let crc = wslib_checksum::algorithms::crc16_modbus_checksum(body);
    [body, &crc.to_le_bytes()].concat()
}

/// A read request and its response, as a `modbus_rtu` archive keys them: both
/// under `unit << 8 | function`, each one whole message.
fn exchange(source: &mut MemorySource, unit: u8, function: u8, start: u16, values: &[u16]) {
    let id = u32::from(unit) << 8 | u32::from(function);
    let quantity = values.len() as u16;
    let request = [
        &[unit, function][..],
        &start.to_be_bytes(),
        &quantity.to_be_bytes(),
    ]
    .concat();
    let data: Vec<u8> = values.iter().flat_map(|v| v.to_be_bytes()).collect();
    let response = [&[unit, function, data.len() as u8][..], &data].concat();
    source.push("modbus_rtu", id, false, with_crc(&request));
    source.push("modbus_rtu", id, false, with_crc(&response));
}

/// Unit 1 FC04 is row `0x104`, which is the `voltage` register's number.
fn metered_line() -> MemorySource {
    let mut source = MemorySource::default();
    exchange(&mut source, 1, 0x04, 500, &[1, 2, 3, 4]);
    exchange(&mut source, 1, 0x03, 100, &[7]);
    exchange(&mut source, 1, 0x04, 500, &[5, 6, 7, 8]);
    exchange(&mut source, 1, 0x04, 700, &[9]);
    exchange(&mut source, 2, 0x03, 40, &[1, 2]);
    source
}

fn metered_coverage(source: &MemorySource) -> wiretap_analysis::source::CoverageReport {
    let catalog = Catalogue::parse(METERED).unwrap();
    block_on(catalog_coverage(
        source, "metered", &catalog, true, 10, None, None,
    ))
    .unwrap()
}

#[test]
fn an_rtu_read_counts_every_catalogue_frame_it_holds_whole() {
    let report = metered_coverage(&metered_line());

    let present: Vec<(&str, &str, i64)> = report
        .present
        .iter()
        .map(|f| (f.name.as_deref().unwrap(), f.frame_id_hex.as_str(), f.count))
        .collect();
    assert_eq!(
        present,
        [
            ("energy", "unit 1 input 502", 2),
            ("power", "unit 1 input 500", 2),
            ("setpoint", "unit 1 holding 100", 1),
        ],
        "one count per exchange, from the response its request placed"
    );
    let energy = &report.present[0];
    assert_eq!(
        (energy.first_us, energy.last_us),
        (0, 7),
        "the row's bounds"
    );
    let roles = energy.byte_roles.as_ref().unwrap();
    assert_eq!(roles.sample_count, 2, "profiled over its own registers");
}

#[test]
fn an_rtu_row_id_is_not_a_register_number() {
    let mut source = metered_line();
    source.push("can", 0x104, false, vec![0; 8]);
    let report = metered_coverage(&source);

    let missing: Vec<(&str, &str)> = report
        .missing
        .iter()
        .map(|f| (f.name.as_deref().unwrap(), f.frame_id_hex.as_str()))
        .collect();
    assert_eq!(
        missing,
        [("voltage", "unit 1 input 260")],
        "unit 1 FC04 is row 0x104 = 260, and neither it nor CAN 0x104 reads register 260"
    );
}

#[test]
fn an_rtu_read_holding_no_catalogue_frame_is_uncatalogued_by_unit_bank_and_register() {
    let mut source = metered_line();
    source.push("can", 0x104, false, vec![0; 8]);
    let report = metered_coverage(&source);

    assert_eq!(
        serde_json::to_value(&report.uncatalogued).unwrap(),
        json!([
            {
                "frame_id": 40,
                "frame_id_hex": "unit 2 holding 40",
                "is_extended": false,
                "count": 1,
                "unit": 2,
                "register_type": "holding",
            },
            { "frame_id": 0x104, "frame_id_hex": "0x104", "is_extended": false, "count": 1 },
            {
                "frame_id": 700,
                "frame_id_hex": "unit 1 input 700",
                "is_extended": false,
                "count": 1,
                "unit": 1,
                "register_type": "input",
            },
        ])
    );
    assert_eq!(report.data_frames, 6, "three catalogue frames, three reads");
}

#[test]
fn a_register_less_rtu_message_is_uncatalogued_by_unit_and_function() {
    let mut source = MemorySource::default();
    for _ in 0..2 {
        source.push("modbus_rtu", 0x141, false, with_crc(&[1, 0x41, 0xDE, 0xAD]));
    }
    source.push("modbus_rtu", 0x184, false, with_crc(&[1, 0x84, 0x02]));
    let report = metered_coverage(&source);

    assert_eq!(
        serde_json::to_value(&report.uncatalogued).unwrap(),
        json!([{
            "frame_id": 0x141,
            "frame_id_hex": "unit 1 fn 0x41",
            "is_extended": false,
            "count": 2,
            "unit": 1,
        }]),
        "a vendor code counts per message; an exception is skipped"
    );
}

#[test]
fn a_register_both_polled_and_read_off_the_line_is_one_data_frame() {
    let mut source = metered_line();
    source.push("modbus", 500, false, vec![0, 1, 0, 2]);
    let report = metered_coverage(&source);

    let power = report
        .present
        .iter()
        .find(|f| f.name.as_deref() == Some("power"));
    assert_eq!(power.unwrap().count, 3, "two reads and one poll");
    assert_eq!(report.data_frames, 5, "three catalogue frames, two reads");
}
