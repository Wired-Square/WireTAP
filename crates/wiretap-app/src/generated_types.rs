// crates/wiretap-app/src/generated_types.rs
//
// The TypeScript the frontend reads for the serde shapes it shares with this
// crate, written into `frontend/wiretap-ui/src/generated/` by `ts-rs`. The test
// regenerates the directory and fails while what was committed differs, so a
// stale or missing file cannot pass; `npm run gen:types` regenerates it.

use std::any::TypeId;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use ts_rs::{Config, TypeVisitor, TS};

const HEADER: &str = "// Generated from the Rust serde types by `npm run gen:types`. Do not edit.\n";

fn out_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/wiretap-ui/src/generated")
}

struct Render {
    cfg: Config,
    files: BTreeMap<PathBuf, (TypeId, String)>,
}

impl TypeVisitor for Render {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        let Some(path) = T::output_path() else { return };
        if let Some((id, _)) = self.files.get(&path) {
            assert_eq!(*id, TypeId::of::<T>(), "two Rust types export to {path:?}; rename one with #[ts(rename)]");
            return;
        }
        let text = T::export_to_string(&self.cfg).expect("ts-rs renders every derived type");
        let body = text.split_once('\n').map_or(text.as_str(), |(_, rest)| rest);
        self.files.insert(path, (TypeId::of::<T>(), format!("{HEADER}{body}")));
        T::visit_dependencies(self);
    }
}

