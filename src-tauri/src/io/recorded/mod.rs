// ui/src-tauri/src/io/recorded/mod.rs
//
// Recorded sources for playback from captured/imported data.
// These sources share common control patterns via RecordedSourceState.

mod base;
mod capture;
mod csv;
mod pacing;
mod postgres;

// Re-export public items
pub use capture::{step_frame, CaptureSource, StepResult};
pub use csv::{
    parse_csv_file, parse_csv_with_mapping, preview_csv_file, CsvColumnMapping, CsvPreview,
    CsvSource, CsvSourceOptions, Delimiter, SequenceGap, TimestampUnit,
};
pub use postgres::{PostgresConfig, PostgresSource, PostgresSourceOptions, PostgresSourceType};
