// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

pub const PROTOCOL_VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MsgType {
    FrameData        = 0x01,
    SessionState     = 0x02,
    StreamEnded      = 0x03,
    SessionError     = 0x04,
    PlaybackPosition = 0x05,
    DeviceConnected  = 0x06,
    BufferChanged    = 0x07,
    SessionLifecycle = 0x08,
    SessionInfo      = 0x09,
    Reconfigured     = 0x0A,
    TransmitUpdated  = 0x0B,
    ReplayState      = 0x0C,
    TestPatternState = 0x0D,
    Subscribe        = 0x10,
    Unsubscribe      = 0x11,
    SubscribeAck     = 0x12,
    SubscribeNack    = 0x13,
    Command          = 0x20,
    CommandResponse  = 0x21,
    Heartbeat        = 0xFE,
    Auth             = 0xFF,
}

impl TryFrom<u8> for MsgType {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0x01 => Ok(MsgType::FrameData),
            0x02 => Ok(MsgType::SessionState),
            0x03 => Ok(MsgType::StreamEnded),
            0x04 => Ok(MsgType::SessionError),
            0x05 => Ok(MsgType::PlaybackPosition),
            0x06 => Ok(MsgType::DeviceConnected),
            0x07 => Ok(MsgType::BufferChanged),
            0x08 => Ok(MsgType::SessionLifecycle),
            0x09 => Ok(MsgType::SessionInfo),
            0x0A => Ok(MsgType::Reconfigured),
            0x0B => Ok(MsgType::TransmitUpdated),
            0x0C => Ok(MsgType::ReplayState),
            0x0D => Ok(MsgType::TestPatternState),
            0x10 => Ok(MsgType::Subscribe),
            0x11 => Ok(MsgType::Unsubscribe),
            0x12 => Ok(MsgType::SubscribeAck),
            0x13 => Ok(MsgType::SubscribeNack),
            0x20 => Ok(MsgType::Command),
            0x21 => Ok(MsgType::CommandResponse),
            0xFE => Ok(MsgType::Heartbeat),
            0xFF => Ok(MsgType::Auth),
            other => Err(ProtocolError::InvalidMsgType(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub flags: u8,
    pub msg_type: MsgType,
    pub channel: u8,
}

impl Header {
    pub fn new(msg_type: MsgType, channel: u8) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            flags: 0,
            msg_type,
            channel,
        }
    }

    pub fn encode(&self) -> [u8; 4] {
        [
            (self.version << 4) | (self.flags & 0x0F),
            self.msg_type as u8,
            self.channel,
            0, // reserved
        ]
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_SIZE {
            return Err(ProtocolError::TooShort);
        }

        let version = bytes[0] >> 4;
        if version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(version));
        }

        let flags = bytes[0] & 0x0F;
        let msg_type = MsgType::try_from(bytes[1])?;
        let channel = bytes[2];

        Ok(Self { version, flags, msg_type, channel })
    }
}

/// Convenience function: encode header + payload into a single buffer.
pub fn encode_message(msg_type: MsgType, channel: u8, payload: &[u8]) -> Vec<u8> {
    let header = Header::new(msg_type, channel);
    let mut out = Vec::with_capacity(HEADER_SIZE + payload.len());
    out.extend_from_slice(&header.encode());
    out.extend_from_slice(payload);
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    TooShort,
    InsufficientData { needed: usize, available: usize },
    UnsupportedVersion(u8),
    InvalidMsgType(u8),
    InvalidFrameType(u16),
}

// ============================================================================
// Frame Type Identifiers
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum FrameType {
    Can    = 0x0001,
    CanFd  = 0x0002,
    Modbus = 0x0003,
    Serial = 0x0004,
}

impl TryFrom<u16> for FrameType {
    type Error = ProtocolError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            0x0001 => Ok(FrameType::Can),
            0x0002 => Ok(FrameType::CanFd),
            0x0003 => Ok(FrameType::Modbus),
            0x0004 => Ok(FrameType::Serial),
            other  => Err(ProtocolError::InvalidFrameType(other)),
        }
    }
}

// ============================================================================
// Frame Envelope  (12-byte header + data)
//
// Layout: [timestamp_us: u64 LE][bus: u8][type: u16 LE][len: u8][data: len bytes]
// ============================================================================

pub const ENVELOPE_HEADER_SIZE: usize = 12;

#[derive(Debug, PartialEq, Eq)]
pub struct FrameEnvelope {
    pub timestamp_us: u64,
    pub bus: u8,
    pub frame_type: FrameType,
    pub data: Vec<u8>,
}

impl FrameEnvelope {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(ENVELOPE_HEADER_SIZE + self.data.len());
        out.extend_from_slice(&self.timestamp_us.to_le_bytes());
        out.push(self.bus);
        out.extend_from_slice(&(self.frame_type as u16).to_le_bytes());
        out.push(self.data.len() as u8);
        out.extend_from_slice(&self.data);
        out
    }

    /// Parse one envelope from `bytes`, returning the envelope and the number
    /// of bytes consumed so the caller can advance through a batch buffer.
    pub fn decode(bytes: &[u8]) -> Result<(FrameEnvelope, usize), ProtocolError> {
        if bytes.len() < ENVELOPE_HEADER_SIZE {
            return Err(ProtocolError::InsufficientData {
                needed:    ENVELOPE_HEADER_SIZE,
                available: bytes.len(),
            });
        }

        let timestamp_us = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let bus          = bytes[8];
        let frame_type   = FrameType::try_from(u16::from_le_bytes(bytes[9..11].try_into().unwrap()))?;
        let len          = bytes[11] as usize;

        let total = ENVELOPE_HEADER_SIZE + len;
        if bytes.len() < total {
            return Err(ProtocolError::InsufficientData {
                needed:    total,
                available: bytes.len(),
            });
        }

        let data = bytes[ENVELOPE_HEADER_SIZE..total].to_vec();
        Ok((FrameEnvelope { timestamp_us, bus, frame_type, data }, total))
    }
}

