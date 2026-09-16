// SMP / OTA wrappers — thin layer over WS commands and the OtaEvent
// push channel. All protocol logic lives in framelink-rs; this file
// only translates between the WS wire format and the UI.

import { wsTransport } from "../services/wsTransport";
import { MsgType } from "../services/wsProtocol";

export interface ImageSlotInfo {
  slot: number;
  version: string;
  hash: string;
  bootable: boolean;
  pending: boolean;
  confirmed: boolean;
  active: boolean;
  permanent: boolean;
  image: number | null;
}

export type Transport = "ble" | "udp";

export interface OtaStartParams {
  deviceId: string;
  transport: Transport;
  filePath: string;
  reconnectTimeoutSecs?: number;
}

/**
 * Discriminated union mirroring framelink::OtaEvent plus the shim's
 * own `Cancelled`, `Complete`, and `Error` terminators.
 */
export type OtaEvent =
  | { type: "SessionOpened" }
  | {
      type: "UploadProgress";
      bytes_sent: number;
      total_bytes: number;
      percent: number;
      image_hash: string | null;
    }
  | { type: "Activating" }
  | { type: "Activated"; hash: string }
  | { type: "Resetting" }
  | { type: "ResetSent" }
  | { type: "Reconnecting"; name: string }
  | { type: "Reconnected"; device_id: string }
  | { type: "Verified"; active_hash: string }
  | { type: "Confirming" }
  | { type: "Confirmed" }
  | { type: "Cancelled" }
  | { type: "Complete" }
  | { type: "Error"; message: string };

export async function listImages(
  deviceId: string,
  transport: Transport,
): Promise<ImageSlotInfo[]> {
  return wsTransport.command<ImageSlotInfo[]>("smp.list_images", {
    device_id: deviceId,
    transport,
  });
}

export async function otaStart(params: OtaStartParams): Promise<void> {
  await wsTransport.command<Record<string, never>>("smp.ota_start", {
    device_id: params.deviceId,
    transport: params.transport,
    file_path: params.filePath,
    reconnect_timeout_secs: params.reconnectTimeoutSecs ?? null,
  });
}

export async function otaCancel(): Promise<void> {
  await wsTransport.command<Record<string, never>>("smp.ota_cancel", {});
}

/**
 * Subscribe to OTA events. Returned function unsubscribes.
 * Caller is responsible for distinguishing UI-relevant events from
 * `Complete` / `Cancelled` / `Error` terminators (each of which means
 * the OTA is over).
 */
export function subscribeOtaEvents(
  onEvent: (event: OtaEvent) => void,
): () => void {
  const decoder = new TextDecoder();
  return wsTransport.onGlobalMessage(MsgType.OtaEvent, (payload: DataView) => {
    const text = decoder.decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
    try {
      onEvent(JSON.parse(text) as OtaEvent);
    } catch {
      // Malformed event body; ignore.
    }
  });
}
