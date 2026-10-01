// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { DeviceInfoPayload } from "./DeviceInfoPayload";
import type { ScanProgressPayload } from "./ScanProgressPayload";

/**
 * A sweep's progress, pushed on the scan session's WebSocket channel and kept
 * here for MCP, which is in-process Rust and cannot subscribe to that channel.
 * Frames are not carried here — they reach the UI through the session's
 * capture like any other frames.
 */
export type ModbusScanStateMsg = { status: string, progress: ScanProgressPayload | null, device_info: Array<DeviceInfoPayload>, 
/**
 * Diagnoses worth surfacing, e.g. a function code that never answered.
 */
notes: Array<string>, 
/**
 * The capture this sweep is filling.
 *
 * Sent with every tick because the UI needs it long after the sweep: a
 * results tab reads its own capture once a later sweep owns the frame
 * store. Registration cannot supply it — the capture is created in
 * `ModbusScanSource::start`, which runs after the subscriber attaches —
 * so the first progress tick is the earliest it can be known, and it must
 * not depend on anyone still watching when the sweep ends.
 */
capture_id: string | null, };
