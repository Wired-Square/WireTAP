//! Wire codec for the WireTAP binary ingest protocol (docs/ingest-protocol.md).
//! All integers little-endian; every message is
//! `len u16 | type u8 | body | crc32 u32` with the CRC over type+body.

pub const PROTO_VERSION: u8 = 1;
pub const MAGIC: &[u8; 4] = b"WTAP";

pub const MSG_HELLO: u8 = 0x01;
pub const MSG_BATCH: u8 = 0x02;
pub const MSG_PING: u8 = 0x03;
pub const MSG_HELLO_ACK: u8 = 0x81;
pub const MSG_ACK: u8 = 0x82;
pub const MSG_PONG: u8 = 0x83;

pub const HELLO_FLAG_TIME_RELATIVE: u8 = 0x01;

pub const HELLO_OK: u8 = 0;
pub const HELLO_BAD_AUTH: u8 = 1;
pub const HELLO_BAD_VERSION: u8 = 2;
pub const HELLO_BAD_DATABASE: u8 = 3;

pub const ACK_OK: u8 = 0;
pub const ACK_CRC: u8 = 1;
pub const ACK_MALFORMED: u8 = 2;
pub const ACK_OVERLOADED: u8 = 3;

pub const ID_EXTENDED: u32 = 1 << 29;
pub const ID_FD: u32 = 1 << 30;
pub const ID_TX: u32 = 1 << 31;
pub const ID_ARB_MASK: u32 = 0x1FFF_FFFF;

/// CAN FD DLC table (DLC 9–15 → 12,16,20,24,32,48,64 bytes).
const FD_DLC_LEN: [usize; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

pub fn len_to_dlc(len: usize) -> u8 {
    if len <= 8 {
        return len as u8;
    }
    FD_DLC_LEN.iter().position(|&l| l >= len).unwrap_or(15) as u8
}

pub fn encode_message(mtype: u8, body: &[u8]) -> Vec<u8> {
    let len = (1 + body.len()) as u16;
    let mut out = Vec::with_capacity(2 + 1 + body.len() + 4);
    out.extend_from_slice(&len.to_le_bytes());
    out.push(mtype);
    out.extend_from_slice(body);
    let mut h = crc32fast::Hasher::new();
    h.update(&out[2..]);
    out.extend_from_slice(&h.finalize().to_le_bytes());
    out
}

/// One parsed wire frame: type, body, and whether the CRC matched.
pub struct WireFrame {
    pub mtype: u8,
    pub body: Vec<u8>,
    pub crc_ok: bool,
}

/// Try to consume one complete frame from the front of `buf`.
/// `Ok(None)` = need more bytes; `Err` = unrecoverable garbage (drop client).
pub fn take_frame(buf: &mut Vec<u8>) -> Result<Option<WireFrame>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let len = u16::from_le_bytes([buf[0], buf[1]]) as usize;
    if len < 1 {
        return Err("zero-length frame".into());
    }
    let total = 2 + len + 4;
    if buf.len() < total {
        return Ok(None);
    }
    let payload = &buf[2..2 + len];
    let crc = u32::from_le_bytes([buf[2 + len], buf[3 + len], buf[4 + len], buf[5 + len]]);
    let mut h = crc32fast::Hasher::new();
    h.update(payload);
    let frame = WireFrame {
        mtype: payload[0],
        body: payload[1..].to_vec(),
        crc_ok: h.finalize() == crc,
    };
    buf.drain(..total);
    Ok(Some(frame))
}

#[derive(Debug, PartialEq)]
pub struct Hello {
    pub version: u8,
    pub time_relative: bool,
    pub token: Vec<u8>,
    pub database: String,
}

pub fn parse_hello(body: &[u8]) -> Result<Hello, String> {
    if body.len() < 7 || &body[0..4] != MAGIC {
        return Err("bad magic".into());
    }
    let version = body[4];
    let flags = body[5];
    let token_len = body[6] as usize;
    if body.len() < 7 + token_len {
        return Err("truncated token".into());
    }
    let token = body[7..7 + token_len].to_vec();
    // Optional database field (absent for minimal clients = default db)
    let db_off = 7 + token_len;
    let database = if body.len() > db_off {
        let db_len = body[db_off] as usize;
        if body.len() < db_off + 1 + db_len {
            return Err("truncated database".into());
        }
        String::from_utf8_lossy(&body[db_off + 1..db_off + 1 + db_len]).into_owned()
    } else {
        String::new()
    };
    Ok(Hello {
        version,
        time_relative: flags & HELLO_FLAG_TIME_RELATIVE != 0,
        token,
        database,
    })
}

pub fn encode_hello_ack(status: u8, server_time_us: u64) -> Vec<u8> {
    let mut body = vec![status, PROTO_VERSION];
    body.extend_from_slice(&server_time_us.to_le_bytes());
    encode_message(MSG_HELLO_ACK, &body)
}

pub fn encode_ack(seq: u32, status: u8, queue_pct: u8) -> Vec<u8> {
    let mut body = Vec::with_capacity(6);
    body.extend_from_slice(&seq.to_le_bytes());
    body.push(status);
    body.push(queue_pct);
    encode_message(MSG_ACK, &body)
}

