// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Protocol } from "./Protocol";

/**
 * What the source picker changed about one of a source's buses. Rust applies it
 * over its own allocation, so the user's choice survives and the count stays Rust's.
 */
export type BusOverride = { device_bus: number, enabled?: boolean, output_bus?: number, protocol?: Protocol, };
