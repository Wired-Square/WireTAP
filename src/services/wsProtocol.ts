// src/services/wsProtocol.ts
//
// Binary WebSocket protocol decoder/encoder.
// Uses DataView for zero-copy access to ArrayBuffer messages.

import type { FrameMessage } from "../types/frame";
import type { StreamEndedInfo } from "../api/io";
import { trackAlloc } from "./memoryDiag";

// ============================================================================
// Constants
// ============================================================================

export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 4;

export const MsgType = {
  FrameData: 0x01,
  SessionState: 0x02,
  StreamEnded: 0x03,
  SessionError: 0x04,
  PlaybackPosition: 0x05,
  DeviceConnected: 0x06,
  BufferChanged: 0x07,
  SessionLifecycle: 0x08,
  SessionInfo: 0x09,
  Reconfigured: 0x0a,
  TransmitUpdated: 0x0b,
  ReplayState: 0x0c,
  Subscribe: 0x10,
  Unsubscribe: 0x11,
  SubscribeAck: 0x12,
  SubscribeNack: 0x13,
  Heartbeat: 0xfe,
  Auth: 0xff,
} as const;

export const FrameType = {
  Can: 0x0001,
  CanFd: 0x0002,
  Modbus: 0x0003,
  Serial: 0x0004,
} as const;

// ============================================================================
// Header
// ============================================================================

export interface WsHeader {
  version: number;
  flags: number;
  msgType: number;
  channel: number;
}

export function decodeHeader(buf: ArrayBuffer): WsHeader {
  const view = new DataView(buf);
  const vf = view.getUint8(0);
  return {
    version: (vf >> 4) & 0x0f,
    flags: vf & 0x0f,
    msgType: view.getUint8(1),
    channel: view.getUint8(2),
    // byte 3 is reserved
  };
}

// ============================================================================
// Encoder helpers
// ============================================================================

/** Build a 4-byte header buffer: version+flags nibbles, msgType, channel, reserved. */
function buildHeader(msgType: number, channel: number, flags = 0): Uint8Array {
  const hdr = new Uint8Array(HEADER_SIZE);
  hdr[0] = ((PROTOCOL_VERSION & 0x0f) << 4) | (flags & 0x0f);
  hdr[1] = msgType;
  hdr[2] = channel;
  hdr[3] = 0; // reserved
  return hdr;
}

function concat(hdr: Uint8Array, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(hdr.byteLength + payload.byteLength);
  out.set(hdr, 0);
  out.set(payload, hdr.byteLength);
  return out.buffer;
}

// ============================================================================
// Message encoding (JS → Rust)
// ============================================================================

export function encodeAuth(token: string): ArrayBuffer {
  // Auth payload is raw UTF-8 token (no length prefix — entire payload is the token)
  const encoded = new TextEncoder().encode(token);
  return concat(buildHeader(MsgType.Auth, 0), encoded);
}

export function encodeSubscribe(sessionId: string): ArrayBuffer {
  // Subscribe payload is raw UTF-8 session ID (no length prefix)
  const encoded = new TextEncoder().encode(sessionId);
  return concat(buildHeader(MsgType.Subscribe, 0), encoded);
}

export function encodeUnsubscribe(channel: number): ArrayBuffer {
  const payload = new Uint8Array(1);
  payload[0] = channel;
  return concat(buildHeader(MsgType.Unsubscribe, channel), payload);
}

export function encodeHeartbeat(): ArrayBuffer {
  return buildHeader(MsgType.Heartbeat, 0).buffer;
}

// ============================================================================
// Frame batch decoder
// ============================================================================

/**
 * Decode a FrameData batch message.
 *
 * Each frame envelope is 12 bytes:
 *   [0..8)  timestamp_us  u64 LE
 *   [8]     bus           u8
 *   [9..11) frame_type    u16 LE
 *   [11]    len           u8   (total data bytes, including id_flags for CAN)
 *
 * timestamp_us is u64 but Number is safe up to 2^53 (~285 years of microseconds).
 */
export function decodeFrameBatch(
  buf: ArrayBuffer,
  headerOffset: number
): FrameMessage[] {
  const view = new DataView(buf);
  const frames: FrameMessage[] = [];
  let offset = headerOffset;

  while (offset < buf.byteLength) {
    if (offset + 12 > buf.byteLength) break;

    const timestamp_us = Number(view.getBigUint64(offset, true));
    const bus = view.getUint8(offset + 8);
    const frameType = view.getUint16(offset + 9, true);
    const len = view.getUint8(offset + 11);
    offset += 12;

    if (offset + len > buf.byteLength) break;

    const dataStart = offset;
    offset += len;

    let frame: FrameMessage;

    if (frameType === FrameType.Can || frameType === FrameType.CanFd) {
      if (len < 4) continue;
      const idFlags = view.getUint32(dataStart, true);
      const id = idFlags & 0x1fffffff;
      const isExtended = (idFlags & (1 << 29)) !== 0;
      const directionTx = (idFlags & (1 << 31)) !== 0;
      const payloadLen = len - 4;

      frame = {
        protocol: frameType === FrameType.CanFd ? "canfd" : "can",
        timestamp_us,
        frame_id: id,
        bus,
        dlc: payloadLen,
        bytes: Array.from(new Uint8Array(buf, dataStart + 4, payloadLen)),
        is_extended: isExtended,
        is_fd: frameType === FrameType.CanFd,
        direction: directionTx ? "tx" : undefined,
      };
    } else {
      frame = {
        protocol: frameType === FrameType.Serial ? "serial" : "modbus",
        timestamp_us,
        frame_id: 0,
        bus,
        dlc: len,
        bytes: Array.from(new Uint8Array(buf, dataStart, len)),
        is_extended: false,
        is_fd: false,
      };
    }

    frames.push(frame);
  }

  trackAlloc("decode.frames", frames.length * 300);
  trackAlloc("decode.count", frames.length);
  return frames;
}