fn render() -> BTreeMap<PathBuf, String> {
    let mut r = Render {
        cfg: Config::new().with_large_int("number"),
        files: BTreeMap::from([
            (
                PathBuf::from("wireConstants.ts"),
                (TypeId::of::<crate::ws::protocol::MsgType>(), wire_constants()),
            ),
            (
                PathBuf::from("byteNames.ts"),
                (TypeId::of::<wiretap_decode::PayloadField>(), byte_names()),
            ),
            (
                PathBuf::from("settingRanges.ts"),
                (TypeId::of::<crate::settings::AppSettings>(), setting_ranges()),
            ),
            (
                PathBuf::from("checksumAlgorithms.ts"),
                (TypeId::of::<wiretap_checksum::ChecksumAlgorithm>(), checksum_algorithms()),
            ),
            (
                PathBuf::from("canFdLengths.ts"),
                (TypeId::of::<crate::io::CanTransmitFrame>(), can_fd_lengths()),
            ),
            (
                PathBuf::from("framelinkNames.ts"),
                (TypeId::of::<framelink::protocol::frame_def::FrameSignalDef>(), framelink_names()),
            ),
        ]),
    };
    r.visit::<crate::io::GvretDeviceInfo>();
    r.visit::<crate::io::ActiveSessionInfo>();
    r.visit::<crate::io::bus_status::BusStatusMsg>();
    r.visit::<crate::io::AppInstanceInfo>();
    r.visit::<crate::io::CanTransmitFrame>();
    r.visit::<crate::io::ModbusRangeSpec>();
    r.visit::<crate::io::PlaybackPosition>();
    r.visit::<crate::io::RegisterSubscriberResult>();
    r.visit::<crate::io::ReinitializeResult>();
    r.visit::<crate::io::SessionLifecyclePayload>();
    r.visit::<crate::io::session_log::SessionLogEntry>();
    r.visit::<crate::io::ScanJob>();
    r.visit::<crate::io::SerialOverrides>();
    r.visit::<crate::io::StepResult>();
    r.visit::<crate::io::TransmitResult>();
    r.visit::<crate::io::VirtualBusState>();
    r.visit::<crate::io::modbus_tcp::scanner::FcProbeConfig>();
    r.visit::<crate::io::modbus_tcp::scanner::FcProbeEntry>();
    r.visit::<crate::io::modbus_tcp::scanner::ScanCompletePayload>();
    r.visit::<crate::io::modbus_tcp::scanner::ScanProgressPayload>();
    r.visit::<crate::io::post_session::SourceInfo>();
    r.visit::<crate::io::post_session::StreamEndedInfo>();
    r.visit::<crate::captures::BytesTailResponse>();
    r.visit::<crate::sessions::DeviceProbeResult>();
    r.visit::<crate::sessions::MultiSourceInput>();
    r.visit::<crate::sessions::OpenSessionOptions>();
    r.visit::<crate::sessions::OpenedSession>();
    r.visit::<crate::sessions::SessionRefusal>();
    r.visit::<crate::sessions::ProfileUsageInfo>();
    r.visit::<crate::sessions::SessionPurpose>();
    r.visit::<crate::ws::decoded::DecodedSignalsEntry<'static>>();
    r.visit::<crate::adhoc::AdhocBatch>();
    r.visit::<crate::dashboard_history::SignalRef>();
    r.visit::<crate::dashboard_history::SeriesWindow>();
    r.visit::<crate::dashboard_history::AlignedSeries>();
    r.visit::<crate::dashboard_history::HistogramBins>();
    r.visit::<crate::io::modbus_tcp::scanner::ModbusScanState>();
    r.visit::<crate::ws::dispatch::AttachToPanelMsg<'static>>();
    r.visit::<crate::settings::DirectoryValidation>();
    r.visit::<crate::io::profiles::DeviceWriteError>();
    r.visit::<crate::io::traits::ProfileTraitsTable>();
    r.visit::<crate::captures::CandumpImportResult>();
    r.visit::<crate::captures::CsvImportResult>();
    r.visit::<crate::captures::PaginatedBytesResponse>();
    r.visit::<crate::captures::PaginatedFramesResponse>();
    r.visit::<crate::capture_store::CaptureFrameInfo>();
    r.visit::<crate::capture_inventory::FrameInventoryMsg>();
    r.visit::<crate::capture_store::TailResponse>();
    r.visit::<crate::io::CsvColumnMapping>();
    r.visit::<crate::io::CsvPreview>();
    r.visit::<crate::io::CsvTimestampPreview>();
    r.visit::<crate::framing::BackendFramingConfig>();
    r.visit::<crate::framing::FramingResult>();
    r.visit::<crate::framing::SerialIds>();
    r.visit::<crate::catalog_share::CatalogSourcesView>();
    r.visit::<crate::catalog_share::ImportRequest>();
    r.visit::<crate::catalog_share::ImportResult>();
    r.visit::<crate::catalog_share::RemoteCatalog>();
    r.visit::<crate::catalog_share::RemoteCatalogText>();
    r.visit::<crate::catalog_share::PullOutcome>();
    r.visit::<crate::catalog_share::RepoBrowse>();
    r.visit::<crate::catalog_share::RepoStatus>();
    r.visit::<crate::catalog_share::SaveRepoResult>();
    r.visit::<crate::catalog_share::SavedReposView>();
    r.visit::<crate::catalog_share::TrackedPr>();
    r.visit::<crate::catalog_share::UpdateCheckResult>();
    r.visit::<crate::catalog_share::community::CommunityReposView>();
    r.visit::<crate::catalog_share::error::ShareError>();
    r.visit::<crate::catalog_share::git::Progress>();
    r.visit::<crate::catalog_share::github::NewRepo>();
    r.visit::<crate::catalog_share::publish::ProgressEvent>();
    r.visit::<crate::catalog_share::publish::PublishDiff>();
    r.visit::<crate::catalog_share::publish::PublishDiffRequest>();
    r.visit::<crate::catalog_share::publish::PublishPlan>();
    r.visit::<crate::catalog_share::publish::PublishRequest>();
    r.visit::<crate::catalog_share::publish::PublishResult>();
    r.visit::<crate::catalog_share::registry::GitIdentity>();
    r.visit::<crate::capture_db::InventoryRow>();
    r.visit::<crate::query::QueryQueue>();
    r.visit::<crate::query::QueryOutcome>();
    r.visit::<crate::query::QueryRequest>();
    r.visit::<crate::gateway_admin::GatewayDaemon>();
    r.visit::<crate::gateway_admin::AssignmentOutcome>();
    r.visit::<crate::replay::ReplayEstimate>();
    r.visit::<crate::replay::ReplaySource>();
    r.visit::<crate::replay::ReplayState>();
    r.visit::<crate::transmit::SerialFraming>();
    r.visit::<crate::transmit::TransmitProfile>();
    r.visit::<crate::transmit_queue::NewQueueRow>();
    r.visit::<crate::transmit_queue::QueueRowEdit>();
    r.visit::<crate::transmit_queue::TransmitQueue>();
    r.visit::<crate::io::framelink::FrameLinkProbeResult>();
    r.visit::<crate::io::framelink::SignalReadResult>();
    r.visit::<crate::io::framelink::rules::BridgeDescriptor>();
    r.visit::<crate::io::framelink::rules::DeviceSignalDescriptor>();
    r.visit::<crate::io::framelink::rules::FrameDefDescriptor>();
    r.visit::<crate::io::framelink::rules::GeneratorDescriptor>();
    r.visit::<crate::io::framelink::rules::TransformerDescriptor>();
    r.visit::<crate::io::framelink::rules::SignalPlacement>();
    r.visit::<crate::io::framelink::rules::FrameLinkIdKind>();
    r.visit::<crate::io_test::IOTestState>();
    r.visit::<crate::io_test::TestConfig>();
    r.visit::<crate::flashers::DetectedChip>();
    r.visit::<crate::flashers::EspFlashOptions>();
    r.visit::<crate::flashers::FlasherProgress>();
    r.visit::<crate::flashers::Stm32FlashOptions>();
    r.visit::<crate::analysis::ProtocolOrder>();
    r.visit::<crate::analysis::OrderStart>();
    r.visit::<crate::byte_roles::ProtocolMirrors>();
    r.visit::<crate::analysis_ts::ByteNotes>();
    r.visit::<crate::analysis_ts::CandidateSignal>();
    r.visit::<crate::drafting::DraftPreview>();
    r.visit::<crate::drafting::DraftWrite>();
    r.files.into_iter().map(|(path, (_, text))| (path, text)).collect()
}

