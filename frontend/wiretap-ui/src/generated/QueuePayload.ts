// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CanTransmitFrame } from "./CanTransmitFrame";
import type { SerialFraming } from "./SerialFraming";

export type QueuePayload = { "kind": "can", frame: CanTransmitFrame, } | { "kind": "serial", bytes: Array<number>, framing: SerialFraming, };
