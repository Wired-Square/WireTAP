// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusOrder } from "./BusOrder";
import type { MultiBusFrame } from "./MultiBusFrame";

/**
 * Message order across a capture.
 */
export type OrderAnalysis = { totalFrames: number, uniqueKeys: number, timeSpanMs: number, 
/**
 * By bus.
 */
buses: Array<BusOrder>, 
/**
 * By key.
 */
multiBus: Array<MultiBusFrame>, };
