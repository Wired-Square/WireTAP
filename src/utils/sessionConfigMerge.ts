// ui/src/utils/sessionConfigMerge.ts
//
// Shared utility for merging catalog config into IO session load options.
// Used by Decoder, Graph, and any app that loads a catalog and starts a session.

import type { LoadOptions as ManagerLoadOptions } from "../hooks/useIOSessionManager";
import type { LoadOptions as DialogLoadOptions } from "../dialogs/IoSourcePickerDialog";
import type { SerialFrameConfig } from "./frameExport";

/**
 * Merge serial frame config from a catalog into dialog load options,
 * producing ManagerLoadOptions suitable for watchSource.
 *
 * Catalog config takes precedence for frame ID and source address extraction.
 * Dialog options take precedence for speed, time range, and max frames.
 */
export function mergeSerialConfig(
  serialConfig: SerialFrameConfig | null,
  options: DialogLoadOptions,
): ManagerLoadOptions {
  return {
    ...options,
    // Frame ID extraction from catalog
    frameIdStartByte: serialConfig?.frame_id_start_byte,
    frameIdBytes: serialConfig?.frame_id_bytes,
    // Source address extraction from catalog
    sourceAddressStartByte: serialConfig?.source_address_start_byte,
    sourceAddressBytes: serialConfig?.source_address_bytes,
    sourceAddressEndianness: serialConfig?.source_address_byte_order,
    // Min frame length: dialog option takes precedence if set
    minFrameLength: options.minFrameLength ?? serialConfig?.min_frame_length,
    // Framing encoding: dialog option takes precedence if set
    framingEncoding: options.framingEncoding ?? serialConfig?.encoding as ManagerLoadOptions["framingEncoding"],
  };
}

/**
 * Merge serial config for watch mode with emitRawBytes enabled.
 * Same as mergeSerialConfig but also enables raw byte emission for debugging.
 */
export function mergeSerialConfigForWatch(
  serialConfig: SerialFrameConfig | null,
  options: DialogLoadOptions,
): ManagerLoadOptions {
  return {
    ...mergeSerialConfig(serialConfig, options),
    emitRawBytes: true,
  };
}
