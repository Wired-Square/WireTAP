// ui/src-tauri/src/io/timeline/mod.rs
//
// Timeline readers for playback from recorded sources.
// These readers share common control patterns via TimelineReaderState.

mod base;
mod buffer;
mod csv;
mod postgres;

// Re-export public items
pub use buffer::{step_frame, BufferReader, StepResult};
pub use csv::{
    parse_csv_file, parse_csv_with_mapping, preview_csv_file, CsvColumnMapping, CsvPreview,
    CsvReader, CsvReaderOptions,
};
pub use postgres::{PostgresConfig, PostgresReader, PostgresReaderOptions, PostgresSourceType};