/// The binary WS protocol's constants, from `ws::protocol`.
fn wire_constants() -> String {
    use crate::ws::protocol::*;
    fn table<V: std::fmt::LowerHex>(name: &str, entries: impl IntoIterator<Item = (&'static str, V)>, width: usize) -> String {
        let rows: String = entries.into_iter().map(|(key, value)| format!("  {key}: 0x{value:0width$x},\n")).collect();
        format!("export const {name} = {{\n{rows}}} as const;\n")
    }
    fn names(name: &str, table: &[&str]) -> String {
        format!("export const {name} = {table:?} as const;\n")
    }
    [
        HEADER.to_string(),
        format!("export const PROTOCOL_VERSION = {PROTOCOL_VERSION};\n"),
        format!("export const HEADER_SIZE = {HEADER_SIZE};\n"),
        format!("export const ENVELOPE_HEADER_SIZE = {ENVELOPE_HEADER_SIZE};\n"),
        table("MsgType", MsgType::VARIANTS.iter().map(|(k, v)| (*k, *v as u8)), 2),
        table("FrameType", FrameType::VARIANTS.iter().map(|(k, v)| (*k, *v as u8)), 2),
        table("CanFlags", wiretap_protocol::can::CanFlags::NAMES.iter().copied(), 2),
        table("IdFlags", ID_FLAGS.iter().copied(), 8),
        table("StreamEndedFlags", STREAM_ENDED_FLAGS.iter().copied(), 2),
        names("SESSION_STATES", &SESSION_STATES),
        names("STREAM_END_REASONS", &STREAM_END_REASONS),
        names("SESSION_ERROR_SEVERITIES", &SESSION_ERROR_SEVERITIES),
        names("SESSION_TRANSITIONS", &SESSION_TRANSITIONS),
        names("SESSION_MODES", &SESSION_MODES),
        format!("export const SESSION_LOG_CAPACITY = {};\n", crate::io::session_log::SESSION_LOG_CAPACITY),
        format!(
            "export const MODBUS_SCAN_SOURCE_TYPE = {:?};\n",
            crate::io::modbus_tcp::scan_source::MODBUS_SCAN_SOURCE_TYPE
        ),
        format!("export const NAME_KEYED_FRAME_ID = {};\n", wiretap_catalog::NAME_KEYED_FRAME_ID),
    ]
    .join("\n")
}

/// The fixed-width checksum algorithms, in the sweep's preference order. The
/// parameterised ids (`crc_custom`, `sum8_negated`) are absent: their width is
/// the declaration's `byte_length`.
fn checksum_algorithms() -> String {
    let rows: String = wiretap_checksum::ALL_ALGORITHMS
        .iter()
        .map(|a| format!("  {}: {},\n", a.as_str(), a.output_bytes()))
        .collect();
    format!("{HEADER}\nexport const CHECKSUM_OUTPUT_BYTES = {{\n{rows}}} as const;\n")
}

/// The payload lengths a CAN FD frame can carry, one per length code.
fn can_fd_lengths() -> String {
    format!("{HEADER}\nexport const CAN_FD_DLC_VALUES = {:?} as const;\n", wiretap_protocol::FD_DLC_LEN)
}

/// FrameLink's interface and signal value-type names, by their wire codes.
fn framelink_names() -> String {
    use framelink::protocol::{frame_def::value_type_name, types::interface_name};
    let interfaces: String = (0..=u8::MAX)
        .map(|code| (code, interface_name(code)))
        .filter(|(_, name)| *name != "Unknown")
        .map(|(code, name)| format!("  {code}: {name:?},\n"))
        .collect();
    let value_types: Vec<_> = (0..=u8::MAX).map(value_type_name).take_while(|name| *name != "unknown").collect();
    format!(
        "{HEADER}\nexport const INTERFACE_TYPE_NAMES: Record<number, string> = {{\n{interfaces}}};\n\nexport const VALUE_TYPE_NAMES = {value_types:?} as const;\n"
    )
}

/// Each byte of the longest payload as `wiretap_decode::byte_name` spells a
/// one-byte field, for the panels that chart every byte.
fn byte_names() -> String {
    let names: String = (0..64)
        .map(|i| format!("  \"{}\",\n", wiretap_decode::byte_name(i, 8, wiretap_decode::Endianness::Little)))
        .collect();
    format!("{HEADER}\nexport const BYTE_NAMES = [\n{names}] as const;\n")
}

/// The numeric settings `clamp_settings` bounds, by field.
fn setting_ranges() -> String {
    let rows: String = crate::settings::SETTING_RANGES
        .iter()
        .map(|(field, min, max)| format!("  {field}: {{ min: {min}, max: {max} }},\n"))
        .collect();
    format!("{HEADER}\nexport const SETTING_RANGES = {{\n{rows}}} as const;\n")
}

fn committed(dir: &Path) -> BTreeMap<PathBuf, String> {
    let Ok(entries) = fs::read_dir(dir) else { return BTreeMap::new() };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "ts"))
        .map(|p| (PathBuf::from(p.file_name().unwrap()), fs::read_to_string(&p).unwrap()))
        .collect()
}

#[test]
fn generated_types_match_the_rust_shapes() {
    let dir = out_dir();
    let want = render();
    let have = committed(&dir);
    if want == have {
        return;
    }

    fs::create_dir_all(&dir).unwrap();
    for stale in have.keys().filter(|p| !want.contains_key(*p)) {
        fs::remove_file(dir.join(stale)).unwrap();
    }
    for (path, text) in &want {
        if have.get(path) != Some(text) {
            fs::write(dir.join(path), text).unwrap();
        }
    }

    let changed: BTreeSet<_> = want.keys().chain(have.keys()).filter(|p| want.get(*p) != have.get(*p)).collect();
    assert!(
        std::env::var_os("WIRETAP_GEN_TYPES").is_some(),
        "src/generated was stale and has been rewritten; commit it: {changed:?}"
    );
}

/// A declared field: whether it may be absent, and its TypeScript type.
type Fields = BTreeMap<String, (bool, String)>;

/// Splits on `sep` outside brackets, braces and string literals.
fn split_top(s: &str, sep: char) -> Vec<&str> {
    let (mut depth, mut quoted, mut start, mut parts) = (0i32, false, 0, Vec::new());
    for (i, c) in s.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '{' | '[' | '<' | '(' if !quoted => depth += 1,
            '}' | ']' | '>' | ')' if !quoted => depth -= 1,
            c if c == sep && depth == 0 && !quoted => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts.into_iter().map(str::trim).filter(|p| !p.is_empty()).collect()
}

