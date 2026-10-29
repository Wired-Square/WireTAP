// Discovery's exports: frames as CSV and candump through `wslib_can`'s
// writers, and as JSON; a byte capture as a hex dump, a CSV or raw binary.

use std::fmt::Write;

use serde::{Deserialize, Serialize};
use wslib_wiretap_protocol::format_frame_id;
use wslib_can::{CanFrame, Direction};
use wslib_can::{candump, savvycan};

use crate::capture_store::{self, TimestampedByte};
use crate::io::FrameMessage;

const REPORTED_REFUSALS: usize = 5;

/// A capture Rust reads itself, or the frames the frontend holds when nothing
/// has written them to one.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum FrameSource {
    Capture { capture_id: String },
    Frames { frames: Vec<FrameMessage> },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DumpFormat {
    Csv,
    Candump,
    Json,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ByteDumpFormat {
    Hex,
    Csv,
    Bin,
}

const HEX_DUMP_LINE_BYTES: usize = 16;
const HEX_DUMP_LINE_GAP_US: u64 = 1_000;

/// Write the frames to `path`, or refuse the whole export if any frame cannot
/// be written as it is. Returns the frame count.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_frame_dump(
    source: FrameSource,
    format: DumpFormat,
    path: String,
) -> Result<usize, String> {
    crate::blocking::off_runtime(move || {
        let frames = match source {
            FrameSource::Capture { capture_id } => crate::capture_db::wait(capture_store::get_capture_frames(&capture_id))?
                .ok_or_else(|| format!("'{capture_id}' is not a frame capture"))?,
            FrameSource::Frames { frames } => frames,
        };
        let text = encode(&frames, format)?;
        std::fs::write(&path, text).map_err(|e| format!("Failed to write '{path}': {e}"))?;
        Ok(frames.len())
    })
    .await
}

/// Write a byte capture to `path`. Returns the byte count.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_byte_dump(
    capture_id: String,
    format: ByteDumpFormat,
    path: String,
) -> Result<usize, String> {
    crate::blocking::off_runtime(move || {
        let bytes = crate::capture_db::wait(capture_store::get_capture_bytes(&capture_id))?
            .ok_or_else(|| format!("'{capture_id}' is not a byte capture"))?;
        std::fs::write(&path, encode_bytes(&bytes, format))
            .map_err(|e| format!("Failed to write '{path}': {e}"))?;
        Ok(bytes.len())
    })
    .await
}

pub fn encode(frames: &[FrameMessage], format: DumpFormat) -> Result<String, String> {
    let mut out = String::new();
    let mut refusals = Vec::new();
    match format {
        DumpFormat::Json => out = json(frames),
        DumpFormat::Csv => {
            let columns =
                savvycan::data_columns(frames.iter().map(|f| payload(f).len()).max().unwrap_or(0));
            savvycan::encode_header_into(&mut out, columns);
            out.push('\n');
            for (i, f) in frames.iter().enumerate() {
                if f.protocol == "can" {
                    if let Err(why) = can_frame(f) {
                        refusals.push((i, why));
                        continue;
                    }
                }
                savvycan::encode_row_into(&mut out, &row(f), columns);
                out.push('\n');
            }
        }
        DumpFormat::Candump => {
            for (i, f) in frames.iter().enumerate() {
                match can_frame(f) {
                    Ok(frame) => {
                        let direction = is_tx(f).then_some(Direction::Tx);
                        candump::encode_line_into(
                            &mut out,
                            f.timestamp_us,
                            &format!("can{}", f.bus),
                            &frame,
                            direction,
                        );
                        out.push('\n');
                    }
                    Err(why) => refusals.push((i, why)),
                }
            }
        }
    }
    if refusals.is_empty() {
        Ok(out)
    } else {
        Err(refused(&refusals))
    }
}

#[derive(Serialize)]
struct JsonFrame<'a> {
    timestamp_us: u64,
    frame_id: u32,
    frame_id_hex: String,
    bus: u8,
    dlc: u16,
    is_extended: bool,
    is_fd: bool,
    bytes: &'a [u8],
    bytes_hex: Vec<String>,
}

