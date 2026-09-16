// ui/src/api/framingDetection.ts
//
// Which framing a captured serial byte stream is using.
//
// The analysis runs in Rust, against the same `SerialFramer` the port and
// `apply_framing_to_capture` use, reading the bytes straight out of the capture
// store. It used to be a brute-force CRC scan in TypeScript over a 100 KB copy
// fetched to the frontend for the purpose.

import { invoke } from "@tauri-apps/api/core";
import type { ModbusRtuOptions } from "./capture";

/** One framing mode that could explain the stream, with a 0-100 score. */
export interface FramingCandidate {
  mode: "slip" | "modbus_rtu" | "delimiter";
  confidence: number;
  notes: string[];
  /** Delimiter mode only. */
  delimiter?: number[];
  delimiterHex?: string;
  estimatedFrameCount: number;
  avgFrameLength: number;
  minFrameLength: number;
  maxFrameLength: number;
}

export interface FramingDetectionResult {
  byteCount: number;
  candidates: FramingCandidate[];
  bestCandidate: FramingCandidate | null;
  notes: string[];
  /**
   * Function codes the Modbus arm could not frame, commonest first. Declaring
   * these as vendor codes in the framing options is what makes such a line
   * readable — otherwise you would have to know them already.
   */
  unframedFunctions: number[];
  /** Address-0 messages it could not frame because broadcast was not allowed. */
  unframedBroadcasts: number;
}

/**
 * Detect the framing of a byte capture.
 *
 * `modbus` should be whatever the session is currently framing with, so the
 * scores describe the framer you would actually get.
 */
export async function detectSerialFraming(
  captureId: string,
  modbus?: ModbusRtuOptions,
  sampleBytes?: number,
): Promise<FramingDetectionResult> {
  return invoke("detect_serial_framing", {
    capture_id: captureId,
    sample_bytes: sampleBytes,
    modbus,
  });
}