/// The union members of `T`'s inline declaration: an object's fields, or a literal.
fn members<T: TS + 'static>() -> Vec<Result<Fields, String>> {
    let mut ts = T::inline(&Config::new());
    while let Some(start) = ts.find("/**") {
        let end = ts[start..].find("*/").unwrap() + start + 2;
        ts.replace_range(start..end, "");
    }
    split_top(&ts, '|')
        .into_iter()
        .map(|member| match member.strip_prefix('{').and_then(|m| m.strip_suffix('}')) {
            Some(body) => Ok(split_top(body, ',')
                .into_iter()
                .map(|field| {
                    let (name, ty) = field.split_once(':').unwrap();
                    let optional = name.trim().ends_with('?');
                    let name = name.trim().trim_end_matches('?').trim_matches('"');
                    (name.to_string(), (optional, ty.trim().to_string()))
                })
                .collect()),
            None => Err(member.to_string()),
        })
        .collect()
}

fn declares(member: &Fields, json: &serde_json::Map<String, serde_json::Value>) -> bool {
    member.iter().all(|(name, (optional, ty))| match json.get(name) {
        None => *optional,
        Some(value) => !ty.starts_with('"') || ty.split('|').any(|lit| value.as_str() == Some(lit.trim().trim_matches('"'))),
    }) && json.keys().all(|k| member.contains_key(k))
}

fn assert_declared<T: TS + 'static>(json: &serde_json::Value) {
    let members = members::<T>();
    let declared = match json {
        serde_json::Value::String(s) => members.contains(&Err(format!("\"{s}\""))),
        serde_json::Value::Object(o) => members.iter().flatten().any(|m| declares(m, o)),
        other => panic!("unexpected {other}"),
    };
    assert!(declared, "{} does not declare {json}", T::name(&Config::new()));
}

fn assert_serialises_as_declared<T: TS + serde::Serialize + 'static>(values: &[T]) {
    for value in values {
        assert_declared::<T>(&serde_json::to_value(value).unwrap());
    }
}

fn assert_accepts_declared_minimum<T: TS + serde::de::DeserializeOwned + 'static>(json: serde_json::Value) {
    let Some(Ok(fields)) = members::<T>().pop() else { panic!("not an object") };
    let required: Vec<_> = fields.iter().filter(|(_, (optional, _))| !optional).map(|(k, _)| k).collect();
    let sent: Vec<_> = json.as_object().unwrap().keys().collect();
    assert_eq!(required, sent, "{} requires other fields", T::name(&Config::new()));
    serde_json::from_value::<T>(json).unwrap();
}

#[test]
fn outputs_serialise_as_declared() {
    use crate::io::*;
    let position = |frame_count| PlaybackPosition { timestamp_us: 1, frame_index: 0, frame_count };
    assert_serialises_as_declared(&[position(None), position(Some(3))]);
    assert_serialises_as_declared(&[IOState::Stopped, IOState::Running, IOState::Error("x".into())]);
    assert_serialises_as_declared(&[IOCapabilities::realtime_can()]);
    assert_serialises_as_declared(&[BusMapping::default()]);
    assert_serialises_as_declared(&[SourceConfig::default()]);
    assert_serialises_as_declared(&[Protocol::Can, Protocol::CanFd, Protocol::Modbus, Protocol::ModbusRtu, Protocol::Serial]);
    assert_serialises_as_declared(&[TemporalMode::Realtime, TemporalMode::Recorded, TemporalMode::Capture]);
    assert_serialises_as_declared(&[crate::capture_store::CaptureKind::Frames, crate::capture_store::CaptureKind::Bytes]);
    assert_serialises_as_declared(&[
        StreamEndReason::Complete,
        StreamEndReason::Disconnected,
        StreamEndReason::Error,
        StreamEndReason::Stopped,
        StreamEndReason::Paused,
    ]);
    assert_serialises_as_declared(&[LifecycleEvent::Created, LifecycleEvent::Destroyed, LifecycleEvent::Updated]);
    use session_log::SessionLogEvent as Log;
    assert_serialises_as_declared(&[
        Log::Created { mode: SessionMode::Live, subscriber_count: 1 },
        Log::State { state: IOState::Running },
        Log::Transitioned { transition: SessionTransition::SwitchedToCapture, mode: SessionMode::Replaying },
        Log::StreamEnded { reason: StreamEndReason::Paused, capture_count: None },
        Log::DeviceConnected { source_type: "gvret_tcp".into(), address: "a".into(), bus: Some(0) },
        Log::Reconfigured,
        Log::Cleared,
    ]);
    assert_serialises_as_declared(&[RegisterType::Holding, RegisterType::Input, RegisterType::Coil, RegisterType::Discrete]);
    assert_serialises_as_declared(&[modbus_tcp::PollEmitMode::Block, modbus_tcp::PollEmitMode::PerRegister]);
    use modbus_tcp::scanner::FcVerdict;
    assert_serialises_as_declared(&[
        FcVerdict::Values { values: vec![1] },
        FcVerdict::Bits { values: vec![true] },
        FcVerdict::Exception { message: "x".into() },
        FcVerdict::Silent,
    ]);
    use crate::io::framelink::rules::{BridgeDescriptor, BridgeFilterDescriptor};
    use ::framelink::protocol::bridge::{BridgeDefaultAction, BridgeFilterIde, BridgeFilterType};
    let filter = |kind, ide| BridgeFilterDescriptor { kind, ide, a: 0, b: 0 };
    let bridge = |default_action| BridgeDescriptor {
        bridge_id: 0,
        source_interface: 0,
        dest_interface: 1,
        interface_type: 0,
        source_interface_name: String::new(),
        dest_interface_name: String::new(),
        interface_type_name: String::new(),
        enabled: true,
        default_action,
        filters: vec![
            filter(BridgeFilterType::Mask, BridgeFilterIde::Any),
            filter(BridgeFilterType::Range, BridgeFilterIde::StdOnly),
            filter(BridgeFilterType::Mask, BridgeFilterIde::ExtOnly),
        ],
    };
    assert_serialises_as_declared(&[bridge(BridgeDefaultAction::Pass), bridge(BridgeDefaultAction::Block)]);
    assert_serialises_as_declared(&bridge(BridgeDefaultAction::Pass).filters);
}

