// crates/wiretap-app/src/report/goldens.rs
//
// Each report in each format, pinned under the frontend's catalogue fixtures.
// `WRITE_REPORT_GOLDENS=1` rewrites them.

use super::ReportFormat;
use crate::analysis::memory::MemorySource;
use crate::analysis::message_order;
use crate::byte_roles::payload_changes;
use crate::capture_store::FrameSelection;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/tests/fixtures");

const FORMATS: [(ReportFormat, &str); 3] =
    [(ReportFormat::Text, "txt"), (ReportFormat::Markdown, "md"), (ReportFormat::Html, "html")];

fn assert_golden(name: &str, rendered: &str) {
    let path = format!("{FIXTURES}/catalog/{name}");
    if std::env::var_os("WRITE_REPORT_GOLDENS").is_some() {
        std::fs::write(&path, rendered).unwrap();
        return;
    }
    let golden = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(golden == rendered, "{name} differs from its golden; WRITE_REPORT_GOLDENS=1 rewrites it");
}

#[test]
fn catalogue_reports_match_their_goldens() {
    for (fixture, stem) in [
        ("sbrxxx.toml", "sbrxxx"),
        ("catalog/report-edges.toml", "report-edges"),
        ("catalog/report-legacy.toml", "report-legacy"),
        ("catalog/modbus.toml", "modbus"),
        ("catalog/serial.toml", "serial"),
    ] {
        let text = std::fs::read_to_string(format!("{FIXTURES}/{fixture}")).unwrap();
        for (format, ext) in FORMATS {
            let rendered = super::catalog::render(&text, format).unwrap();
            assert_golden(&format!("catalogReport.{stem}.{ext}"), &rendered);
        }
    }
}

/// A CAN counter and sensor with a mirror, an extended mux, a burst seen on two
/// buses, a serial frame and a Modbus register.
fn capture() -> MemorySource {
    let mut source = MemorySource::default();
    for i in 0..40u8 {
        let t = i as u64 * 100_000;
        let sensor = (1000 + i as u16 * 7).to_le_bytes();
        source.push_at("can", 0, 0x100, false, t, vec![i, 0x5A, sensor[0], sensor[1]]);
        source.push_at("can", 0, 0x200, false, t + 1_000, vec![i, 0x5A, sensor[0], sensor[1]]);
        for (n, case) in [1u8, 2, 3].into_iter().enumerate() {
            let t = t + 10_000 * (n as u64 + 1);
            source.push_at("can", 0, 0x18FF_0001, true, t, vec![case, case * 16, i, 0]);
        }
        source.push_at("can", 1, 0x300, false, t + 50_000, vec![0x80 + i % 4, 0x11]);
        source.push_at("can", 1, 0x300, false, t + 52_000, vec![0x80 + i % 4, 0x22, 0x33]);
        if i % 10 == 0 {
            source.push_at("can", 0, 0x300, false, t + 60_000, vec![0x80, 0x11]);
        }
        source.push_at("serial", 0, 0x10, false, t + 70_000, vec![0xAA, i, 0x00]);
        source.push_at("modbus", 0, 40001, false, t + 80_000, (200 + i as u16).to_be_bytes().to_vec());
    }
    source
}

#[tokio::test]
async fn analysis_reports_match_their_goldens() {
    let source = capture();
    let changes = payload_changes(&source, vec![], None, usize::MAX).await.unwrap();
    let orders = message_order(&source, &FrameSelection::default(), None, None).await.unwrap();
    for (format, ext) in FORMATS {
        assert_golden(&format!("payloadChanges.{ext}"), &super::changes::report(&changes).render(format));
        assert_golden(&format!("frameOrder.{ext}"), &super::order::report(&orders).render(format));
    }
}
