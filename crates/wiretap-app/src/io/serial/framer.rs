// ui/crates/wiretap-app/src/io/serial/framer.rs
//
// Serial framing: SLIP and delimiter from `wiretap_protocol`, Modbus RTU from
// `wiretap_catalog`, behind one enum.

use serde::{Deserialize, Serialize};

use wiretap_catalog::{Catalog, ModbusRtuMessage, ModbusRtuStream};
use wiretap_decode::frame_id::{extract_frame_id, FrameIdField, FrameIdWidth};
use wiretap_decode::Endianness;
pub use wiretap_protocol::framing::DelimiterOptions;
use wiretap_protocol::framing::{DelimiterFramer, Framed};
use wiretap_protocol::slip::SlipDecoder;

use crate::io::device_kinds::degenerate_framing_field;
use crate::io::types::ModbusRtuOptions;

// =============================================================================
// Types
// =============================================================================

/// Framing encoding types
#[derive(Debug, Clone, PartialEq)]
pub enum FramingEncoding {
    /// Delimiter-based framing
    Delimiter(DelimiterOptions),
    /// SLIP framing (RFC 1055); a frame outgrowing `max_frame_len` is abandoned
    Slip { max_frame_len: usize },
    /// Modbus RTU framing
    ModbusRtu(ModbusRtuOptions),
    /// Raw mode - no framing, emit bytes as read
    Raw,
}

impl Default for FramingEncoding {
    fn default() -> Self {
        FramingEncoding::Slip { max_frame_len: 1024 }
    }
}

/// A complete frame extracted from the serial stream
#[derive(Debug, Clone)]
pub struct SerialFrame {
    /// Frame data bytes
    pub bytes: Vec<u8>,
    /// Whether these bytes are a leftover rather than a message: no delimiter
    /// was found before the stream ended.
    pub incomplete: bool,
    /// For Modbus RTU: whether the message's CRC matched. `None` means the
    /// question does not apply — another encoding, or a trailing residue that is
    /// not a message at all.
    pub crc_valid: Option<bool>,
    /// Bytes fed through this frame's last byte. A Modbus RTU message buffered
    /// before the framer synced is released by a later byte.
    pub end_offset: u64,
}

/// Configuration for extracting frame ID from frame bytes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FrameIdConfig {
    /// Start byte index (negative = from end)
    pub start_byte: i32,
    /// Number of bytes for frame ID (1 or 2)
    pub num_bytes: u8,
    /// Whether to interpret as big-endian
    pub big_endian: bool,
}

impl Default for FrameIdConfig {
    fn default() -> Self {
        FrameIdConfig {
            start_byte: 0,
            num_bytes: 1,
            big_endian: false,
        }
    }
}

impl FrameIdConfig {
    /// `None` for a width other than 1 or 2, which extracts nothing.
    pub fn field(&self) -> Option<FrameIdField> {
        let width = match self.num_bytes {
            1 => FrameIdWidth::One,
            2 => FrameIdWidth::Two(if self.big_endian {
                Endianness::Big
            } else {
                Endianness::Little
            }),
            _ => return None,
        };
        Some(FrameIdField {
            start_byte: self.start_byte,
            width,
        })
    }

    pub fn extract(&self, frame: &[u8]) -> Option<u32> {
        extract_frame_id(frame, &self.field()?)
    }
}

impl FramingEncoding {
    /// Refuses a framing that would release every byte as its own frame.
    pub fn checked(self) -> Result<Self, String> {
        let field = match &self {
            Self::Delimiter(o) => {
                degenerate_framing_field(Some(&o.delimiter), Some(o.max_length as i64))
            }
            Self::Slip { max_frame_len } => {
                degenerate_framing_field(None, Some(*max_frame_len as i64))
            }
            Self::ModbusRtu(_) | Self::Raw => None,
        };
        field.map_or(Ok(self), |field| {
            Err(format!("Serial framing: '{field}' would release every byte as its own frame"))
        })
    }
}

