// src/services/wsProtocol.ts
//
// Binary WebSocket protocol decoder/encoder.
// Uses DataView for zero-copy access to ArrayBuffer messages.

import type { FrameMessage } from "../types/frame";
import type { IOCapabilities, IOStateType, PlaybackPosition, StreamEndedInfo } from "../api/io";
import type { CaptureKind } from "../generated/CaptureKind";
import type { DecodedSignalsEntry } from "../generated/DecodedSignalsEntry";
import { trackAlloc } from "./memoryDiag";
import {
  ENVELOPE_HEADER_SIZE,
  FrameType,
  HEADER_SIZE,
  IdFlags,
  MsgType,
  PROTOCOL_VERSION,
  SESSION_ERROR_SEVERITIES,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  STREAM_END_REASONS,
  StreamEndedFlags,
} from "../generated/wireConstants";

export { ENVELOPE_HEADER_SIZE, FrameType, HEADER_SIZE, MsgType, PROTOCOL_VERSION };

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
 * Each frame envelope is 15 bytes:
 *   [0..8)   timestamp_us  u64 LE
 *   [8]      bus           u8
 *   [9..11)  frame_type    u16 LE
 *   [11..15) len           u32 LE (total data bytes, including id_flags for CAN)
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
    if (offset + ENVELOPE_HEADER_SIZE > buf.byteLength) break;

    const timestamp_us = Number(view.getBigUint64(offset, true));
    const bus = view.getUint8(offset + 8);
    const frameType = view.getUint16(offset + 9, true);
    const len = view.getUint32(offset + 11, true);
    offset += ENVELOPE_HEADER_SIZE;

    if (offset + len > buf.byteLength) break;

    const dataStart = offset;
    offset += len;

    let frame: FrameMessage;

    if (frameType === FrameType.Can || frameType === FrameType.CanFd) {
      if (len < 4) continue;
      const idFlags = view.getUint32(dataStart, true);
      const id = idFlags & IdFlags.ID_ARB_MASK;
      const isExtended = (idFlags & IdFlags.ID_EXTENDED) !== 0;
      const directionTx = (idFlags & IdFlags.ID_TX) !== 0;
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
    } else if (frameType === FrameType.Modbus || frameType === FrameType.ModbusRtu) {
      // Modbus: first 4 bytes are frame_id in LE — a register number for a
      // poll, `unit << 8 | function` for a whole RTU message — rest is payload
      if (len < 4) continue;
      const modbusId = view.getUint32(dataStart, true);
      const payloadLen = len - 4;
      frame = {
        protocol: frameType === FrameType.ModbusRtu ? "modbus_rtu" : "modbus",
        timestamp_us,
        frame_id: modbusId,
        bus,
        dlc: payloadLen,
        bytes: Array.from(new Uint8Array(buf, dataStart + 4, payloadLen)),
        is_extended: false,
        is_fd: false,
      };
    } else {
      // Serial and anything else — raw bytes, no frame_id
      frame = {
        protocol: "serial",
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
// Decoded-signal batch decoder (0x14)
//
// Pushed alongside FrameData when a catalogue is attached to the session.
// Decoding happens once, in Rust (the wiretap-catalog crate); the payload is
// a UTF-8 JSON array, one entry per frame: decoded, or why it was not.
// ============================================================================

export type { DecodedFrameMsg } from "../generated/DecodedFrameMsg";
export type { DecodedMirrorVerdict } from "../generated/DecodedMirrorVerdict";
export type { DecodedSignalsEntry } from "../generated/DecodedSignalsEntry";
export type { DecodedSignalValue } from "../generated/DecodedSignalValue";
export type { DecodedTunnelMessage } from "../generated/DecodedTunnelMessage";
export type { UnroutedFrameMsg } from "../generated/UnroutedFrameMsg";

const wsJsonDecoder = new TextDecoder();

/** Decode a JSON-payload WS message (4-byte header + UTF-8 JSON) into a typed object.
 *  Session-scoped handlers get the same raw buffer, so this serves both. */
export function decodeWsJson<T>(raw: ArrayBuffer): T {
  return JSON.parse(wsJsonDecoder.decode(new Uint8Array(raw, HEADER_SIZE))) as T;
}

const decodedSignalsDecoder = new TextDecoder();

/** Decode a DecodedSignals batch (JSON payload) into per-frame decode results. */
export function decodeDecodedSignals(payload: DataView): DecodedSignalsEntry[] {
  if (payload.byteLength === 0) return [];
  const bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  try {
    const parsed = JSON.parse(decodedSignalsDecoder.decode(bytes));
    return Array.isArray(parsed) ? (parsed as DecodedSignalsEntry[]) : [];
  } catch {
    return [];
  }
}

/** Decode a DecodedBacklog: the attaching subscriber's id (u16 BE length + UTF-8), then a DecodedSignals batch. */
export function decodeDecodedBacklog(payload: DataView): { subscriber: string; decoded: DecodedSignalsEntry[] } {
  const nameEnd = 2 + payload.getUint16(0);
  return {
    subscriber: decodedSignalsDecoder.decode(new Uint8Array(payload.buffer, payload.byteOffset + 2, nameEnd - 2)),
    decoded: decodeDecodedSignals(new DataView(payload.buffer, payload.byteOffset + nameEnd, payload.byteLength - nameEnd)),
  };
}

export type { AdhocSignalsMsg } from "../generated/AdhocSignalsMsg";
export type { AttachToPanelMsg } from "../generated/AttachToPanelMsg";
export type { ModbusScanStateMsg } from "../generated/ModbusScanStateMsg";

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

// Wire format: 1 byte state_type, followed by a length-prefixed error
// message iff the state is "error". Matches Rust encode_session_state
// in crates/wiretap-app/src/ws/protocol.rs.
export function decodeSessionState(payload: DataView): {
  state: string;
  errorMsg?: string;
} {
  if (payload.byteLength < 1) {
    return { state: "stopped" };
  }
  const stateType = payload.getUint8(0);
  const state = SESSION_STATES[stateType] ?? `unknown(${stateType})`;
  if (state === "error" && payload.byteLength >= 3) {
    const [errorMsg] = decodeLengthPrefixedStr(payload, 1);
    return { state, errorMsg };
  }
  return { state };
}

// Wire format (matches Rust encode_stream_ended in ws/protocol.rs):
//   reason:  u8  (an index into STREAM_END_REASONS)
//   flags:   u8  (StreamEndedFlags)
//   count:   u32 LE
//   optional: capture_id   (length-prefixed string, present if HAS_CAPTURE_ID)
//   optional: capture_kind (length-prefixed string, present if HAS_CAPTURE_KIND)
//   optional: time_range   (two u64 LE, present if HAS_TIME_RANGE)

const CAPTURE_KINDS: Record<CaptureKind, true> = { frames: true, bytes: true };
const isCaptureKind = (kind: string): kind is CaptureKind =>
  Object.prototype.hasOwnProperty.call(CAPTURE_KINDS, kind);

export function decodeStreamEnded(payload: DataView): StreamEndedInfo {
  let offset = 0;

  const reasonByte = payload.getUint8(offset);
  offset += 1;
  const reason = STREAM_END_REASONS[reasonByte] ?? "stopped";

  const flags = payload.getUint8(offset);
  offset += 1;
  const captureAvailable = (flags & StreamEndedFlags.CAPTURE_AVAILABLE) !== 0;
  const hasCaptureId     = (flags & StreamEndedFlags.HAS_CAPTURE_ID) !== 0;
  const hasCaptureKind   = (flags & StreamEndedFlags.HAS_CAPTURE_KIND) !== 0;
  const hasTimeRange     = (flags & StreamEndedFlags.HAS_TIME_RANGE) !== 0;

  const count = payload.getUint32(offset, true);
  offset += 4;

  let captureId: string | null = null;
  if (hasCaptureId) {
    const [id, next] = decodeLengthPrefixedStr(payload, offset);
    captureId = id.length > 0 ? id : null;
    offset = next;
  }

  let captureKind: CaptureKind | null = null;
  if (hasCaptureKind) {
    const [kind, next] = decodeLengthPrefixedStr(payload, offset);
    captureKind = isCaptureKind(kind) ? kind : null;
    offset = next;
  }

  let time_range: [number, number] | null = null;
  if (hasTimeRange && offset + 16 <= payload.byteLength) {
    const t0 = Number(
      new DataView(payload.buffer, payload.byteOffset + offset, 8).getBigUint64(0, true)
    );
    const t1 = Number(
      new DataView(payload.buffer, payload.byteOffset + offset + 8, 8).getBigUint64(0, true)
    );
    time_range = [t0, t1];
  }

  return {
    reason,
    capture_available: captureAvailable,
    capture_id: captureId,
    capture_kind: captureKind,
    count,
    time_range,
  };
}

export type SessionErrorSeverity = (typeof SESSION_ERROR_SEVERITIES)[number];

// Wire format: severity u8 (an index into SESSION_ERROR_SEVERITIES), then the
// rest of the payload is the UTF-8 message.
export function decodeSessionError(payload: Uint8Array): {
  severity: SessionErrorSeverity;
  message: string;
} {
  return {
    severity: SESSION_ERROR_SEVERITIES[payload[0]] ?? "fault",
    message: new TextDecoder().decode(payload.subarray(1)),
  };
}

export function decodePlaybackPosition(payload: DataView): PlaybackPosition {
  const timestamp_us = Number(payload.getBigUint64(0, true));
  const frame_index = payload.getUint32(8, true);
  const frame_count = payload.getUint32(12, true);
  return { timestamp_us, frame_index, frame_count };
}

export function decodeCaptureChanged(payload: Uint8Array): string {
  return new TextDecoder().decode(payload);
}

export function decodeSessionInfo(payload: DataView): {
  speed: number;
  subscriber_count: number;
} {
  const speed = payload.getFloat64(0, true);
  const subscriber_count = payload.getUint16(8, true);
  return { speed, subscriber_count };
}

/** Decode a FrameCounts payload — total u64 LE + unique u32 LE (12 bytes). */
export function decodeFrameCounts(payload: DataView): {
  total: number;
  unique: number;
} {
  const total = Number(payload.getBigUint64(0, true));
  const unique = payload.getUint32(8, true);
  return { total, unique };
}

/**
 * Decode a ByteCounts payload — total u64 LE + length-prefixed byte-capture id.
 *
 * Raw serial bytes are read from the capture rather than streamed, so this message is
 * the whole byte signal: the total tells the view to refetch, the id tells it where from.
 */
export function decodeByteCounts(payload: DataView): {
  total: number;
  captureId: string;
} {
  const total = Number(payload.getBigUint64(0, true));
  const [captureId] = decodeLengthPrefixedStr(payload, 8);
  return { total, captureId };
}

export function decodeSubscribeAck(payload: DataView): {
  channel: number;
  sessionId: string;
} {
  const channel = payload.getUint8(0);
  const [sessionId] = decodeLengthPrefixedStr(payload, 1);
  return { channel, sessionId };
}

// Wire format: length-prefixed session id, then the rest of the payload is the UTF-8 error.
export function decodeSubscribeNack(payload: DataView): {
  sessionId: string;
  error: string;
} {
  const [sessionId, offset] = decodeLengthPrefixedStr(payload, 0);
  const rest = new Uint8Array(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
  return { sessionId, error: new TextDecoder().decode(rest) };
}

/** Decode TransmitUpdated payload: i64 LE history count. */
export function decodeTransmitUpdated(payload: DataView): { count: number } {
  if (payload.byteLength < 8) return { count: 0 };
  return { count: Number(payload.getBigInt64(0, true)) };
}

export type SessionTransition = (typeof SESSION_TRANSITIONS)[number];

/** A session's scoped SessionLifecycle message: what happened, and where it left the session. */
export interface SessionTransitionMsg {
  transition: SessionTransition;
  state: IOStateType;
  capabilities: IOCapabilities | null;
  /** The capture the session finished with, for a suspend or a switch to capture. */
  capture_id: string | null;
  capture_count: number;
}

// Wire format (matches Rust encode_session_transition in ws/protocol.rs): state u8,
// transition u8, length-prefixed capabilities JSON, length-prefixed capture id (empty
// for none), capture count u32 LE. An unknown transition reads as capabilities_changed.
export function decodeSessionTransition(payload: DataView): SessionTransitionMsg {
  const state = (SESSION_STATES[payload.getUint8(0)] ?? "stopped") as IOStateType;
  const transition = SESSION_TRANSITIONS[payload.getUint8(1)] ?? "capabilities_changed";
  const [json, idOffset] = decodeLengthPrefixedStr(payload, 2);
  const [captureId, countOffset] = decodeLengthPrefixedStr(payload, idOffset);
  let capabilities: IOCapabilities | null = null;
  try {
    capabilities = JSON.parse(json);
  } catch {
    // Malformed JSON
  }
  return {
    transition,
    state,
    capabilities,
    capture_id: captureId || null,
    capture_count: payload.getUint32(countOffset, true),
  };
}

// ============================================================================
// Command / CommandResponse  (0x20 / 0x21)
// ============================================================================

const commandEncoder = new TextEncoder();

/**
 * Encode a Command message (client → server).
 * Payload: [correlation_id: u32 LE][op_name_len: u16 LE][op_name: UTF-8][params: JSON bytes]
 */
export function encodeCommand(
  correlationId: number,
  opName: string,
  params: object,
): ArrayBuffer {
  const opNameBytes = commandEncoder.encode(opName);
  const paramsBytes = commandEncoder.encode(JSON.stringify(params));
  const payloadLen = 4 + 2 + opNameBytes.byteLength + paramsBytes.byteLength;
  const payload = new Uint8Array(payloadLen);
  const view = new DataView(payload.buffer);
  view.setUint32(0, correlationId, true);
  view.setUint16(4, opNameBytes.byteLength, true);
  payload.set(opNameBytes, 6);
  payload.set(paramsBytes, 6 + opNameBytes.byteLength);
  return concat(buildHeader(MsgType.Command, 0), payload);
}

const commandDecoder = new TextDecoder();

/**
 * Decode a CommandResponse payload (server → client).
 * Payload: [correlation_id: u32 LE][status: u8 (0=ok, 1=error)][payload: JSON bytes or error string]
 */
export function decodeCommandResponse(payload: DataView): {
  correlationId: number;
  status: number;
  data: unknown;
  error?: string;
} {
  const correlationId = payload.getUint32(0, true);
  const status = payload.getUint8(4);
  const bodyBytes = new Uint8Array(
    payload.buffer,
    payload.byteOffset + 5,
    payload.byteLength - 5,
  );
  if (status !== 0) {
    return {
      correlationId,
      status,
      data: null,
      error: commandDecoder.decode(bodyBytes),
    };
  }
  let data: unknown = null;
  if (bodyBytes.byteLength > 0) {
    try {
      data = JSON.parse(commandDecoder.decode(bodyBytes));
    } catch {
      // Non-JSON response — return raw string
      data = commandDecoder.decode(bodyBytes);
    }
  }
  return { correlationId, status, data };
}

// ============================================================================
// BridgeRequest / BridgeResponse  (0x30 / 0x31)
//
// Reverse RPC: the Rust backend (driven by the MCP server) asks the frontend
// for state only it holds. The frontend computes a result and replies.
// ============================================================================

/**
 * Decode a BridgeRequest payload (server → frontend).
 * Payload: [correlation_id: u32 LE][method_len: u16 LE][method: UTF-8][params: JSON bytes]
 */
export function decodeBridgeRequest(payload: DataView): {
  correlationId: number;
  method: string;
  params: unknown;
} {
  const correlationId = payload.getUint32(0, true);
  const methodLen = payload.getUint16(4, true);
  const methodBytes = new Uint8Array(payload.buffer, payload.byteOffset + 6, methodLen);
  const method = commandDecoder.decode(methodBytes);
  const paramsStart = 6 + methodLen;
  let params: unknown = null;
  if (payload.byteLength > paramsStart) {
    const paramsBytes = new Uint8Array(
      payload.buffer,
      payload.byteOffset + paramsStart,
      payload.byteLength - paramsStart,
    );
    try {
      params = JSON.parse(commandDecoder.decode(paramsBytes));
    } catch {
      params = null;
    }
  }
  return { correlationId, method, params };
}

/**
 * Encode a BridgeResponse message (frontend → server).
 * Payload: [correlation_id: u32 LE][status: u8 (0=ok, 1=error)][payload: JSON bytes or error string]
 */
export function encodeBridgeResponse(
  correlationId: number,
  status: number,
  body: string,
): ArrayBuffer {
  const bodyBytes = commandEncoder.encode(body);
  const payload = new Uint8Array(5 + bodyBytes.byteLength);
  const view = new DataView(payload.buffer);
  view.setUint32(0, correlationId, true);
  view.setUint8(4, status);
  payload.set(bodyBytes, 5);
  return concat(buildHeader(MsgType.BridgeResponse, 0), payload);
}