#[test]
fn a_register_type_serialises_as_its_catalogue_name() {
    use crate::io::RegisterType;
    for rt in [RegisterType::Holding, RegisterType::Input, RegisterType::Coil, RegisterType::Discrete] {
        assert_eq!(serde_json::to_value(&rt).unwrap(), rt.catalog().as_str());
    }
}

fn each<'a>(json: &'a serde_json::Value, key: &str) -> impl Iterator<Item = &'a serde_json::Value> {
    json.get(key).and_then(|v| v.as_array()).into_iter().flatten()
}

#[test]
fn decoded_signals_entries_serialise_as_declared() {
    use crate::ws::decoded::*;
    use crate::ws::tunnel_signals::*;
    for line in include_str!("ws/decoded-golden.jsonl").lines() {
        let json: serde_json::Value = serde_json::from_str(line).unwrap();
        let entries = json.as_array().cloned().unwrap_or_else(|| vec![json]);
        for entry in &entries {
            if entry.get("kind").is_some() {
                assert_declared::<UnroutedFrameMsg>(entry);
                continue;
            }
            assert_declared::<DecodedFrameMsg>(entry);
            each(entry, "signals").for_each(assert_declared::<DecodedSignalValue>);
            each(entry, "selectors").for_each(assert_declared::<DecodedMuxSelector>);
            each(entry, "headerFields").for_each(assert_declared::<DecodedHeaderField>);
            each(entry, "tunnel").for_each(assert_declared::<DecodedTunnelMessage>);
            entry.get("mirror").into_iter().for_each(assert_declared::<DecodedMirrorVerdict>);
            entry.get("checksum").into_iter().for_each(assert_declared::<ChecksumVerdict>);
        }
    }
    assert_serialises_as_declared(&[UnroutedKind::Unmatched, UnroutedKind::Short]);
    assert_serialises_as_declared(&[TunnelDirection::Request, TunnelDirection::Response]);
    assert_serialises_as_declared(&[TunnelPayload::Registers, TunnelPayload::Coils, TunnelPayload::None, TunnelPayload::Opaque]);
    assert_serialises_as_declared(&[TunnelDirectionBasis::Layout, TunnelDirectionBasis::Pairing, TunnelDirectionBasis::Alternation]);
    assert_serialises_as_declared(&[TunnelProtocol::ModbusRtu]);
}

#[test]
fn ws_json_bodies_serialise_as_declared() {
    use serde_json::json;
    let session = "generated-types-adhoc";
    let signals = json!([{ "frameId": 1, "name": "byte[0]" }]);
    crate::adhoc::dispatch_adhoc_command("adhoc.set", json!({ "session_id": session, "signals": signals, "heatmaps": [1] }), 1).unwrap();
    let frame: crate::io::FrameMessage = serde_json::from_value(json!({
        "protocol": "can", "timestamp_us": 5, "frame_id": 1, "bus": 0, "dlc": 1, "bytes": [7],
    }))
    .unwrap();
    let history = crate::dashboard_history::get(session).unwrap();
    let mut history = history.lock().unwrap();
    crate::adhoc::record(session, std::slice::from_ref(&frame), None, &mut history);
    history.record_toggles(std::slice::from_ref(&frame), None);
    let [(_, payload)] = crate::adhoc::batch_messages(session, &[frame], None, Some(&history)).try_into().unwrap();
    drop(history);
    let batch: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_declared::<crate::adhoc::AdhocBatch>(&batch);
    assert!(!batch["values"].as_array().unwrap().is_empty() && !batch["toggles"].as_array().unwrap().is_empty());
    let query = |op: &str| {
        crate::dashboard_history::dispatch(op, json!({ "session_id": session, "signals": signals, "bins": 4 })).unwrap()
    };
    query("dashboard.series").as_array().unwrap().iter().for_each(assert_declared::<crate::dashboard_history::SeriesWindow>);
    assert_declared::<crate::dashboard_history::AlignedSeries>(&query("dashboard.aligned"));
    crate::adhoc::forget_session(session);

    use crate::io::modbus_tcp::scanner::ModbusScanState;
    let state = |capture_id: Option<&str>| ModbusScanState {
        status: "running".into(),
        progress: None,
        device_info: vec![],
        notes: vec!["x".into()],
        capture_id: capture_id.map(Into::into),
    };
    assert_serialises_as_declared(&[state(None), state(Some("c"))]);
    assert_serialises_as_declared(&[crate::ws::dispatch::AttachToPanelMsg { panel: "decoder", session_id: "s" }]);
}

#[test]
fn inputs_accept_the_declared_minimum() {
    use crate::io::modbus_tcp::scanner::{FcProbeConfig, ModbusScanConfig, UnitIdScanConfig};
    use serde_json::json;
    assert_accepts_declared_minimum::<crate::sessions::MultiSourceInput>(json!({ "profile_id": "p" }));
    assert_accepts_declared_minimum::<crate::io::ModbusRangeSpec>(json!({ "ranges": [] }));
    assert_accepts_declared_minimum::<crate::analysis::OrderStart>(json!({ "frameId": 1, "isExtended": false }));
    assert_accepts_declared_minimum::<crate::io::ModbusRange>(json!({ "end": 2, "register_type": "holding", "start": 1 }));
    assert_accepts_declared_minimum::<FcProbeConfig>(json!({}));
    assert_accepts_declared_minimum::<ModbusScanConfig>(json!({
        "chunk_size": 10, "end_register": 9, "inter_request_delay_ms": 0,
        "register_type": "input", "start_register": 0, "unit_id": 1,
    }));
    assert_accepts_declared_minimum::<UnitIdScanConfig>(json!({
        "end_unit_id": 2, "inter_request_delay_ms": 0, "register_type": "coil",
        "start_unit_id": 1, "test_register": 0,
    }));
}

