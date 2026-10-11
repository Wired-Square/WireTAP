// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

export type ExportMeta = { name: string, 
/**
 * Written as at least 1.
 */
version: number, default_byte_order: Endianness, 
/**
 * Milliseconds, written rounded and at least 0.
 */
default_interval: number, };
