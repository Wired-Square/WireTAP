// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";
import type { HeaderField } from "./HeaderField";

/**
 * `[meta.can]` defaults.
 */
export type CanConfig = { defaultByteOrder?: Endianness | null, defaultInterval?: number | null, defaultExtended?: boolean | null, defaultFd?: boolean | null, frameIdMask?: number | null, fields?: { [key in string]: HeaderField }, };