// ============================================================================
// CAN 2.0 Frame
//
// Layout inside envelope data: [id_flags: u32 LE][payload: 0-8 bytes]
// id_flags bits: [28:0] CAN ID, [29] is_extended, [30] is_rtr, [31] direction_tx
// ============================================================================

#[derive(Debug, PartialEq, Eq)]
pub struct CanFrame {
    pub id: u32,
    pub is_extended: bool,
    pub is_rtr: bool,
    pub direction_tx: bool,
    pub payload: Vec<u8>,
}

impl CanFrame {
    pub fn encode(&self) -> Vec<u8> {
        let id_flags = (self.id & 0x1FFF_FFFF)
            | if self.is_extended  { 1 << 29 } else { 0 }
            | if self.is_rtr       { 1 << 30 } else { 0 }
            | if self.direction_tx { 1 << 31 } else { 0 };

        let mut out = Vec::with_capacity(4 + self.payload.len());
        out.extend_from_slice(&id_flags.to_le_bytes());
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn decode(data: &[u8]) -> Result<CanFrame, ProtocolError> {
        if data.len() < 4 {
            return Err(ProtocolError::InsufficientData { needed: 4, available: data.len() });
        }
        let id_flags   = u32::from_le_bytes(data[0..4].try_into().unwrap());
        let id         = id_flags & 0x1FFF_FFFF;
        let is_extended = (id_flags >> 29) & 1 != 0;
        let is_rtr      = (id_flags >> 30) & 1 != 0;
        let direction_tx = (id_flags >> 31) & 1 != 0;
        let payload    = data[4..].to_vec();
        Ok(CanFrame { id, is_extended, is_rtr, direction_tx, payload })
    }
}

// ============================================================================
// CAN-FD Frame
//
// Same layout as CAN 2.0 but bit [30] is brs (bit rate switch) and payload
// up to 64 bytes.
// ============================================================================

#[derive(Debug, PartialEq, Eq)]
pub struct CanFdFrame {
    pub id: u32,
    pub is_extended: bool,
    pub brs: bool,
    pub direction_tx: bool,
    pub payload: Vec<u8>,
}

impl CanFdFrame {
    pub fn encode(&self) -> Vec<u8> {
        let id_flags = (self.id & 0x1FFF_FFFF)
            | if self.is_extended  { 1 << 29 } else { 0 }
            | if self.brs          { 1 << 30 } else { 0 }
            | if self.direction_tx { 1 << 31 } else { 0 };

        let mut out = Vec::with_capacity(4 + self.payload.len());
        out.extend_from_slice(&id_flags.to_le_bytes());
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn decode(data: &[u8]) -> Result<CanFdFrame, ProtocolError> {
        if data.len() < 4 {
            return Err(ProtocolError::InsufficientData { needed: 4, available: data.len() });
        }
        let id_flags    = u32::from_le_bytes(data[0..4].try_into().unwrap());
        let id          = id_flags & 0x1FFF_FFFF;
        let is_extended  = (id_flags >> 29) & 1 != 0;
        let brs          = (id_flags >> 30) & 1 != 0;
        let direction_tx = (id_flags >> 31) & 1 != 0;
        let payload     = data[4..].to_vec();
        Ok(CanFdFrame { id, is_extended, brs, direction_tx, payload })
    }
}

// ============================================================================
// Non-frame message encoding / decoding helpers
// ============================================================================

/// Reusable helper: u16 LE length prefix + UTF-8 bytes.
fn encode_length_prefixed_str(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let len = bytes.len() as u16;
    let mut out = Vec::with_capacity(2 + bytes.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Read a length-prefixed string from `src` at `pos`, advancing `pos` past it.
/// Returns `Err(ProtocolError::InsufficientData)` if there is not enough data.
fn decode_length_prefixed_str(src: &[u8], pos: &mut usize) -> Result<String, ProtocolError> {
    if src.len() < *pos + 2 {
        return Err(ProtocolError::InsufficientData { needed: *pos + 2, available: src.len() });
    }
    let len = u16::from_le_bytes(src[*pos..*pos + 2].try_into().unwrap()) as usize;
    *pos += 2;
    if src.len() < *pos + len {
        return Err(ProtocolError::InsufficientData { needed: *pos + len, available: src.len() });
    }
    let s = String::from_utf8_lossy(&src[*pos..*pos + len]).into_owned();
    *pos += len;
    Ok(s)
}

// ----------------------------------------------------------------------------
// 0x02 — Session State
// ----------------------------------------------------------------------------

/// Encode a SessionState payload.
///
/// `state_type`: 0=Stopped, 1=Starting, 2=Running, 3=Paused, 4=Error.
/// When `state_type == 4` (Error), the error message is appended as a
/// length-prefixed UTF-8 string.
pub fn encode_session_state(state_type: u8, error_msg: Option<&str>) -> Vec<u8> {
    let mut out = vec![state_type];
    if state_type == 4 {
        if let Some(msg) = error_msg {
            out.extend_from_slice(&encode_length_prefixed_str(msg));
        } else {
            // Zero-length string so the decoder always finds a prefix.
            out.extend_from_slice(&0u16.to_le_bytes());
        }
    }
    out
}

#[derive(Debug, PartialEq)]
pub struct SessionStateMsg {
    pub state_type: u8,
    pub error_msg: Option<String>,
}

pub fn decode_session_state(payload: &[u8]) -> Result<SessionStateMsg, ProtocolError> {
    if payload.is_empty() {
        return Err(ProtocolError::TooShort);
    }
    let state_type = payload[0];
    let error_msg = if state_type == 4 {
        let mut pos = 1;
        Some(decode_length_prefixed_str(payload, &mut pos)?)
    } else {
        None
    };
    Ok(SessionStateMsg { state_type, error_msg })
}

// ----------------------------------------------------------------------------
// 0x03 — Stream Ended
// ----------------------------------------------------------------------------

/// Encode a StreamEnded payload.
///
/// `reason`: 0=complete, 1=disconnected, 2=error, 3=stopped, 4=paused.
/// Flags byte (bit 0 = buffer_available, bit 1 = has_buffer_id,
///             bit 2 = has_buffer_type, bit 3 = has_time_range).
pub fn encode_stream_ended(
    reason: u8,
    buffer_available: bool,
    buffer_id: Option<&str>,
    buffer_type: Option<&str>,
    count: u32,
    time_range: Option<(u64, u64)>,
) -> Vec<u8> {
    let mut flags: u8 = 0;
    if buffer_available    { flags |= 1 << 0; }
    if buffer_id.is_some() { flags |= 1 << 1; }
    if buffer_type.is_some() { flags |= 1 << 2; }
    if time_range.is_some()  { flags |= 1 << 3; }

    let mut out = Vec::new();
    out.push(reason);
    out.push(flags);
    out.extend_from_slice(&count.to_le_bytes());
    if let Some(id) = buffer_id {
        out.extend_from_slice(&encode_length_prefixed_str(id));
    }
    if let Some(bt) = buffer_type {
        out.extend_from_slice(&encode_length_prefixed_str(bt));
    }
    if let Some((start, end)) = time_range {
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&end.to_le_bytes());
    }
    out
}

// ----------------------------------------------------------------------------
// 0x04 — Session Error
// ----------------------------------------------------------------------------

/// Encode a SessionError payload — entire payload is the raw UTF-8 error string.
pub fn encode_session_error(error: &str) -> Vec<u8> {
    error.as_bytes().to_vec()
}

// ----------------------------------------------------------------------------
// 0x05 — Playback Position
// ----------------------------------------------------------------------------

/// Encode a PlaybackPosition payload — fixed 16 bytes.
pub fn encode_playback_position(timestamp_us: u64, frame_index: u32, frame_count: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&timestamp_us.to_le_bytes());
    out.extend_from_slice(&frame_index.to_le_bytes());
    out.extend_from_slice(&frame_count.to_le_bytes());
    out
}

#[derive(Debug, PartialEq)]
pub struct PlaybackPositionMsg {
    pub timestamp_us: u64,
    pub frame_index: u32,
    pub frame_count: u32,
}

pub fn decode_playback_position(payload: &[u8]) -> Result<PlaybackPositionMsg, ProtocolError> {
    if payload.len() < 16 {
        return Err(ProtocolError::InsufficientData { needed: 16, available: payload.len() });
    }
    let timestamp_us = u64::from_le_bytes(payload[0..8].try_into().unwrap());
    let frame_index  = u32::from_le_bytes(payload[8..12].try_into().unwrap());
    let frame_count  = u32::from_le_bytes(payload[12..16].try_into().unwrap());
    Ok(PlaybackPositionMsg { timestamp_us, frame_index, frame_count })
}

// ----------------------------------------------------------------------------
// 0x06 — Device Connected
// ----------------------------------------------------------------------------

/// Encode a DeviceConnected payload.
///
/// Flags byte: bit 0 = has_bus.
pub fn encode_device_connected(device_type: &str, address: &str, bus: Option<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&encode_length_prefixed_str(device_type));
    out.extend_from_slice(&encode_length_prefixed_str(address));
    let flags: u8 = if bus.is_some() { 1 } else { 0 };
    out.push(flags);
    if let Some(b) = bus {
        out.push(b);
    }
    out
}

// ----------------------------------------------------------------------------
// 0x07 — Buffer Changed
// ----------------------------------------------------------------------------

/// Encode a BufferChanged payload — entire payload is the raw UTF-8 buffer ID.
pub fn encode_buffer_changed(buffer_id: &str) -> Vec<u8> {
    buffer_id.as_bytes().to_vec()
}

// ----------------------------------------------------------------------------
// 0x08 — Session Lifecycle
// ----------------------------------------------------------------------------

/// Encode a SessionLifecycle payload.
///
/// `event_type`: 0=created, 1=destroyed.
/// Flags byte: bit 0 = has_device_type, bit 1 = has_state.
pub fn encode_session_lifecycle(
    event_type: u8,
    session_id: &str,
    device_type: Option<&str>,
    state: Option<u8>,
    listener_count: u16,
) -> Vec<u8> {
    let mut flags: u8 = 0;
    if device_type.is_some() { flags |= 1 << 0; }
    if state.is_some()       { flags |= 1 << 1; }

    let mut out = Vec::new();
    out.push(event_type);
    out.extend_from_slice(&listener_count.to_le_bytes());
    out.extend_from_slice(&encode_length_prefixed_str(session_id));
    out.push(flags);
    if let Some(dt) = device_type {
        out.extend_from_slice(&encode_length_prefixed_str(dt));
    }
    if let Some(s) = state {
        out.push(s);
    }
    out
}

// ----------------------------------------------------------------------------
// 0x09 — Session Info
// ----------------------------------------------------------------------------

/// Encode a SessionInfo payload — fixed 10 bytes: f64 LE + u16 LE.
pub fn encode_session_info(speed: f64, listener_count: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(10);
    out.extend_from_slice(&speed.to_le_bytes());
    out.extend_from_slice(&listener_count.to_le_bytes());
    out
}

#[derive(Debug, PartialEq)]
pub struct SessionInfoMsg {
    pub speed: f64,
    pub listener_count: u16,
}

pub fn decode_session_info(payload: &[u8]) -> Result<SessionInfoMsg, ProtocolError> {
    if payload.len() < 10 {
        return Err(ProtocolError::InsufficientData { needed: 10, available: payload.len() });
    }
    let speed          = f64::from_le_bytes(payload[0..8].try_into().unwrap());
    let listener_count = u16::from_le_bytes(payload[8..10].try_into().unwrap());
    Ok(SessionInfoMsg { speed, listener_count })
}

// ----------------------------------------------------------------------------
// 0x12 — Subscribe Ack
// ----------------------------------------------------------------------------

/// Encode a SubscribeAck payload: channel byte + length-prefixed session_id.
pub fn encode_subscribe_ack(channel: u8, session_id: &str) -> Vec<u8> {
    let mut out = vec![channel];
    out.extend_from_slice(&encode_length_prefixed_str(session_id));
    out
}

#[derive(Debug, PartialEq)]
pub struct SubscribeAckMsg {
    pub channel: u8,
    pub session_id: String,
}

pub fn decode_subscribe_ack(payload: &[u8]) -> Result<SubscribeAckMsg, ProtocolError> {
    if payload.is_empty() {
        return Err(ProtocolError::TooShort);
    }
    let channel = payload[0];
    let mut pos = 1;
    let session_id = decode_length_prefixed_str(payload, &mut pos)?;
    Ok(SubscribeAckMsg { channel, session_id })
}

// ----------------------------------------------------------------------------
// 0x13 — Subscribe Nack
// ----------------------------------------------------------------------------

/// Encode a SubscribeNack payload — entire payload is the raw UTF-8 error string.
pub fn encode_subscribe_nack(error: &str) -> Vec<u8> {
    error.as_bytes().to_vec()
}

// ============================================================================
// Batch encoding
// ============================================================================

pub fn encode_frame_batch(frames: &[crate::io::FrameMessage]) -> Vec<u8> {
    let mut out = Vec::new();
    for frame in frames {
        let direction_tx = frame.direction.as_deref() == Some("tx");

        let (frame_type, inner_data) = if frame.is_fd || frame.protocol == "canfd" {
            let cf = CanFdFrame {
                id: frame.frame_id,
                is_extended: frame.is_extended,
                brs: false,
                direction_tx,
                payload: frame.bytes.clone(),
            };
            (FrameType::CanFd, cf.encode())
        } else if frame.protocol == "can" {
            let cf = CanFrame {
                id: frame.frame_id,
                is_extended: frame.is_extended,
                is_rtr: false,
                direction_tx,
                payload: frame.bytes.clone(),
            };
            (FrameType::Can, cf.encode())
        } else if frame.protocol == "modbus" {
            (FrameType::Modbus, frame.bytes.clone())
        } else {
            // serial and anything else — raw bytes
            (FrameType::Serial, frame.bytes.clone())
        };

        let envelope = FrameEnvelope {
            timestamp_us: frame.timestamp_us,
            bus: frame.bus,
            frame_type,
            data: inner_data,
        };
        out.extend_from_slice(&envelope.encode());
    }
    out
}

// ============================================================================
// Command / CommandResponse  (0x20 / 0x21)
//
// Command payload (client → server):
//   [correlation_id: u32 LE][op_name_len: u16 LE][op_name: UTF-8][params: JSON bytes]
//
// CommandResponse payload (server → client):
//   [correlation_id: u32 LE][status: u8 (0=ok, 1=error)][payload: JSON bytes or error string]
// ============================================================================

pub struct CommandMsg {
    pub correlation_id: u32,
    pub op_name: String,
    pub params: Vec<u8>,
}

pub fn decode_command(payload: &[u8]) -> Result<CommandMsg, ProtocolError> {
    if payload.len() < 6 {
        return Err(ProtocolError::InsufficientData {
            needed: 6,
            available: payload.len(),
        });
    }
    let correlation_id = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let op_name_len = u16::from_le_bytes([payload[4], payload[5]]) as usize;
    let op_start = 6;
    let op_end = op_start + op_name_len;
    if payload.len() < op_end {
        return Err(ProtocolError::InsufficientData {
            needed: op_end,
            available: payload.len(),
        });
    }
    let op_name = std::str::from_utf8(&payload[op_start..op_end])
        .map_err(|_| ProtocolError::TooShort)?
        .to_string();
    let params = payload[op_end..].to_vec();
    Ok(CommandMsg {
        correlation_id,
        op_name,
        params,
    })
}

pub fn encode_command_response(correlation_id: u32, status: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&correlation_id.to_le_bytes());
    out.push(status);
    out.extend_from_slice(payload);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let original = Header::new(MsgType::FrameData, 3);
        let encoded = original.encode();
        let decoded = Header::decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn version_in_high_nibble() {
        let header = Header::new(MsgType::Heartbeat, 0);
        let encoded = header.encode();
        assert_eq!(encoded[0] >> 4, PROTOCOL_VERSION);
    }