fn json(frames: &[FrameMessage]) -> String {
    let rows: Vec<_> = frames
        .iter()
        .map(|f| JsonFrame {
            timestamp_us: f.timestamp_us,
            frame_id: f.frame_id,
            frame_id_hex: format_frame_id(f.frame_id, f.is_extended),
            bus: f.bus,
            dlc: f.dlc,
            is_extended: f.is_extended,
            is_fd: f.is_fd,
            bytes: &f.bytes,
            bytes_hex: f.bytes.iter().map(|b| format!("{b:02X}")).collect(),
        })
        .collect();
    serde_json::to_string_pretty(&rows).expect("frames serialise")
}

pub fn encode_bytes(bytes: &[TimestampedByte], format: ByteDumpFormat) -> Vec<u8> {
    match format {
        ByteDumpFormat::Bin => bytes.iter().map(|b| b.byte).collect(),
        ByteDumpFormat::Csv => {
            let mut out = String::from("timestamp_us,byte_hex,byte_dec\n");
            for b in bytes {
                let _ = writeln!(out, "{},{:02X},{}", b.timestamp_us, b.byte, b.byte);
            }
            out.into_bytes()
        }
        ByteDumpFormat::Hex => hex_dump(bytes).into_bytes(),
    }
}

/// One line per 16 bytes, or sooner where a byte comes more than a millisecond
/// after its line's first: `timestamp_us: XX XX ..  |ascii|`.
fn hex_dump(bytes: &[TimestampedByte]) -> String {
    let mut lines = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    let mut start = 0;
    for b in bytes {
        if line.len() >= HEX_DUMP_LINE_BYTES
            || (!line.is_empty() && b.timestamp_us.saturating_sub(start) > HEX_DUMP_LINE_GAP_US)
        {
            lines.push(hex_dump_line(start, &line));
            line.clear();
        }
        if line.is_empty() {
            start = b.timestamp_us;
        }
        line.push(b.byte);
    }
    if !line.is_empty() {
        lines.push(hex_dump_line(start, &line));
    }
    lines.join("\n")
}

fn hex_dump_line(start: u64, line: &[u8]) -> String {
    let hex = line
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    let ascii: String = line
        .iter()
        .map(|&b| {
            if (32..127).contains(&b) {
                b as char
            } else {
                '.'
            }
        })
        .collect();
    format!("{start}: {hex:<48}  |{ascii}|")
}

fn payload(f: &FrameMessage) -> &[u8] {
    &f.bytes[..f.bytes.len().min(f.dlc as usize)]
}

fn is_tx(f: &FrameMessage) -> bool {
    f.direction.as_deref() == Some("tx")
}

fn can_frame(f: &FrameMessage) -> Result<CanFrame, String> {
    if f.protocol != "can" {
        return Err(format!("a {} frame is not a CAN frame", f.protocol));
    }
    let (max_id, id_kind) = if f.is_extended {
        (0x1FFF_FFFF, "29-bit")
    } else {
        (0x7FF, "11-bit")
    };
    if f.frame_id > max_id {
        return Err(format!("{:#X} is past the {id_kind} id range", f.frame_id));
    }
    if f.is_rtr {
        return match u8::try_from(f.dlc) {
            Ok(dlc @ 0..=8) => Ok(CanFrame::remote(f.bus, f.frame_id, f.is_extended, dlc)),
            _ => Err(format!("a remote frame asks for at most 8 bytes, not {}", f.dlc)),
        };
    }
    let data = payload(f);
    let (max_len, kind) = if f.is_fd {
        (64, "a CAN FD")
    } else {
        (8, "a classic CAN")
    };
    if data.len() > max_len {
        return Err(format!(
            "{} bytes is more than {kind} frame carries",
            data.len()
        ));
    }
    let mut frame = CanFrame::data(
        f.bus,
        f.frame_id,
        f.is_extended,
        f.is_fd,
        f.is_brs,
        data.to_vec(),
    );
    frame.esi = f.is_esi;
    Ok(frame)
}

