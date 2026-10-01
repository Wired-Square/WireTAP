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
        files: BTreeMap::new(),
    };
    r.visit::<crate::io::GvretDeviceInfo>();
    r.visit::<crate::io::ActiveSessionInfo>();
    r.visit::<crate::io::AppInstanceInfo>();
    r.visit::<crate::io::CanTransmitFrame>();
    r.visit::<crate::io::ModbusRangeSpec>();
    r.visit::<crate::io::PlaybackPosition>();
    r.visit::<crate::io::RegisterSubscriberResult>();
    r.visit::<crate::io::ReinitializeResult>();
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
    r.visit::<crate::sessions::ProfileUsageInfo>();
    r.files.into_iter().map(|(path, (_, text))| (path, text)).collect()
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
        Some(value) => !ty.starts_with('"') || value.as_str() == Some(ty.trim_matches('"')),
    }) && json.keys().all(|k| member.contains_key(k))
}

fn assert_serialises_as_declared<T: TS + serde::Serialize + 'static>(values: &[T]) {
    let members = members::<T>();
    for value in values {
        let json = serde_json::to_value(value).unwrap();
        let declared = match &json {
            serde_json::Value::String(s) => members.contains(&Err(format!("\"{s}\""))),
            serde_json::Value::Object(o) => members.iter().flatten().any(|m| declares(m, o)),
            other => panic!("unexpected {other}"),
        };
        assert!(declared, "{} does not declare {json}", T::name(&Config::new()));
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
    assert_serialises_as_declared(&[RegisterType::Holding, RegisterType::Input, RegisterType::Coil, RegisterType::Discrete]);
    assert_serialises_as_declared(&[modbus_tcp::PollEmitMode::Block, modbus_tcp::PollEmitMode::PerRegister]);
    use modbus_tcp::scanner::FcVerdict;
    assert_serialises_as_declared(&[
        FcVerdict::Values { values: vec![1] },
        FcVerdict::Bits { values: vec![true] },
        FcVerdict::Exception { message: "x".into() },
        FcVerdict::Silent,
    ]);
}

#[test]
fn inputs_accept_the_declared_minimum() {
    use crate::io::modbus_tcp::scanner::{FcProbeConfig, ModbusScanConfig, UnitIdScanConfig};
    use serde_json::json;
    assert_accepts_declared_minimum::<crate::sessions::MultiSourceInput>(json!({ "bus_mappings": [], "profile_id": "p" }));
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
