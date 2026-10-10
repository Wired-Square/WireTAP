// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QueueRow } from "./QueueRow";

/**
 * The whole queue; `revision` rises with every change.
 */
export type TransmitQueue = { revision: number, rows: Array<QueueRow>, active_groups: Array<string>, };