fn row(f: &FrameMessage) -> savvycan::Row {
    savvycan::Row {
        ts_us: f.timestamp_us,
        arb_id: f.frame_id,
        extended: f.is_extended,
        direction: if is_tx(f) {
            Direction::Tx
        } else {
            Direction::Rx
        },
        bus: f.bus,
        data: payload(f).to_vec(),
    }
}

fn refused(refusals: &[(usize, String)]) -> String {
    let mut text = refusals
        .iter()
        .take(REPORTED_REFUSALS)
        .map(|(i, why)| format!("frame {}: {why}", i + 1))
        .collect::<Vec<_>>()
        .join("; ");
    if refusals.len() > REPORTED_REFUSALS {
        text.push_str(&format!(
            " (and {} more)",
            refusals.len() - REPORTED_REFUSALS
        ));
    }
    format!("Nothing was written: {text}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::{
        parse_candump_files, parse_csv_with_mapping, preview_csv_file, Delimiter, Protocol,
        TimestampUnit,
    };

    const FIXTURES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../frontend/wiretap-ui/src/tests/fixtures/frame-dump"
    );

    fn fixture(file: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}/{file}")).expect("fixture")
    }

    fn frames(name: &str) -> Vec<FrameMessage> {
        serde_json::from_str(&fixture(&format!("{name}.json"))).unwrap()
    }

    fn temp_file(name: &str, body: &str) -> String {
        let dir = std::env::temp_dir().join(format!("wiretap-frame-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn can(frame_id: u32, is_extended: bool, is_fd: bool, len: usize) -> FrameMessage {
        FrameMessage {
            protocol: "can".into(),
            timestamp_us: 1,
            frame_id,
            bus: 0,
            dlc: len as u16,
            bytes: vec![0; len],
            is_extended,
            is_fd,
            source_address: None,
            incomplete: None,
            direction: None,
            ..Default::default()
        }
    }

    type Carried = (u64, u32, u8, Vec<u8>, bool, bool, Option<String>);

    /// What the formats carry. A received frame has no direction, as live.
    fn carried(f: &FrameMessage) -> Carried {
        let direction = f.direction.clone().filter(|d| d == "tx");
        (
            f.timestamp_us,
            f.frame_id,
            f.bus,
            payload(f).to_vec(),
            f.is_extended,
            f.is_fd,
            direction,
        )
    }

    #[test]
    fn the_csv_is_what_the_typescript_writer_wrote() {
        for name in ["can", "serial"] {
            assert_eq!(
                encode(&frames(name), DumpFormat::Csv).unwrap(),
                fixture(&format!("{name}.ts.csv")),
                "{name}"
            );
        }
    }

    #[test]
    fn the_csv_rounds_its_data_columns_up_to_a_length_code_and_past_64_keeps_every_byte() {
        let header = |len| encode(&[can(1, false, true, len)], DumpFormat::Csv).unwrap();
        assert!(header(9).lines().next().unwrap().ends_with(",D12"));
        let mut serial = can(1, false, false, 100);
        serial.protocol = "serial".into();
        let csv = encode(&[serial], DumpFormat::Csv).unwrap();
        assert!(csv.lines().next().unwrap().ends_with(",D100"));
    }

    #[test]
    fn a_candump_export_imports_back_as_the_same_frames() {
        let exported = frames("can");
        let log = encode(&exported, DumpFormat::Candump).unwrap();
        assert!(
            log.contains(" can2 7FF##0A5A5"),
            "FD is written as FD:\n{log}"
        );
        let import = parse_candump_files(&[temp_file("round-trip.log", &log)]).unwrap();
        assert_eq!(import.skipped_count, 0);
        assert_eq!(
            import.frames.iter().map(carried).collect::<Vec<_>>(),
            exported.iter().map(carried).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_csv_export_imports_back_through_the_column_mapper_as_the_same_frames() {
        for (name, protocol) in [("can", Protocol::Can), ("serial", Protocol::Serial)] {
            let exported = frames(name);
            let path = temp_file(
                &format!("20261001-1243-{name}.csv"),
                &encode(&exported, DumpFormat::Csv).unwrap(),
            );
            let preview = preview_csv_file(&path, 20, None).unwrap();
            assert_eq!(preview.suggested_protocol, protocol);
            let imported = parse_csv_with_mapping(
                &path,
                &preview.suggested_mappings,
                preview.has_header,
                TimestampUnit::Microseconds,
                false,
                Delimiter::Comma,
                protocol,
            )
            .unwrap()
            .frames;

            let start = exported.iter().map(|f| f.timestamp_us).min().unwrap();
            let rebased = |f: &FrameMessage| {
                let mut c = carried(f);
                c.0 -= start;
                c
            };
            assert_eq!(
                imported.iter().map(carried).collect::<Vec<_>>(),
                exported.iter().map(rebased).collect::<Vec<_>>(),
                "{name}"
            );
        }
    }

    #[test]
    fn a_log_the_typescript_writer_wrote_still_imports_except_its_fd_lines() {
        let import = parse_candump_files(&[format!("{FIXTURES}/can.ts.log")]).unwrap();
        let classic: Vec<_> = frames("can").into_iter().filter(|f| !f.is_fd).collect();
        assert_eq!(
            import
                .frames
                .iter()
                .map(|f| (
                    f.timestamp_us,
                    f.frame_id,
                    f.bus,
                    f.bytes.clone(),
                    f.is_extended
                ))
                .collect::<Vec<_>>(),
            classic
                .iter()
                .map(|f| (
                    f.timestamp_us,
                    f.frame_id,
                    f.bus,
                    f.bytes.clone(),
                    f.is_extended
                ))
                .collect::<Vec<_>>()
        );
        let skipped: Vec<_> = import.skipped.iter().map(|s| (s.line, s.code)).collect();
        assert_eq!(skipped, [(4, "too_long"), (5, "too_long")]);
    }

    #[test]
    fn a_remote_frame_exports_as_an_r_line_with_its_requested_length_and_imports_back() {
        let rtr = FrameMessage { is_rtr: true, dlc: 4, ..can(0x123, false, false, 0) };
        let log = encode(&[rtr], DumpFormat::Candump).unwrap();
        assert!(log.contains(" can0 123#R4"), "{log}");
        let import = parse_candump_files(&[temp_file("rtr.log", &log)]).unwrap();
        let back = &import.frames[0];
        assert_eq!((back.is_rtr, back.dlc, back.bytes.len()), (true, 4, 0));
    }

    #[test]
    fn an_fd_frame_exports_its_brs_and_esi() {
        let fd = FrameMessage { is_brs: true, is_esi: true, ..can(0x10, false, true, 2) };
        let log = encode(&[fd], DumpFormat::Candump).unwrap();
        assert!(log.contains(" can0 010##30000"), "{log}");
    }

    #[test]
    fn a_frame_the_format_cannot_carry_refuses_the_whole_export() {
        let mut serial = can(1, false, false, 3);
        serial.protocol = "serial".into();
        let cases = [
            (
                DumpFormat::Candump,
                serial.clone(),
                "frame 2: a serial frame is not a CAN frame",
            ),
            (
                DumpFormat::Candump,
                can(0x800, false, false, 0),
                "frame 2: 0x800 is past the 11-bit id range",
            ),
            (
                DumpFormat::Csv,
                can(0x2000_0000, true, false, 0),
                "frame 2: 0x20000000 is past the 29-bit id range",
            ),
            (
                DumpFormat::Candump,
                can(1, false, false, 9),
                "frame 2: 9 bytes is more than a classic CAN frame carries",
            ),
            (
                DumpFormat::Csv,
                can(1, false, true, 65),
                "frame 2: 65 bytes is more than a CAN FD frame carries",
            ),
            (
                DumpFormat::Candump,
                FrameMessage { is_rtr: true, dlc: 9, ..can(1, false, false, 0) },
                "frame 2: a remote frame asks for at most 8 bytes, not 9",
            ),
        ];
        for (format, bad, why) in cases {
            assert_eq!(
                encode(&[can(1, false, false, 1), bad], format),
                Err(format!("Nothing was written: {why}"))
            );
        }
        assert!(
            encode(&[serial], DumpFormat::Csv).is_ok(),
            "a CSV carries any protocol"
        );
    }

    #[test]
    fn a_long_refusal_names_the_first_few_and_counts_the_rest() {
        let bad = vec![can(0x800, false, false, 0); 7];
        let error = encode(&bad, DumpFormat::Candump).unwrap_err();
        assert!(
            error.contains("frame 5:") && !error.contains("frame 6:"),
            "{error}"
        );
        assert!(error.ends_with("(and 2 more)"), "{error}");
    }

    /// `frameDumpGolden.json` is what the TypeScript writers wrote before these moved here.
    fn golden(kind: &str) -> Vec<(serde_json::Value, serde_json::Value)> {
        let golden: serde_json::Value =
            serde_json::from_str(&fixture("frameDumpGolden.json")).unwrap();
        golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["name"].as_str().unwrap().split(' ').next() == Some(kind))
            .map(|c| (c["input"].clone(), c["expected"].clone()))
            .collect()
    }

    #[test]
    fn the_byte_exports_are_what_the_typescript_writer_wrote() {
        let byte = |b: &serde_json::Value| -> TimestampedByte {
            let wire = serde_json::json!({ "byte": b["byte"], "timestamp_us": b["timestampUs"] });
            serde_json::from_value(wire).unwrap()
        };
        for (kind, format) in [
            ("hex", ByteDumpFormat::Hex),
            ("csv", ByteDumpFormat::Csv),
            ("bin", ByteDumpFormat::Bin),
        ] {
            for (input, expected) in golden(kind) {
                let bytes: Vec<_> = input.as_array().unwrap().iter().map(byte).collect();
                let written = encode_bytes(&bytes, format);
                let expected: Vec<u8> = match expected {
                    serde_json::Value::String(text) => text.into_bytes(),
                    values => serde_json::from_value(values).unwrap(),
                };
                assert_eq!(written, expected, "{kind} {input}");
            }
        }
    }

    #[test]
    fn the_json_is_what_the_typescript_writer_wrote_with_the_id_padded_by_its_flag() {
        for (input, expected) in golden("json") {
            let frames: Vec<FrameMessage> = match input.as_str() {
                Some(file) => frames(
                    file.trim_start_matches("frame-dump/")
                        .trim_end_matches(".json"),
                ),
                None => Vec::new(),
            };
            let mut expected = expected.as_str().unwrap().to_string();
            let unpadded: Vec<serde_json::Value> = serde_json::from_str(&expected).unwrap();
            for (row, f) in unpadded.iter().zip(&frames) {
                let field = |hex: &str| format!(r#""frame_id_hex": "{hex}""#);
                expected = expected.replacen(
                    &field(row["frame_id_hex"].as_str().unwrap()),
                    &field(&format_frame_id(f.frame_id, f.is_extended)),
                    1,
                );
            }
            assert_eq!(
                encode(&frames, DumpFormat::Json).unwrap(),
                expected,
                "{input}"
            );
        }
    }

    #[test]
    fn frames_the_frontend_holds_need_not_name_their_flags() {
        let source: FrameSource = serde_json::from_str(
            r#"{"frames":[{"protocol":"serial","timestamp_us":1,"frame_id":1,"bus":0,"dlc":1,"bytes":[7]}]}"#,
        )
        .unwrap();
        assert!(matches!(source, FrameSource::Frames { frames } if frames.len() == 1));
    }
}
