// ui/src-tauri/src/io/timeline/mod.rs
//
// Timeline readers for playback from recorded sources.
// These readers share common control patterns via TimelineReaderState.

mod base;
mod capture;
mod csv;
mod pacing;
mod postgres;

// Re-export public items
pub use capture::{step_frame, CaptureSource, StepResult};
pub use csv::{
    parse_csv_file, parse_csv_with_mapping, preview_csv_file, CsvColumnMapping, CsvPreview,
    CsvReader, CsvReaderOptions, Delimiter, SequenceGap, TimestampUnit,
};
pub use postgres::{PostgresConfig, PostgresReader, PostgresReaderOptions, PostgresSourceType};