    #[test]
    fn flags_in_low_nibble() {
        let header = Header {
            version: PROTOCOL_VERSION,
            flags: 0x0B,
            msg_type: MsgType::Auth,
            channel: 0,
        };
        let encoded = header.encode();
        assert_eq!(encoded[0] & 0x0F, 0x0B);
        // Version must still be intact in the high nibble.
        assert_eq!(encoded[0] >> 4, PROTOCOL_VERSION);
    }

    #[test]
    fn all_msg_types_round_trip() {
        let types = [
            MsgType::FrameData,
            MsgType::SessionState,
            MsgType::StreamEnded,
            MsgType::SessionError,
            MsgType::PlaybackPosition,
            MsgType::DeviceConnected,
            MsgType::BufferChanged,
            MsgType::SessionLifecycle,
            MsgType::SessionInfo,
            MsgType::Reconfigured,
            MsgType::TransmitUpdated,
            MsgType::ReplayState,
            MsgType::Subscribe,
            MsgType::Unsubscribe,
            MsgType::SubscribeAck,
            MsgType::SubscribeNack,
            MsgType::Heartbeat,
            MsgType::Auth,
        ];

        for msg_type in types {
            let raw = msg_type as u8;
            let decoded = MsgType::try_from(raw).expect("round-trip failed");
            assert_eq!(decoded, msg_type, "failed for {msg_type:?}");
        }
    }

