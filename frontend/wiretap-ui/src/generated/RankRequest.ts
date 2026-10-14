// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * The explorer's sweep. `end_bit` absent means each frame's whole payload.
 */
export type RankRequest = { frameIds: Array<number>, startBit: number, endBit?: number, bitStep: number, bitLengths: Array<number>, endiannesses: Array<Endianness>, signed: boolean, factor: number, offset: number, useProfile: boolean, };
