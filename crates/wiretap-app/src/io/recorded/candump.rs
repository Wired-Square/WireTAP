// A `candump -L` log imported through `wiretap_protocol::candump`, keeping its
// absolute times.

use std::fs::File;
use std::io::{BufRead, BufReader};

use wiretap_protocol::can::Direction;
use wiretap_protocol::candump::{self, Line};

use crate::io::FrameMessage;

const REPORTED_SKIPS: usize = 100;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SkippedLine {
    pub file: String,
    pub line: usize,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Default)]
pub struct CandumpImport {
    /// Oldest first, across every file.
    pub frames: Vec<FrameMessage>,
    /// The first [`REPORTED_SKIPS`] of `skipped_count`.
    pub skipped: Vec<SkippedLine>,
    pub skipped_count: usize,
}

/// Whether the file's first non-blank line is a candump line.
pub fn is_candump_file(path: &str) -> Result<bool, String> {
    let reader = BufReader::new(open(path)?);
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Failed to read '{path}': {e}"))?;
        if !line.trim().is_empty() {
            return Ok(candump::parse_line(&line).is_ok());
        }
    }
    Ok(false)
}

/// Every good line of every file. A bad line is skipped and reported; the
/// import is refused only when no line parses.
pub fn parse_candump_files(paths: &[String]) -> Result<CandumpImport, String> {
    let mut import = CandumpImport::default();
    for path in paths {
        let file = file_name(path);
        let mut read_error = None;
        let text = BufReader::new(open(path)?)
            .lines()
            .map_while(|line| line.map_err(|e| read_error = Some(e)).ok());
        for parsed in candump::lines(text) {
            match parsed {
                Ok(line) => import.frames.push(frame_message(line)),
                Err(e) => {
                    import.skipped_count += 1;
                    if import.skipped.len() < REPORTED_SKIPS {
                        import.skipped.push(SkippedLine {
                            file: file.clone(),
                            line: e.line,
                            code: e.kind.code(),
                            message: e.kind.to_string(),
                        });
                    }
                }
            }
        }
        if let Some(e) = read_error {
            return Err(format!("Failed to read '{path}': {e}"));
        }
    }
    if import.frames.is_empty() {
        return Err(match import.skipped.first() {
            Some(first) => format!(
                "No line is a candump frame ({}, line {}: {})",
                first.file, first.line, first.message
            ),
            None => "The file has no frames".to_string(),
        });
    }
    import.frames.sort_by_key(|f| f.timestamp_us);
    Ok(import)
}

/// The trailing digits of an interface name (`can1`, `vcan0`), else bus 0.
pub(crate) fn interface_bus(interface: &str) -> u8 {
    let name = interface.trim_end_matches(|c: char| c.is_ascii_digit());
    interface[name.len()..].parse().unwrap_or(0)
}

/// RTR, BRS and ESI are dropped until `FrameMessage` carries them, as the live
/// adapter does; a received frame has no direction, as live.
fn frame_message(line: Line) -> FrameMessage {
    let frame = line.frame;
    FrameMessage {
        protocol: "can".to_string(),
        timestamp_us: line.ts_us,
        frame_id: frame.arb_id,
        bus: interface_bus(&line.interface),
        dlc: frame.data.len() as u16,
        bytes: frame.data,
        is_extended: frame.extended,
        is_fd: frame.fd,
        source_address: None,
        incomplete: None,
        direction: (line.direction == Some(Direction::Tx)).then(|| "tx".to_string()),
    }
}

fn open(path: &str) -> Result<File, String> {
    File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(name: &str, body: &str) -> String {
        let path =
            std::env::temp_dir().join(format!("wiretap-candump-{}-{name}", std::process::id()));
        std::fs::write(&path, body).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_log_keeps_its_absolute_times_flags_bus_and_tx_direction() {
        let path = temp_log(
            "flags.log",
            "(1727000000.000042) can0 123#DEADBEEF\n\
             (1727000000.001500) can1 18D9F110#0210 T\n\
             (1727000000.002000) can2 7FF##1A5A5A5A5A5A5A5A5A5A5A5A5 R\n\
             (1727000000.003000) vcan3 123#R5\n",
        );
        let import = parse_candump_files(&[path]).unwrap();
        let summary: Vec<_> = import
            .frames
            .iter()
            .map(|f| {
                (
                    f.timestamp_us,
                    f.frame_id,
                    f.bus,
                    f.is_extended,
                    f.is_fd,
                    f.bytes.len(),
                    f.direction.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (1_727_000_000_000_042, 0x123, 0, false, false, 4, None),
                (
                    1_727_000_000_001_500,
                    0x18D9_F110,
                    1,
                    true,
                    false,
                    2,
                    Some("tx")
                ),
                (1_727_000_000_002_000, 0x7FF, 2, false, true, 12, None),
                (1_727_000_000_003_000, 0x123, 3, false, false, 0, None),
            ]
        );
        assert_eq!(import.skipped_count, 0);
    }

    #[test]
    fn a_bad_line_is_skipped_and_reported_by_its_number_and_kind() {
        let path = temp_log(
            "bad.log",
            "(1.000000) can0 123#00\n\n(2.000000) can0 12#00\n(3.000000) can0 456#01\n",
        );
        let import = parse_candump_files(&[path.clone()]).unwrap();
        assert_eq!(import.frames.len(), 2);
        assert_eq!(
            import.skipped,
            [SkippedLine {
                file: file_name(&path),
                line: 3,
                code: "id_width",
                message: "the id is 3 hex digits, or 8 for an extended id".into(),
            }]
        );
    }

    #[test]
    fn a_file_with_no_good_line_is_refused() {
        let path = temp_log("none.log", "not a log\n");
        let error = parse_candump_files(&[path]).unwrap_err();
        assert!(error.starts_with("No line is a candump frame"), "{error}");
    }

    #[test]
    fn files_merge_in_time_order() {
        let later = temp_log("later.log", "(2.000000) can0 002#\n");
        let earlier = temp_log(
            "earlier.log",
            "(1.000000) can0 001#\n(3.000000) can0 003#\n",
        );
        let ids: Vec<_> = parse_candump_files(&[later, earlier])
            .unwrap()
            .frames
            .iter()
            .map(|f| f.frame_id)
            .collect();
        assert_eq!(ids, [1, 2, 3]);
    }

    #[test]
    fn only_a_file_that_opens_with_a_candump_line_is_one() {
        assert!(is_candump_file(&temp_log("yes.log", "\n(1.000000) can0 123#00\n")).unwrap());
        assert!(!is_candump_file(&temp_log("no.csv", "Time Stamp,ID\n")).unwrap());
    }

    #[test]
    fn an_interface_names_its_bus_by_its_trailing_digits() {
        for (interface, bus) in [
            ("can0", 0),
            ("vcan12", 12),
            ("3", 3),
            ("slcan", 0),
            ("can999", 0),
        ] {
            assert_eq!(interface_bus(interface), bus, "{interface}");
        }
    }
}