    #[test]
    fn invalid_msg_type_returns_error() {
        let result = MsgType::try_from(0x42u8);
        assert_eq!(result, Err(ProtocolError::InvalidMsgType(0x42)));
    }

    #[test]
    fn too_short_buffer_returns_error() {
        let result = Header::decode(&[0x10, 0x01]);
        assert_eq!(result, Err(ProtocolError::TooShort));
    }

    #[test]
    fn encode_message_length() {
        let payload = b"hello";
        let msg = encode_message(MsgType::SessionInfo, 1, payload);
        assert_eq!(msg.len(), HEADER_SIZE + payload.len());
    }

    // -----------------------------------------------------------------------
    // FrameType
    // -----------------------------------------------------------------------

    #[test]
    fn frame_type_round_trip() {
        for (raw, expected) in [(0x0001u16, FrameType::Can), (0x0002, FrameType::CanFd), (0x0003, FrameType::Modbus), (0x0004, FrameType::Serial)] {
            assert_eq!(FrameType::try_from(raw).unwrap(), expected);
            assert_eq!(expected as u16, raw);
        }
    }

    #[test]
    fn invalid_frame_type_returns_error() {
        assert_eq!(FrameType::try_from(0x00FFu16), Err(ProtocolError::InvalidFrameType(0x00FF)));
    }

