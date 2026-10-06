// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { UnroutedKind } from "./UnroutedKind";

/**
 * A frame the catalogue did not decode, and why.
 */
export type UnroutedFrameMsg = { bus: number, bytes: Array<number>, frameId: number, isFd: boolean, kind: UnroutedKind, protocol: string, sourceAddress?: number, t: number, };
