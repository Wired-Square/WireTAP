// ui/src/api/frameOrder.ts
//
// Message order per protocol and bus, computed in Rust over a capture.

import { invoke } from "@tauri-apps/api/core";
import type { OrderStart } from "../generated/OrderStart";
import type { ProtocolOrder } from "../generated/ProtocolOrder";
import type { ProtocolFrames } from "../utils/frameKey";

/** The newest `newest` frames of the selection, or all of them; cycles walked
 *  from `start` when given. */
export async function frameOrder(
  captureId: string,
  selection: ProtocolFrames[],
  newest?: number,
  start?: OrderStart | null,
): Promise<ProtocolOrder[]> {
  return invoke<ProtocolOrder[]>("frame_order_cmd", { capture_id: captureId, selection, newest, start });
}
