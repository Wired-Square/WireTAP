// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export const PROTOCOL_VERSION = 2;

export const HEADER_SIZE = 4;

export const ENVELOPE_HEADER_SIZE = 15;

export const MsgType = {
  FrameData: 0x01,
  SessionState: 0x02,
  StreamEnded: 0x03,
  SessionError: 0x04,
  PlaybackPosition: 0x05,
  DeviceConnected: 0x06,
  CaptureChanged: 0x07,
  SessionLifecycle: 0x08,
  SessionInfo: 0x09,
  Reconfigured: 0x0a,
  TransmitUpdated: 0x0b,
  ReplayState: 0x0c,
  TestPatternState: 0x0d,
  OtaEvent: 0x0e,
  RepeatEvent: 0x0f,
  Subscribe: 0x10,
  Unsubscribe: 0x11,
  SubscribeAck: 0x12,
  SubscribeNack: 0x13,
  DecodedSignals: 0x14,
  AttachToPanel: 0x15,
  FrameCounts: 0x16,
  OpenAppsChanged: 0x17,
  CatalogListChanged: 0x18,
  ByteCounts: 0x19,
  ModbusScanState: 0x1a,
  DecodedBacklog: 0x1b,
  AdhocSignals: 0x1c,
  Command: 0x20,
  CommandResponse: 0x21,
  BridgeRequest: 0x30,
  BridgeResponse: 0x31,
  Heartbeat: 0xfe,
  Auth: 0xff,
} as const;

export const FrameType = {
  Can: 0x0001,
  CanFd: 0x0002,
  Modbus: 0x0003,
  Serial: 0x0004,
  ModbusRtu: 0x0005,
} as const;

export const IdFlags = {
  ID_ARB_MASK: 0x1fffffff,
  ID_EXTENDED: 0x20000000,
  ID_TX: 0x80000000,
} as const;

export const StreamEndedFlags = {
  CAPTURE_AVAILABLE: 0x01,
  HAS_CAPTURE_ID: 0x02,
  HAS_CAPTURE_KIND: 0x04,
  HAS_TIME_RANGE: 0x08,
} as const;

export const SESSION_STATES = ["stopped", "starting", "running", "paused", "error"] as const;

export const STREAM_END_REASONS = ["complete", "disconnected", "error", "stopped", "paused"] as const;

export const SESSION_ERROR_SEVERITIES = ["fault", "routine"] as const;

export const SESSION_TRANSITIONS = ["suspended", "switched_to_capture", "resuming", "returned_to_live", "capabilities_changed"] as const;

export const SESSION_MODES = ["live", "recorded", "capture", "replaying"] as const;

export const MODBUS_SCAN_SOURCE_TYPE = "modbus_scan";
