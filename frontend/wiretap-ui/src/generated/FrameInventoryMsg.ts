// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CaptureFrameInfo } from "./CaptureFrameInfo";

/**
 * `FrameInventory` (0x22): `reset` replaces what the reader holds with `rows`,
 * otherwise `rows` replace their own identities only.
 */
export type FrameInventoryMsg = { reset: boolean, rows: Array<CaptureFrameInfo>, };
