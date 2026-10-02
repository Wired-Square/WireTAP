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
        files: BTreeMap::from([(
            PathBuf::from("wireConstants.ts"),
            (TypeId::of::<crate::ws::protocol::MsgType>(), wire_constants()),
        )]),
    };
    r.visit::<crate::io::GvretDeviceInfo>();
    r.visit::<crate::io::ActiveSessionInfo>();
    r.visit::<crate::io::AppInstanceInfo>();
    r.visit::<crate::io::CanTransmitFrame>();
    r.visit::<crate::io::ModbusRangeSpec>();
    r.visit::<crate::io::PlaybackPosition>();
    r.visit::<crate::io::RegisterSubscriberResult>();
    r.visit::<crate::io::ReinitializeResult>();
    r.visit::<crate::io::SessionLifecyclePayload>();
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
    r.visit::<crate::capture_store::TailResponse>();
    r.visit::<crate::io::CsvColumnMapping>();
    r.visit::<crate::io::CsvPreview>();
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
    r.visit::<crate::replay::ReplayFrame>();
    r.visit::<crate::transmit::RepeatStartedEvent>();
    r.visit::<crate::transmit::RepeatStoppedEvent>();
    r.visit::<crate::transmit::SerialFraming>();
    r.visit::<crate::transmit::TransmitProfile>();
    r.visit::<crate::io::framelink::FrameLinkProbeResult>();
    r.visit::<crate::io::framelink::SignalReadResult>();
    r.visit::<crate::io::framelink::rules::BridgeDescriptor>();
    r.visit::<crate::io::framelink::rules::DeviceSignalDescriptor>();
    r.visit::<crate::io::framelink::rules::FrameDefDescriptor>();
    r.visit::<crate::io::framelink::rules::GeneratorDescriptor>();
    r.visit::<crate::io::framelink::rules::TransformerDescriptor>();
    r.visit::<crate::io_test::IOTestState>();
    r.visit::<crate::io_test::TestConfig>();
    r.visit::<crate::flashers::DetectedChip>();
    r.visit::<crate::flashers::EspFlashOptions>();
    r.visit::<crate::flashers::FlasherProgress>();
    r.visit::<crate::flashers::Stm32FlashOptions>();
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
        table("FrameType", FrameType::VARIANTS.iter().map(|(k, v)| (*k, *v as u16)), 4),
        table("IdFlags", ID_FLAGS.iter().copied(), 8),
        table("StreamEndedFlags", STREAM_ENDED_FLAGS.iter().copied(), 2),
        names("SESSION_STATES", &SESSION_STATES),
        names("STREAM_END_REASONS", &STREAM_END_REASONS),
        names("SESSION_ERROR_SEVERITIES", &SESSION_ERROR_SEVERITIES),
        names("SESSION_TRANSITIONS", &SESSION_TRANSITIONS),
        format!(
            "export const MODBUS_SCAN_SOURCE_TYPE = {:?};\n",
            crate::io::modbus_tcp::scan_source::MODBUS_SCAN_SOURCE_TYPE
        ),
    ]
    .join("\n")
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
    let [(_, payload)] = crate::adhoc::batch_messages(session, &[frame], None).try_into().unwrap();
    crate::adhoc::forget_session(session);
    let batch: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    assert_declared::<crate::adhoc::AdhocBatch>(&batch);
    assert!(!batch["values"].as_array().unwrap().is_empty() && !batch["toggles"].as_array().unwrap().is_empty());

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
