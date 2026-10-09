// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusOrder } from "./BusOrder";
import type { MultiBusFrame } from "./MultiBusFrame";

export type OrderAnalysis = { totalFrames: number, uniqueKeys: number, timeSpanMs: number, buses: Array<BusOrder>, multiBus: Array<MultiBusFrame>, };
