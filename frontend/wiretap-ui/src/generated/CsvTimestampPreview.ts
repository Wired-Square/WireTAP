// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * The column mapper's timestamp preview: what the importer would stamp each
 * cell with, rebased over these cells rather than the whole file.
 */
export type CsvTimestampPreview = { timestamps_us: Array<number>, span_us: number, };
