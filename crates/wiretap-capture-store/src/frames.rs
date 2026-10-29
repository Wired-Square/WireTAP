use crate::filter::CaptureProtocol;
use crate::model::Direction;

/// A frame's stored length: older rows hold a CAN FD length code in `dlc`,
/// always below the payload's length, and an RTR's `dlc` is its requested length.
pub const STORED_LENGTH: &str = "MAX(dlc, length(payload))";

/// One `frames` row: a CAN, CAN FD, Modbus or serial frame.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredFrame {
    /// Open, so a row written under a protocol this build doesn't know reads back as it was.
    pub protocol: String,
    pub timestamp_us: u64,
    pub frame_id: u32,
    pub bus: u8,
    /// A length, not a length code; an RTR's is the length it asks for.
    pub len: u16,
    pub payload: Vec<u8>,
    pub extended: bool,
    pub fd: bool,
    pub rtr: bool,
    pub brs: bool,
    pub esi: bool,
    pub source_address: Option<u16>,
    pub incomplete: Option<bool>,
    pub direction: Option<Direction>,
    /// Whether a Modbus RTU message's CRC matched; `None` where nothing checked one.
    pub crc_valid: Option<bool>,
}

impl StoredFrame {
    /// The protocol, `None` when it isn't one a capture stores.
    pub fn capture_protocol(&self) -> Option<CaptureProtocol> {
        CaptureProtocol::from_stored(&self.protocol)
    }
}

/// A frame as an insert reads it, borrowed so an application's own frame type
/// goes in without a copy.
pub trait FrameRecord {
    fn protocol(&self) -> &str;
    fn timestamp_us(&self) -> u64;
    fn frame_id(&self) -> u32;
    fn bus(&self) -> u8;
    /// See [`StoredFrame::len`].
    fn length(&self) -> u16;
    fn payload(&self) -> &[u8];
    fn extended(&self) -> bool;
    fn fd(&self) -> bool;
    fn rtr(&self) -> bool;
    fn brs(&self) -> bool;
    fn esi(&self) -> bool;
    fn source_address(&self) -> Option<u16>;
    fn incomplete(&self) -> Option<bool>;
    fn direction(&self) -> Option<Direction>;
    fn crc_valid(&self) -> Option<bool> {
        None
    }
}

impl FrameRecord for StoredFrame {
    fn protocol(&self) -> &str {
        &self.protocol
    }
    fn timestamp_us(&self) -> u64 {
        self.timestamp_us
    }
    fn frame_id(&self) -> u32 {
        self.frame_id
    }
    fn bus(&self) -> u8 {
        self.bus
    }
    fn length(&self) -> u16 {
        self.len
    }
    fn payload(&self) -> &[u8] {
        &self.payload
    }
    fn extended(&self) -> bool {
        self.extended
    }
    fn fd(&self) -> bool {
        self.fd
    }
    fn rtr(&self) -> bool {
        self.rtr
    }
    fn brs(&self) -> bool {
        self.brs
    }
    fn esi(&self) -> bool {
        self.esi
    }
    fn source_address(&self) -> Option<u16> {
        self.source_address
    }
    fn incomplete(&self) -> Option<bool> {
        self.incomplete
    }
    fn direction(&self) -> Option<Direction> {
        self.direction
    }
    fn crc_valid(&self) -> Option<bool> {
        self.crc_valid
    }
}

#[cfg(test)]
pub(crate) fn can_frame(frame_id: u32, payload: &[u8]) -> StoredFrame {
    StoredFrame {
        protocol: "can".into(),
        frame_id,
        len: payload.len() as u16,
        payload: payload.to_vec(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_known_protocol_is_a_capture_protocol() {
        let modbus = StoredFrame {
            protocol: "modbus".into(),
            ..can_frame(3, &[0, 1])
        };
        assert_eq!(modbus.capture_protocol(), Some(CaptureProtocol::Modbus));
        let unknown = StoredFrame {
            protocol: "lin".into(),
            ..can_frame(3, &[0, 1])
        };
        assert_eq!(unknown.capture_protocol(), None);
    }
}
