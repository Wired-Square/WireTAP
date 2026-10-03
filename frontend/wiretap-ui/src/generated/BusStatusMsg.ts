// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusStatus } from "./BusStatus";
import type { SendsLost } from "./SendsLost";

/**
 * The `BusStatus` push: every bus of the session in trouble, healthy ones left out.
 */
export type BusStatusMsg = { buses: Array<BusStatus>, sends_lost: SendsLost | null, };