#[test]
fn analysis_results_serialise_as_declared() {
    use crate::analysis_ts as ts;
    use wiretap_analysis::order::BurstFlag;
    use wiretap_analysis::*;

    let frame = |bus, id, ms: u64, payload: &[u8]| TimedFrame {
        bus,
        key: FrameKey::new(id, false),
        timestamp_us: ms * 1000,
        payload: payload.to_vec(),
    };
    let mut frames = Vec::new();
    for i in 0..12u8 {
        let t = i as u64 * 100;
        frames.push(frame(0, 0x10, t, &[i]));
        frames.push(frame(0, 0x11, t + 10, &[i]));
        frames.push(frame(0, 0x20, t + 20, &[i % 4, i]));
        frames.push(frame(0, 0x20, t + 70, &[(i + 2) % 4, i]));
        frames.push(frame(1, 0x10, t + 30, &[i]));
        if i % 2 == 0 {
            for (n, len) in [1usize, 2, 1].into_iter().enumerate() {
                frames.push(frame(0, 0x30, t + 40 + n as u64 * 2, &vec![0x80; len]));
            }
        }
    }
    frames.sort_by_key(|f| f.timestamp_us);
    let order = serde_json::to_value(analyse_order(&frames, None)).unwrap();
    assert_declared::<ts::OrderAnalysis>(&order);
    let bus = &order["buses"][0];
    assert_declared::<ts::BusOrder>(bus);
    for (key, check) in [
        ("patterns", assert_declared::<ts::CyclePattern> as fn(&serde_json::Value)),
        ("intervalGroups", assert_declared::<ts::IntervalGroup>),
        ("startCandidates", assert_declared::<ts::StartCandidate>),
        ("mux", assert_declared::<ts::MuxTiming>),
        ("bursts", assert_declared::<ts::BurstTiming>),
    ] {
        assert!(each(bus, key).next().is_some(), "no {key} to check");
        each(bus, key).for_each(check);
    }
    each(bus, "patterns").for_each(|p| assert_declared::<ts::FrameKey>(&p["start"]));
    each(bus, "mux").for_each(|m| assert_declared::<ts::MuxSelector>(&m["selector"]));
    assert!(each(&order, "multiBus").next().is_some());
    each(&order, "multiBus").for_each(assert_declared::<ts::MultiBusFrame>);
    for flag in [BurstFlag::VariableLength, BurstFlag::BurstPattern, BurstFlag::RequestResponse] {
        assert_declared::<ts::BurstFlag>(&serde_json::to_value(flag).unwrap());
    }

    let stream = |offset: u64| -> Vec<TimedPayload> {
        (0..5u8).map(|i| TimedPayload { timestamp_us: i as u64 * 100_000 + offset, payload: vec![i] }).collect()
    };
    let streams = BTreeMap::from([(FrameKey::new(1, false), stream(0)), (FrameKey::new(2, true), stream(1000))]);
    let groups = mirror_groups(&streams, DEFAULT_MIRROR_WINDOW_US);
    assert_eq!(groups.len(), 1);
    assert_declared::<ts::MirrorGroup>(&serde_json::to_value(&groups[0]).unwrap());

    let pattern = MultiBytePattern {
        start: 1,
        len: 2,
        kind: PatternKind::Sensor16,
        endianness: Some(Endianness::Big),
        rollover: false,
        correlated_rollover: true,
        slow_upper_bytes: false,
        range: Some((3, 900)),
        sample_text: None,
    };
    let notes = ByteNotes {
        frame: vec![
            ByteNote::NoSamples,
            ByteNote::Endianness { endianness: Endianness::Mixed, pattern_count: 2 },
            ByteNote::VaryingLength { min: 1, max: 8 },
            ByteNote::Burst { mux: true },
            ByteNote::Identical { sample_count: 3, payload: vec![1] },
            ByteNote::Multiplexed { selector: MuxSelector::TwoByte, cases: vec![1, 258] },
            ByteNote::CaseSummary { value: 1, counters: 1, statics: 0 },
            ByteNote::Statics { bytes: vec![StaticByte { position: 0, value: 0x1F }] },
            ByteNote::Counter {
                position: 1,
                direction: Direction::Down,
                step: 2,
                rollover: true,
                looping: Some(Loop { min: 0, max: 9, modulo: 10 }),
            },
            ByteNote::Sensor { position: 2, trend: Trend::Increasing, strength: 0.5, min: 0, max: 15 },
            ByteNote::Pattern(pattern),
            ByteNote::VaryingValues { count: 2 },
        ],
        cases: vec![MuxCaseNotes { value: 1, notes: vec![] }],
    };
    let json = serde_json::to_value(&notes).unwrap();
    assert_declared::<ts::ByteNotes>(&json);
    each(&json, "cases").for_each(assert_declared::<ts::MuxCaseNotes>);
    for note in each(&json, "frame") {
        let mut note = note.clone();
        if note["code"] == "pattern" {
            note.as_object_mut().unwrap().remove("code");
            assert_declared::<ts::MultiBytePattern>(&note);
        } else {
            assert_declared::<ts::ByteNote>(&note);
        }
    }
}