    // -----------------------------------------------------------------------
    // CAN 2.0 round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn can_11bit_id_round_trip() {
        let frame = CanFrame { id: 0x123, is_extended: false, is_rtr: false, direction_tx: false, payload: vec![0xDE, 0xAD] };
        let encoded = frame.encode();
        let decoded = CanFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.id, 0x123);
        assert!(!decoded.is_extended);
        assert!(!decoded.is_rtr);
        assert!(!decoded.direction_tx);
        assert_eq!(decoded.payload, vec![0xDE, 0xAD]);
    }

    #[test]
    fn can_29bit_extended_id_round_trip() {
        let frame = CanFrame { id: 0x1FFF_FFFF, is_extended: true, is_rtr: false, direction_tx: true, payload: vec![1, 2, 3, 4, 5, 6, 7, 8] };
        let encoded = frame.encode();
        let decoded = CanFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.id, 0x1FFF_FFFF);
        assert!(decoded.is_extended);
        assert!(!decoded.is_rtr);
        assert!(decoded.direction_tx);
        assert_eq!(decoded.payload.len(), 8);
    }

    #[test]
    fn can_rtr_flag_round_trip() {
        let frame = CanFrame { id: 0x7FF, is_extended: false, is_rtr: true, direction_tx: false, payload: vec![] };
        let encoded = frame.encode();
        let decoded = CanFrame::decode(&encoded).unwrap();
        assert!(decoded.is_rtr);
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn can_dlc_zero_round_trip() {
        let frame = CanFrame { id: 0x100, is_extended: false, is_rtr: false, direction_tx: false, payload: vec![] };
        let encoded = frame.encode();
        assert_eq!(encoded.len(), 4);
        let decoded = CanFrame::decode(&encoded).unwrap();
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn can_decode_too_short_returns_error() {
        let result = CanFrame::decode(&[0x01, 0x02, 0x03]);
        assert_eq!(result, Err(ProtocolError::InsufficientData { needed: 4, available: 3 }));
    }

    // -----------------------------------------------------------------------
    // CAN-FD round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn canfd_max_payload_round_trip() {
        let payload: Vec<u8> = (0u8..64).collect();
        let frame = CanFdFrame { id: 0x1ABCDEF, is_extended: true, brs: true, direction_tx: false, payload: payload.clone() };
        let encoded = frame.encode();
        let decoded = CanFdFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.id, 0x1ABCDEF);
        assert!(decoded.is_extended);
        assert!(decoded.brs);
        assert!(!decoded.direction_tx);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn canfd_brs_flag_independent_of_rtr() {
        // brs lives in bit 30; verify it does not alias is_extended (bit 29)
        let frame = CanFdFrame { id: 0x100, is_extended: false, brs: true, direction_tx: false, payload: vec![0xFF] };
        let encoded = frame.encode();
        let decoded = CanFdFrame::decode(&encoded).unwrap();
        assert!(!decoded.is_extended);
        assert!(decoded.brs);
    }

    // -----------------------------------------------------------------------
    // FrameEnvelope round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn envelope_round_trip_can() {
        let inner = CanFrame { id: 0x42, is_extended: false, is_rtr: false, direction_tx: false, payload: vec![0xAA, 0xBB] }.encode();
        let env = FrameEnvelope { timestamp_us: 1_000_000, bus: 2, frame_type: FrameType::Can, data: inner };
        let encoded = env.encode();
        assert_eq!(encoded.len(), ENVELOPE_HEADER_SIZE + 4 + 2);
        let (decoded, consumed) = FrameEnvelope::decode(&encoded).unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded.timestamp_us, 1_000_000);
        assert_eq!(decoded.bus, 2);
        assert_eq!(decoded.frame_type, FrameType::Can);
        assert_eq!(decoded.data, env.data);
    }

    #[test]
    fn envelope_decode_insufficient_header_returns_error() {
        let short = [0u8; 5];
        let result = FrameEnvelope::decode(&short);
        assert_eq!(result, Err(ProtocolError::InsufficientData { needed: ENVELOPE_HEADER_SIZE, available: 5 }));
    }

    #[test]
    fn envelope_decode_insufficient_body_returns_error() {
        // Valid 12-byte header claiming 10 bytes of data, but buffer ends there
        let mut buf = vec![0u8; ENVELOPE_HEADER_SIZE];
        // timestamp = 0, bus = 0
        buf[9]  = 0x01; // frame_type low byte = Can
        buf[10] = 0x00; // frame_type high byte
        buf[11] = 10;   // len = 10, but no body follows
        let result = FrameEnvelope::decode(&buf);
        assert_eq!(result, Err(ProtocolError::InsufficientData { needed: ENVELOPE_HEADER_SIZE + 10, available: ENVELOPE_HEADER_SIZE }));
    }

    #[test]
    fn envelope_serial_raw_bytes() {
        let raw = b"hello world".to_vec();
        let env = FrameEnvelope { timestamp_us: 42, bus: 0, frame_type: FrameType::Serial, data: raw.clone() };
        let encoded = env.encode();
        let (decoded, _) = FrameEnvelope::decode(&encoded).unwrap();
        assert_eq!(decoded.frame_type, FrameType::Serial);
        assert_eq!(decoded.data, raw);
    }

    #[test]
    fn multiple_envelopes_decoded_sequentially() {
        let env1 = FrameEnvelope { timestamp_us: 100, bus: 0, frame_type: FrameType::Can, data: vec![1, 2, 3, 4] };
        let env2 = FrameEnvelope { timestamp_us: 200, bus: 1, frame_type: FrameType::Serial, data: b"abc".to_vec() };

        let mut batch = env1.encode();
        batch.extend_from_slice(&env2.encode());

        let (d1, n1) = FrameEnvelope::decode(&batch).unwrap();
        assert_eq!(d1.timestamp_us, 100);

        let (d2, n2) = FrameEnvelope::decode(&batch[n1..]).unwrap();
        assert_eq!(d2.timestamp_us, 200);
        assert_eq!(d2.frame_type, FrameType::Serial);

        assert_eq!(n1 + n2, batch.len());
    }

    // -----------------------------------------------------------------------
    // encode_frame_batch
    // -----------------------------------------------------------------------

    fn make_frame_message(protocol: &str, is_fd: bool, frame_id: u32, bus: u8, bytes: Vec<u8>, direction: Option<&str>) -> crate::io::FrameMessage {
        crate::io::FrameMessage {
            protocol: protocol.to_string(),
            timestamp_us: 999,
            frame_id,
            bus,
            dlc: bytes.len() as u8,
            bytes,
            is_extended: false,
            is_fd,
            source_address: None,
            incomplete: None,
            direction: direction.map(|s| s.to_string()),
        }
    }

    #[test]
    fn batch_empty_returns_empty_vec() {
        assert!(encode_frame_batch(&[]).is_empty());
    }

    #[test]
    fn batch_can_frame_encodes_correctly() {
        let msg = make_frame_message("can", false, 0x123, 0, vec![0xAA, 0xBB], Some("rx"));
        let batch = encode_frame_batch(&[msg]);
        let (env, consumed) = FrameEnvelope::decode(&batch).unwrap();
        assert_eq!(consumed, batch.len());
        assert_eq!(env.frame_type, FrameType::Can);
        let cf = CanFrame::decode(&env.data).unwrap();
        assert_eq!(cf.id, 0x123);
        assert!(!cf.direction_tx);
        assert_eq!(cf.payload, vec![0xAA, 0xBB]);
    }

    #[test]
    fn batch_canfd_frame_encodes_correctly() {
        let payload: Vec<u8> = (0u8..64).collect();
        let msg = make_frame_message("can", true, 0x1FF, 1, payload.clone(), Some("tx"));
        let batch = encode_frame_batch(&[msg]);
        let (env, _) = FrameEnvelope::decode(&batch).unwrap();
        assert_eq!(env.frame_type, FrameType::CanFd);
        let cf = CanFdFrame::decode(&env.data).unwrap();
        assert_eq!(cf.id, 0x1FF);
        assert!(cf.direction_tx);
        assert_eq!(cf.payload, payload);
    }

    #[test]
    fn batch_serial_frame_encodes_correctly() {
        let msg = make_frame_message("serial", false, 0, 0, b"raw bytes".to_vec(), None);
        let batch = encode_frame_batch(&[msg]);
        let (env, _) = FrameEnvelope::decode(&batch).unwrap();
        assert_eq!(env.frame_type, FrameType::Serial);
        assert_eq!(env.data, b"raw bytes");
    }

    #[test]
    fn batch_mixed_types_decoded_sequentially() {
        let can_msg   = make_frame_message("can",    false, 0x100, 0, vec![1, 2], None);
        let fd_msg    = make_frame_message("canfd",  false, 0x200, 0, vec![3, 4], None);
        let ser_msg   = make_frame_message("serial", false, 0,     0, b"hi".to_vec(), None);

        let batch = encode_frame_batch(&[can_msg, fd_msg, ser_msg]);

        let (e1, n1) = FrameEnvelope::decode(&batch).unwrap();
        let (e2, n2) = FrameEnvelope::decode(&batch[n1..]).unwrap();
        let (e3, n3) = FrameEnvelope::decode(&batch[n1 + n2..]).unwrap();

        assert_eq!(e1.frame_type, FrameType::Can);
        assert_eq!(e2.frame_type, FrameType::CanFd);
        assert_eq!(e3.frame_type, FrameType::Serial);
        assert_eq!(n1 + n2 + n3, batch.len());
    }

    // -----------------------------------------------------------------------
    // encode_length_prefixed_str / decode_length_prefixed_str
    // -----------------------------------------------------------------------

    #[test]
    fn length_prefixed_str_round_trip() {
        for s in ["", "hello", "café", "a".repeat(300).as_str()] {
            let encoded = encode_length_prefixed_str(s);
            let mut pos = 0;
            let decoded = decode_length_prefixed_str(&encoded, &mut pos).unwrap();
            assert_eq!(decoded, s);
            assert_eq!(pos, encoded.len());
        }
    }

    #[test]
    fn length_prefixed_str_too_short_returns_error() {
        // Only the length prefix bytes, no body
        let buf = 5u16.to_le_bytes();
        let mut pos = 0;
        let result = decode_length_prefixed_str(&buf, &mut pos);
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // 0x02 Session State
    // -----------------------------------------------------------------------

    #[test]
    fn session_state_stopped_round_trip() {
        let payload = encode_session_state(0, None);
        let msg = decode_session_state(&payload).unwrap();
        assert_eq!(msg.state_type, 0);
        assert_eq!(msg.error_msg, None);
    }

    #[test]
    fn session_state_running_round_trip() {
        let payload = encode_session_state(2, None);
        let msg = decode_session_state(&payload).unwrap();
        assert_eq!(msg.state_type, 2);
        assert_eq!(msg.error_msg, None);
    }

    #[test]
    fn session_state_error_with_message_round_trip() {
        let payload = encode_session_state(4, Some("device lost"));
        let msg = decode_session_state(&payload).unwrap();
        assert_eq!(msg.state_type, 4);
        assert_eq!(msg.error_msg.as_deref(), Some("device lost"));
    }

    #[test]
    fn session_state_error_with_empty_message_round_trip() {
        let payload = encode_session_state(4, Some(""));
        let msg = decode_session_state(&payload).unwrap();
        assert_eq!(msg.state_type, 4);
        assert_eq!(msg.error_msg.as_deref(), Some(""));
    }

    #[test]
    fn session_state_error_with_none_message_round_trip() {
        // None error_msg on an Error state should still produce a decodable payload.
        let payload = encode_session_state(4, None);
        let msg = decode_session_state(&payload).unwrap();
        assert_eq!(msg.state_type, 4);
        assert_eq!(msg.error_msg.as_deref(), Some(""));
    }

    #[test]
    fn session_state_empty_payload_returns_error() {
        assert_eq!(decode_session_state(&[]), Err(ProtocolError::TooShort));
    }

    // -----------------------------------------------------------------------
    // 0x03 Stream Ended
    // -----------------------------------------------------------------------

    #[test]
    fn stream_ended_minimal_round_trip() {
        // reason=0, no buffer, no time range
        let payload = encode_stream_ended(0, false, None, None, 42, None);
        // Manual decode to verify layout
        assert_eq!(payload[0], 0);    // reason
        assert_eq!(payload[1], 0);    // flags: all clear
        assert_eq!(u32::from_le_bytes(payload[2..6].try_into().unwrap()), 42);
        assert_eq!(payload.len(), 6);
    }

    #[test]
    fn stream_ended_all_optional_fields_present() {
        let payload = encode_stream_ended(
            2,
            true,
            Some("buf-001"),
            Some("recording"),
            100,
            Some((1000, 2000)),
        );
        assert_eq!(payload[0], 2); // reason
        let flags = payload[1];
        assert!(flags & (1 << 0) != 0, "buffer_available");
        assert!(flags & (1 << 1) != 0, "has_buffer_id");
        assert!(flags & (1 << 2) != 0, "has_buffer_type");
        assert!(flags & (1 << 3) != 0, "has_time_range");

        let count = u32::from_le_bytes(payload[2..6].try_into().unwrap());
        assert_eq!(count, 100);

        let mut pos = 6usize;
        let buf_id = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        assert_eq!(buf_id, "buf-001");
        let buf_type = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        assert_eq!(buf_type, "recording");

        let start = u64::from_le_bytes(payload[pos..pos + 8].try_into().unwrap());
        let end   = u64::from_le_bytes(payload[pos + 8..pos + 16].try_into().unwrap());
        assert_eq!(start, 1000);
        assert_eq!(end,   2000);
    }

    #[test]
    fn stream_ended_buffer_available_flag_only() {
        let payload = encode_stream_ended(3, true, None, None, 0, None);
        assert_eq!(payload[1] & (1 << 0), 1);  // buffer_available set
        assert_eq!(payload[1] & !(1u8),   0);  // no other flags
    }

    // -----------------------------------------------------------------------
    // 0x04 Session Error
    // -----------------------------------------------------------------------

    #[test]
    fn session_error_encodes_raw_bytes() {
        let payload = encode_session_error("something went wrong");
        assert_eq!(payload, b"something went wrong");
    }

    #[test]
    fn session_error_empty_string() {
        let payload = encode_session_error("");
        assert!(payload.is_empty());
    }

    // -----------------------------------------------------------------------
    // 0x05 Playback Position
    // -----------------------------------------------------------------------

    #[test]
    fn playback_position_round_trip() {
        let payload = encode_playback_position(9_876_543_210, 1234, 9999);
        assert_eq!(payload.len(), 16);
        let msg = decode_playback_position(&payload).unwrap();
        assert_eq!(msg.timestamp_us, 9_876_543_210);
        assert_eq!(msg.frame_index, 1234);
        assert_eq!(msg.frame_count, 9999);
    }

    #[test]
    fn playback_position_zero_values() {
        let payload = encode_playback_position(0, 0, 0);
        let msg = decode_playback_position(&payload).unwrap();
        assert_eq!(msg, PlaybackPositionMsg { timestamp_us: 0, frame_index: 0, frame_count: 0 });
    }

    #[test]
    fn playback_position_max_values() {
        let payload = encode_playback_position(u64::MAX, u32::MAX, u32::MAX);
        let msg = decode_playback_position(&payload).unwrap();
        assert_eq!(msg.timestamp_us, u64::MAX);
        assert_eq!(msg.frame_index,  u32::MAX);
        assert_eq!(msg.frame_count,  u32::MAX);
    }

    #[test]
    fn playback_position_too_short_returns_error() {
        let result = decode_playback_position(&[0u8; 10]);
        assert_eq!(result, Err(ProtocolError::InsufficientData { needed: 16, available: 10 }));
    }

    // -----------------------------------------------------------------------
    // 0x06 Device Connected
    // -----------------------------------------------------------------------

    #[test]
    fn device_connected_with_bus_round_trip() {
        let payload = encode_device_connected("gvret", "192.168.1.100:23", Some(1));
        let mut pos = 0;
        let dt  = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let addr = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let flags = payload[pos]; pos += 1;
        assert_eq!(dt,   "gvret");
        assert_eq!(addr, "192.168.1.100:23");
        assert!(flags & 1 != 0, "has_bus flag");
        assert_eq!(payload[pos], 1);
    }

    #[test]
    fn device_connected_without_bus() {
        let payload = encode_device_connected("slcan", "/dev/tty.usbserial", None);
        let mut pos = 0;
        let _ = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let _ = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let flags = payload[pos];
        assert_eq!(flags & 1, 0, "has_bus should be clear");
        assert_eq!(payload.len(), pos + 1); // flags byte only, no bus byte
    }

    #[test]
    fn device_connected_empty_strings() {
        let payload = encode_device_connected("", "", None);
        let mut pos = 0;
        let dt   = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let addr = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        assert!(dt.is_empty());
        assert!(addr.is_empty());
    }

    // -----------------------------------------------------------------------
    // 0x07 Buffer Changed
    // -----------------------------------------------------------------------

    #[test]
    fn buffer_changed_encodes_raw_bytes() {
        let payload = encode_buffer_changed("live-session-42");
        assert_eq!(payload, b"live-session-42");
    }

    #[test]
    fn buffer_changed_empty_id() {
        assert!(encode_buffer_changed("").is_empty());
    }

    // -----------------------------------------------------------------------
    // 0x08 Session Lifecycle
    // -----------------------------------------------------------------------

    #[test]
    fn session_lifecycle_created_full_round_trip() {
        let payload = encode_session_lifecycle(0, "sess-abc", Some("gvret"), Some(2), 3);
        let mut pos = 0usize;

        let event_type     = payload[pos]; pos += 1;
        let listener_count = u16::from_le_bytes(payload[pos..pos + 2].try_into().unwrap()); pos += 2;
        let session_id     = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let flags          = payload[pos]; pos += 1;
        let device_type    = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let state          = payload[pos];

        assert_eq!(event_type,     0);
        assert_eq!(listener_count, 3);
        assert_eq!(session_id,     "sess-abc");
        assert!(flags & (1 << 0) != 0, "has_device_type");
        assert!(flags & (1 << 1) != 0, "has_state");
        assert_eq!(device_type, "gvret");
        assert_eq!(state, 2);
    }

    #[test]
    fn session_lifecycle_destroyed_no_optionals() {
        let payload = encode_session_lifecycle(1, "sess-xyz", None, None, 0);
        let mut pos = 0usize;

        let event_type     = payload[pos]; pos += 1;
        let listener_count = u16::from_le_bytes(payload[pos..pos + 2].try_into().unwrap()); pos += 2;
        let session_id     = decode_length_prefixed_str(&payload, &mut pos).unwrap();
        let flags          = payload[pos];

        assert_eq!(event_type,     1);
        assert_eq!(listener_count, 0);
        assert_eq!(session_id,     "sess-xyz");
        assert_eq!(flags,          0);
        // No further bytes expected after flags
        assert_eq!(pos + 1, payload.len());
    }

    // -----------------------------------------------------------------------
    // 0x09 Session Info
    // -----------------------------------------------------------------------

    #[test]
    fn session_info_round_trip() {
        let payload = encode_session_info(2.5, 7);
        assert_eq!(payload.len(), 10);
        let msg = decode_session_info(&payload).unwrap();
        assert!((msg.speed - 2.5).abs() < f64::EPSILON);
        assert_eq!(msg.listener_count, 7);
    }

    #[test]
    fn session_info_zero_values() {
        let payload = encode_session_info(0.0, 0);
        let msg = decode_session_info(&payload).unwrap();
        assert_eq!(msg, SessionInfoMsg { speed: 0.0, listener_count: 0 });
    }

    #[test]
    fn session_info_too_short_returns_error() {
        let result = decode_session_info(&[0u8; 8]);
        assert_eq!(result, Err(ProtocolError::InsufficientData { needed: 10, available: 8 }));
    }

    // -----------------------------------------------------------------------
    // 0x12 Subscribe Ack
    // -----------------------------------------------------------------------

    #[test]
    fn subscribe_ack_round_trip() {
        let payload = encode_subscribe_ack(3, "session-999");
        let msg = decode_subscribe_ack(&payload).unwrap();
        assert_eq!(msg.channel, 3);
        assert_eq!(msg.session_id, "session-999");
    }

    #[test]
    fn subscribe_ack_channel_zero_empty_session_id() {
        let payload = encode_subscribe_ack(0, "");
        let msg = decode_subscribe_ack(&payload).unwrap();
        assert_eq!(msg.channel, 0);
        assert!(msg.session_id.is_empty());
    }

    #[test]
    fn subscribe_ack_max_channel() {
        let payload = encode_subscribe_ack(255, "ch255-session");
        let msg = decode_subscribe_ack(&payload).unwrap();
        assert_eq!(msg.channel, 255);
        assert_eq!(msg.session_id, "ch255-session");
    }

    #[test]
    fn subscribe_ack_empty_payload_returns_error() {
        assert_eq!(decode_subscribe_ack(&[]), Err(ProtocolError::TooShort));
    }

    // -----------------------------------------------------------------------
    // 0x13 Subscribe Nack
    // -----------------------------------------------------------------------

    #[test]
    fn subscribe_nack_encodes_raw_bytes() {
        let payload = encode_subscribe_nack("session not found");
        assert_eq!(payload, b"session not found");
    }

    #[test]
    fn subscribe_nack_empty_error() {
        assert!(encode_subscribe_nack("").is_empty());
    }
}
