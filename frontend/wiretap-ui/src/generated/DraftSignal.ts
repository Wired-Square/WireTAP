// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteOrder } from "./ByteOrder";
import type { Confidence } from "./Confidence";
import type { SignalSource } from "./SignalSource";

export type DraftSignal = { name: string, startBit: number, bitLength: number, source: SignalSource, confidence: Confidence, byteOrder: ByteOrder | null, };