#[tokio::test]
async fn drafts_serialise_as_declared() {
    use crate::analysis::memory::MemorySource;
    use crate::analysis_ts as ts;

    let mut source = MemorySource::default();
    for i in 0..30u8 {
        let t = i as u64 * 100_000;
        source.push_at("can", 0, 0x100, false, t, vec![i % 3, i, 0x5A, ((i as u16 * 300) >> 8) as u8]);
        source.push_at("can", 1, 0x100, false, t + 5_000, vec![i % 3, i, 0x5A, 0]);
        source.push_at("can", 0, 0x200, false, t + 1_000, vec![0x80, 0x11]);
        source.push_at("can", 0, 0x200, false, t + 3_000, vec![0x80, 0x22, 0x33]);
    }
    let changes = crate::byte_roles::payload_changes(&source, vec![], None, usize::MAX).await.unwrap();
    let mut draft = wiretap_analysis::draft::Draft::default();
    crate::drafting::apply_changes(&mut draft, &changes);
    let orders = crate::analysis::message_order(&source, &crate::capture_store::FrameSelection::default(), None, None)
        .await
        .unwrap();
    draft.apply_orders(orders.iter().map(|o| (wiretap_catalog::model::Protocol::Can, &o.order)));
    draft.serial_reserved.push(wiretap_analysis::draft::ByteSpan { start: -1, len: 1 });
    let preview = crate::drafting::draft_preview_cmd(Some(draft), Vec::new());

    let json = serde_json::to_value(&preview).unwrap();
    assert_declared::<ts::Draft>(&json["draft"]);
    each(&json["draft"], "serialReserved").for_each(assert_declared::<ts::ByteSpan>);
    let frames: Vec<_> = each(&json["draft"], "frames").collect();
    frames.iter().for_each(|f| assert_declared::<ts::FrameDraft>(f));
    assert!(frames.iter().any(|f| f["mux"].is_object()), "no mux to check");
    assert!(frames.iter().any(|f| f["burst"].is_object()), "no burst to check");
    for f in &frames {
        if let Some(mux) = f["mux"].as_object() {
            assert_declared::<ts::MuxDraft>(&serde_json::Value::Object(mux.clone()));
            mux["cases"].as_object().unwrap().values().for_each(assert_declared::<ts::MuxCaseDraft>);
        }
        if f["burst"].is_object() {
            assert_declared::<ts::BurstDraft>(&f["burst"]);
        }
    }
    for signal in json["signals"].as_array().unwrap().iter().flat_map(|s| s.as_array().unwrap()) {
        assert_declared::<ts::DraftSignal>(signal);
    }
    let candidates = crate::drafting::candidate_signals_cmd(0, 1, vec![8, 16], vec![wiretap_decode::Endianness::Big], None);
    assert_declared::<ts::CandidateSignal>(&serde_json::to_value(&candidates[0]).unwrap());
}

/// The lib's byte notes for each `byteNotes.json` profile, the codes the
/// frontend's note renderer is tested against.
#[test]
fn byte_note_codes_fixture_is_the_libs_answer() {
    use serde_json::Value;
    use wiretap_analysis::*;
    use wiretap_checksum::columns::ColumnStats;

    fn n(v: &Value) -> usize {
        v.as_u64().unwrap() as usize
    }
    fn list<T>(v: &Value, f: impl Fn(&Value) -> T) -> Vec<T> {
        v.as_array().map_or(vec![], |a| a.iter().map(f).collect())
    }
    fn endianness(v: &Value) -> Option<Endianness> {
        v.as_str().map(|s| match s {
            "little" => Endianness::Little,
            "big" => Endianness::Big,
            _ => Endianness::Mixed,
        })
    }
    fn column(c: &Value) -> ByteColumn {
        let role = match c["role"].as_str().unwrap() {
            "static" => ByteRole::Static { value: n(&c["value"]) as u8 },
            "counter" => ByteRole::Counter {
                direction: if c["direction"] == "up" { Direction::Up } else { Direction::Down },
                step: n(&c["step"]) as u8,
                rollover: c["rollover"].as_bool().unwrap(),
                looping: c["looping"].as_object().map(|l| Loop {
                    min: n(&l["min"]) as u8,
                    max: n(&l["max"]) as u8,
                    modulo: n(&l["modulo"]) as u16,
                }),
            },
            "sensor" => ByteRole::Sensor {
                trend: match c["trend"].as_str().unwrap() {
                    "increasing" => Trend::Increasing,
                    "decreasing" => Trend::Decreasing,
                    _ => Trend::Mixed,
                },
                strength: c["strength"].as_f64().unwrap(),
                rollover: c["rollover"].as_bool().unwrap(),
            },
            "value" => ByteRole::Value,
            _ => ByteRole::Unknown,
        };
        let stats = ColumnStats {
            position: c["position"].as_i64().unwrap() as i32,
            distinct_values: n(&c["distinctValues"]),
            min: n(&c["min"]) as u8,
            max: n(&c["max"]) as u8,
            constant_value: c["constantValue"].as_u64().map(|v| v as u8),
            changes: n(&c["changes"]),
            transitions: n(&c["transitions"]),
            entropy_bits: c["entropyBits"].as_f64().unwrap(),
            sample_count: n(&c["sampleCount"]),
        };
        ByteColumn { stats, role }
    }
    fn pattern(p: &Value) -> MultiBytePattern {
        MultiBytePattern {
            start: n(&p["start"]),
            len: n(&p["len"]),
            kind: match p["kind"].as_str().unwrap() {
                "counter16" => PatternKind::Counter16,
                "sensor16" => PatternKind::Sensor16,
                "sensor32" => PatternKind::Sensor32,
                _ => PatternKind::Text,
            },
            endianness: endianness(&p["endianness"]),
            rollover: p["rollover"].as_bool().unwrap(),
            correlated_rollover: p["correlatedRollover"].as_bool().unwrap(),
            slow_upper_bytes: p["slowUpperBytes"].as_bool().unwrap(),
            range: p["range"].as_array().map(|r| (n(&r[0]) as u32, n(&r[1]) as u32)),
            sample_text: p["sampleText"].as_str().map(String::from),
        }
    }
    fn profile(p: &Value) -> ByteProfile {
        let mux = &p["mux"];
        ByteProfile {
            sample_count: n(&p["sampleCount"]),
            min_len: n(&p["minLen"]),
            max_len: n(&p["maxLen"]),
            identical: p["identical"].as_array().map(|b| b.iter().map(|b| n(b) as u8).collect()),
            analysed_from: n(&p["analysedFrom"]),
            columns: list(&p["columns"], column),
            patterns: list(&p["patterns"], pattern),
            endianness: endianness(&p["endianness"]),
            mux: mux.as_object().map(|_| MuxAnalysis {
                detection: MuxDetection {
                    selector: if mux["detection"]["selector"] == "twoByte" {
                        MuxSelector::TwoByte
                    } else {
                        MuxSelector::OneByte
                    },
                    occurrences: mux["detection"]["occurrences"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, v)| (k.parse().unwrap(), n(v)))
                        .collect(),
                },
                cases: list(&mux["cases"], |c| MuxCase {
                    value: n(&c["value"]) as u16,
                    sample_count: n(&c["sampleCount"]),
                    columns: list(&c["columns"], column),
                    patterns: list(&c["patterns"], pattern),
                }),
            }),
        }
    }

    let dir = out_dir().join("../tests/fixtures/analysis");
    let fixture: Value = serde_json::from_str(&fs::read_to_string(dir.join("byteNotes.json")).unwrap()).unwrap();
    let codes: BTreeMap<String, ByteNotes> = list(&fixture["cases"], |c| {
        let input = &c["input"];
        (
            c["name"].as_str().unwrap().to_string(),
            byte_notes(&profile(&input["profile"]), input["isBurstFrame"].as_bool().unwrap()),
        )
    })
    .into_iter()
    .collect();
    let want = format!("{}\n", serde_json::to_string_pretty(&codes).unwrap());
    let path = dir.join("byteNoteCodes.json");
    if fs::read_to_string(&path).ok().as_deref() == Some(want.as_str()) {
        return;
    }
    fs::write(&path, want).unwrap();
    assert!(
        std::env::var_os("WIRETAP_GEN_TYPES").is_some(),
        "byteNoteCodes.json was stale and has been rewritten; commit it"
    );
}

