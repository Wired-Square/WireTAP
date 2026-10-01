// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export type DecodedSignalValue = { display: string, format: string | null, 
/**
 * On a mirror frame, whether the bytes this signal covers differed from the source.
 */
mirrorMismatch?: boolean, muxValue: number | null, name: string, 
/**
 * Null when the scaled value is out of range.
 */
scaled: number | null, unit: string | null, value: number, };