// ============================================================================
// Non-frame message decoders
// ============================================================================

/** Read a u16 LE length-prefixed UTF-8 string. Returns [string, nextOffset]. */
function decodeLengthPrefixedStr(
  view: DataView,
  offset: number
): [string, number] {
  const len = view.getUint16(offset, true);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 2, len);
  const str = new TextDecoder().decode(bytes);
  return [str, offset + 2 + len];
}

export function decodeSessionState(payload: DataView): {
  state: string;
  errorMsg?: string;
} {
  const [state, next] = decodeLengthPrefixedStr(payload, 0);
  if (next < payload.byteLength) {
    const [errorMsg] = decodeLengthPrefixedStr(payload, next);
    return { state, errorMsg };
  }
  return { state };
}

export function decodeStreamEnded(payload: DataView): StreamEndedInfo {
  let offset = 0;

  const [reason, next1] = decodeLengthPrefixedStr(payload, offset);
  offset = next1;

  const bufferAvailable = payload.getUint8(offset) !== 0;
  offset += 1;

  const [bufferId, next2] = decodeLengthPrefixedStr(payload, offset);
  offset = next2;

  const [bufferType, next3] = decodeLengthPrefixedStr(payload, offset);
  offset = next3;

  const count = payload.getUint32(offset, true);
  offset += 4;

  let time_range: [number, number] | null = null;
  if (offset + 16 <= payload.byteLength) {
    const t0 = Number(
      new DataView(payload.buffer, payload.byteOffset + offset, 8).getBigUint64(
        0,
        true
      )
    );
    const t1 = Number(
      new DataView(
        payload.buffer,
        payload.byteOffset + offset + 8,
        8
      ).getBigUint64(0, true)
    );
    time_range = [t0, t1];
  }

  return {
    reason,
    buffer_available: bufferAvailable,
    buffer_id: bufferId.length > 0 ? bufferId : null,
    buffer_type: bufferType.length > 0 ? bufferType : null,
    count,
    time_range,
  };
}

export function decodeSessionError(payload: Uint8Array): string {
  return new TextDecoder().decode(payload);
}

export function decodePlaybackPosition(payload: DataView): {
  timestamp_us: number;
  frame_index: number;
  frame_count: number;
} {
  const timestamp_us = Number(payload.getBigUint64(0, true));
  const frame_index = payload.getUint32(8, true);
  const frame_count = payload.getUint32(12, true);
  return { timestamp_us, frame_index, frame_count };
}

export function decodeDeviceConnected(payload: DataView): {
  device_type: string;
  address: string;
  bus?: number;
} {
  let offset = 0;
  const [device_type, next1] = decodeLengthPrefixedStr(payload, offset);
  offset = next1;
  const [address, next2] = decodeLengthPrefixedStr(payload, offset);
  offset = next2;

  let bus: number | undefined;
  if (offset < payload.byteLength) {
    bus = payload.getUint8(offset);
  }

  return { device_type, address, bus };
}

export function decodeBufferChanged(payload: Uint8Array): string {
  return new TextDecoder().decode(payload);
}

export function decodeSessionInfo(payload: DataView): {
  speed: number;
  listener_count: number;
} {
  const speed = payload.getFloat32(0, true);
  const listener_count = payload.getUint16(4, true);
  return { speed, listener_count };
}

export function decodeSubscribeAck(payload: DataView): {
  channel: number;
  sessionId: string;
} {
  const channel = payload.getUint8(0);
  const [sessionId] = decodeLengthPrefixedStr(payload, 1);
  return { channel, sessionId };
}

/** Decode TransmitUpdated payload: i64 LE history count. */
export function decodeTransmitUpdated(payload: DataView): { count: number } {
  if (payload.byteLength < 8) return { count: 0 };
  return { count: Number(payload.getBigInt64(0, true)) };
}

const sharedLifecycleDecoder = new TextDecoder();
const SCOPED_STATE_MAP = ["stopped", "starting", "running", "paused", "error"] as const;

/** Decode scoped SessionLifecycle payload: state (u8) + capabilities (JSON). */
export function decodeScopedSessionLifecycle(payload: DataView): {
  stateType: string;
  capabilities: unknown | null;
} {
  if (payload.byteLength < 3) {
    return { stateType: "stopped", capabilities: null };
  }

  const stateByte = payload.getUint8(0);
  const stateType = SCOPED_STATE_MAP[stateByte] ?? "stopped";

  const jsonLen = payload.getUint16(1, true);
  let capabilities: unknown | null = null;
  if (jsonLen > 0 && 3 + jsonLen <= payload.byteLength) {
    const jsonBytes = new Uint8Array(payload.buffer, payload.byteOffset + 3, jsonLen);
    try {
      capabilities = JSON.parse(sharedLifecycleDecoder.decode(jsonBytes));
    } catch {
      // Malformed JSON
    }
  }

  return { stateType, capabilities };
}