#[test]
fn query_shapes_serialise_as_declared() {
    use crate::query::tests::{fixture, form_specs, results_named};
    use crate::query::{queue::*, ts, QueryOutcome, QueryRequest};

    for (_, spec) in form_specs() {
        assert_declared::<ts::QuerySpec>(&serde_json::to_value(&spec).unwrap());
    }
    let stats = wiretap_gateway::QueryStats { rows_scanned: 1, results_count: 1, execution_time_ms: 0 };
    assert_declared::<ts::QueryStats>(&serde_json::to_value(&stats).unwrap());
    for case in fixture("queryCsv.json")["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let results = results_named(name, case["input"].clone());
        let json = serde_json::to_value(&results).unwrap();
        for row in json.as_array().cloned().unwrap_or_else(|| vec![json.clone()]).iter() {
            match name {
                "byte_changes" => assert_declared::<ts::ByteChangeResult>(row),
                "frame_changes" => assert_declared::<ts::FrameChangeResult>(row),
                "mirror_validation" => assert_declared::<ts::MirrorValidationResult>(row),
                "mux_statistics" => {
                    assert_declared::<ts::MuxStatisticsResult>(row);
                    for c in each(row, "cases") {
                        assert_declared::<ts::MuxCaseStats>(c);
                        each(c, "byte_stats").for_each(assert_declared::<ts::BytePositionStats>);
                        each(c, "word16_stats").for_each(assert_declared::<ts::Word16Stats>);
                    }
                }
                "first_last" => assert_declared::<ts::FirstLastResult>(row),
                "frequency" => assert_declared::<ts::FrequencyBucket>(row),
                "distribution" => assert_declared::<ts::DistributionResult>(row),
                "gap_analysis" => assert_declared::<ts::GapResult>(row),
                "pattern_search" => assert_declared::<ts::PatternSearchResult>(row),
                _ => assert_declared::<crate::capture_db::InventoryRow>(row),
            }
        }
        assert_serialises_as_declared(&[QueryOutcome { results, stats: Some(stats.clone()), sql: vec!["SELECT 1".into()] }]);
    }
    let (_, spec) = form_specs().remove(0);
    let request = QueryRequest {
        source: crate::payload_source::QuerySource::Capture("c".into()),
        spec,
        catalog_path: Some("x.toml".into()),
    };
    assert_serialises_as_declared(std::slice::from_ref(&request));
    let item = QueryItem {
        id: "q".into(),
        label: "Byte Changes".into(),
        request,
        status: QueryStatus::Completed,
        submitted_at_ms: 1,
        started_at_ms: Some(2),
        completed_at_ms: None,
        error: None,
        result_count: Some(3),
        stats: None,
    };
    assert_serialises_as_declared(&[QueryQueue { revision: 1, items: vec![item] }]);
    assert_serialises_as_declared(&[QueryStatus::Pending, QueryStatus::Running, QueryStatus::Error]);
}
