// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusMapping } from "./BusMapping";
import type { IOCapabilities } from "./IOCapabilities";

/**
 * What a multi-source session opened, and the buses Rust gave each source.
 */
export type MultiSourceSession = { capabilities: IOCapabilities, bus_mappings: { [key in string]: Array<BusMapping> }, };