#[derive(Debug)]
pub struct Record {
    pub delta_us: u32,
    pub id_flags: u32,
    pub bus: u8,
    pub payload: Vec<u8>,
}

#[derive(Debug)]
pub struct Batch {
    pub seq: u32,
    pub base_ts_us: u64,
    pub records: Vec<Record>,
}

/// Parse a BATCH body. `Err(seq)` = malformed but seq was readable (NACK it);
/// outer Option None = too short to even carry a seq (drop client).
pub fn parse_batch(body: &[u8], max_frames: usize) -> Option<Result<Batch, u32>> {
    if body.len() < 14 {
        return None;
    }
    let seq = u32::from_le_bytes(body[0..4].try_into().unwrap());
    let base_ts_us = u64::from_le_bytes(body[4..12].try_into().unwrap());
    let count = u16::from_le_bytes(body[12..14].try_into().unwrap()) as usize;
    if count > max_frames {
        return Some(Err(seq));
    }
    let mut records = Vec::with_capacity(count);
    let mut off = 14;
    for _ in 0..count {
        if body.len() < off + 10 {
            return Some(Err(seq));
        }
        let delta_us = u32::from_le_bytes(body[off..off + 4].try_into().unwrap());
        let id_flags = u32::from_le_bytes(body[off + 4..off + 8].try_into().unwrap());
        let bus = body[off + 8];
        let plen = body[off + 9] as usize;
        off += 10;
        if plen > 64 || body.len() < off + plen {
            return Some(Err(seq));
        }
        records.push(Record {
            delta_us,
            id_flags,
            bus,
            payload: body[off..off + plen].to_vec(),
        });
        off += plen;
    }
    Some(Ok(Batch { seq, base_ts_us, records }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello_body(token: &[u8], database: &str, flags: u8) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.push(PROTO_VERSION);
        b.push(flags);
        b.push(token.len() as u8);
        b.extend_from_slice(token);
        b.push(database.len() as u8);
        b.extend_from_slice(database.as_bytes());
        b
    }

    #[test]
    fn frame_round_trip() {
        let msg = encode_message(MSG_PING, b"");
        let mut buf = msg.clone();
        let frame = take_frame(&mut buf).unwrap().unwrap();
        assert_eq!(frame.mtype, MSG_PING);
        assert!(frame.crc_ok);
        assert!(buf.is_empty());
    }

    #[test]
    fn partial_frame_waits_for_more() {
        let msg = encode_message(MSG_PING, b"");
        let mut buf = msg[..3].to_vec();
        assert!(take_frame(&mut buf).unwrap().is_none());
        assert_eq!(buf.len(), 3);
    }

    #[test]
    fn corrupt_crc_detected() {
        let mut msg = encode_message(MSG_BATCH, &[0u8; 14]);
        let n = msg.len();
        msg[n - 1] ^= 0xFF;
        let mut buf = msg;
        let frame = take_frame(&mut buf).unwrap().unwrap();
        assert!(!frame.crc_ok);
    }

    #[test]
    fn hello_with_database() {
        let h = parse_hello(&hello_body(b"sekrit", "vehicle_1", HELLO_FLAG_TIME_RELATIVE)).unwrap();
        assert_eq!(h.token, b"sekrit");
        assert_eq!(h.database, "vehicle_1");
        assert!(h.time_relative);
    }

    #[test]
    fn hello_minimal_no_database_field() {
        // Back-compat: token but no db_len byte at all
        let mut b = MAGIC.to_vec();
        b.extend_from_slice(&[PROTO_VERSION, 0, 3]);
        b.extend_from_slice(b"abc");
        let h = parse_hello(&b).unwrap();
        assert_eq!(h.database, "");
    }

    #[test]
    fn batch_parse_and_limits() {
        let mut body = Vec::new();
        body.extend_from_slice(&7u32.to_le_bytes());
        body.extend_from_slice(&1_000_000u64.to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        for (delta, id) in [(0u32, 0x123u32), (1000, 0x18FF50E5 | ID_EXTENDED)] {
            body.extend_from_slice(&delta.to_le_bytes());
            body.extend_from_slice(&id.to_le_bytes());
            body.push(1); // bus
            body.push(3); // len
            body.extend_from_slice(&[1, 2, 3]);
        }
        let batch = parse_batch(&body, 256).unwrap().unwrap();
        assert_eq!(batch.seq, 7);
        assert_eq!(batch.records.len(), 2);
        assert_eq!(batch.records[1].id_flags & ID_ARB_MASK, 0x18FF50E5);
        assert!(batch.records[1].id_flags & ID_EXTENDED != 0);

        // count over the limit is malformed-with-seq
        let mut over = body.clone();
        over[12..14].copy_from_slice(&5000u16.to_le_bytes());
        assert!(matches!(parse_batch(&over, 256), Some(Err(7))));
    }

    #[test]
    fn fd_dlc_mapping() {
        assert_eq!(len_to_dlc(8), 8);
        assert_eq!(len_to_dlc(12), 9);
        assert_eq!(len_to_dlc(13), 10); // rounds up to 16-byte DLC
        assert_eq!(len_to_dlc(64), 15);
    }
}
