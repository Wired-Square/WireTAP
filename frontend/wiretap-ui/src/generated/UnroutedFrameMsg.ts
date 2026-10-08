// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { UnroutedKind } from "./UnroutedKind";

/**
 * A frame the catalogue did not decode, and why.
 */
export type UnroutedFrameMsg = { bus: number, bytes: Array<number>, dlc: number, frameId: number, isBrs: boolean, isExtended: boolean, isFd: boolean, isRtr: boolean, kind: UnroutedKind, protocol: string, sourceAddress?: number, t: number, };