/// The trailing bytes at end of stream, when there are any: not a message, and
/// marked as such.
pub(super) fn residue(bytes: Vec<u8>, end_offset: u64) -> Vec<SerialFrame> {
    if bytes.is_empty() {
        return Vec::new();
    }
    vec![SerialFrame {
        bytes,
        incomplete: true,
        crc_valid: None,
        end_offset,
    }]
}

fn complete(framed: Framed) -> SerialFrame {
    SerialFrame {
        bytes: framed.bytes,
        incomplete: false,
        crc_valid: None,
        end_offset: framed.end_offset,
    }
}

/// One reassembled message as a frame. The CRC verdict rides along: under a
/// lenient policy it is the only thing distinguishing a recovered message from a
/// guessed one.
pub(super) fn rtu_frame(msg: ModbusRtuMessage) -> SerialFrame {
    SerialFrame {
        bytes: msg.raw,
        incomplete: false,
        crc_valid: Some(msg.crc_valid),
        end_offset: msg.end_offset,
    }
}

/// Stateful serial framer for streaming data. Modbus RTU goes through
/// [`ModbusRtuStream`], the same reassembler the CAN tunnel path uses.
pub enum SerialFramer {
    Delimiter(DelimiterFramer),
    Slip(SlipDecoder),
    Rtu(ModbusRtuStream),
}

impl SerialFramer {
    /// `None` for [`FramingEncoding::Raw`], which is unframed.
    pub fn new(encoding: FramingEncoding) -> Option<Self> {
        Self::with_catalog(encoding, None)
    }

    /// Modbus RTU framing takes `catalog`'s declared function codes too.
    pub fn with_catalog(encoding: FramingEncoding, catalog: Option<&Catalog>) -> Option<Self> {
        Some(match encoding {
            FramingEncoding::Delimiter(options) => Self::Delimiter(DelimiterFramer::new(options)),
            FramingEncoding::Slip { max_frame_len } => {
                Self::Slip(SlipDecoder::with_max_frame_len(max_frame_len))
            }
            FramingEncoding::ModbusRtu(opts) => Self::Rtu(opts.with_catalog(catalog).stream()),
            FramingEncoding::Raw => return None,
        })
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<SerialFrame> {
        match self {
            Self::Delimiter(framer) => framer.feed(data).into_iter().map(complete).collect(),
            Self::Slip(decoder) => {
                let abandoned = decoder.abandoned_frames();
                let frames = decoder.feed(data).into_iter().map(complete).collect();
                if decoder.abandoned_frames() > abandoned {
                    tlog!(
                        "[serial] SLIP frame outgrew the frame cap without an END ({} abandoned)",
                        decoder.abandoned_frames()
                    );
                }
                frames
            }
            Self::Rtu(stream) => stream.push_bytes(data).into_iter().map(rtu_frame).collect(),
        }
    }

    pub fn bytes_fed(&self) -> u64 {
        match self {
            Self::Delimiter(framer) => framer.bytes_fed(),
            Self::Slip(decoder) => decoder.bytes_fed(),
            Self::Rtu(stream) => stream.bytes_fed(),
        }
    }

    /// Flush at end of stream. Modbus RTU can still recover whole messages from
    /// what it holds, so this returns those first and the residue last; the
    /// other encodings only ever have a residue.
    pub fn flush(&mut self) -> Vec<SerialFrame> {
        let framed = match self {
            Self::Delimiter(framer) => framer.flush(),
            Self::Slip(decoder) => decoder.flush(),
            Self::Rtu(stream) => {
                let (messages, trailing) = stream.finish();
                let end_offset = stream.bytes_fed();
                return messages
                    .into_iter()
                    .map(rtu_frame)
                    .chain(residue(trailing, end_offset))
                    .collect();
            }
        };
        framed
            .into_iter()
            .flat_map(|f| residue(f.bytes, f.end_offset))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flushed_residue_is_incomplete() {
        let mut framer = SerialFramer::new(FramingEncoding::default()).unwrap();
        assert!(framer.feed(&[0x01, 0x02, 0x03]).is_empty());

        let flushed = framer.flush();
        assert_eq!(flushed.len(), 1);
        assert!(flushed[0].incomplete);
        assert_eq!(flushed[0].bytes, vec![0x01, 0x02, 0x03]);
    }
}
