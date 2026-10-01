// ui/crates/wiretap-app/src/io/recorded/mod.rs
//
// Recorded sources for playback from captured/imported data.
// These sources share common control patterns via RecordedSourceState.

mod backend_api;
mod base;
mod candump;
mod capture;
mod csv;

// Re-export public items
pub use backend_api::{BackendApiConfig, BackendApiSource, BackendApiSourceOptions};
pub use capture::{step_frame, CaptureSource, StepResult, CAPTURE_SOURCE_TYPE};
pub use candump::{is_candump_file, parse_candump_files, CandumpImport, SkippedLine};
pub use csv::{
    parse_csv_with_mapping, preview_csv_file, CsvColumnMapping, CsvPreview,
    Delimiter, SequenceGap, TimestampUnit,
};
