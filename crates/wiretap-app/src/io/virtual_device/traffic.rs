// crates/wiretap-app/src/io/virtual_device/traffic.rs
//
// The virtual device's signal generator: the traffic for the nth tick of a bus.
// The broker's virtual reader draws on it.

use std::sync::LazyLock;

use super::VirtualTrafficType;
use crate::io::FrameMessage;

// CAN frame patterns — matching canfd_test.py test signal generator
const CAN_PATTERNS: &[(u32, &[u8])] = &[
    (0x100, &[0xC0, 0xFF, 0xEE, 0x42, 0xC0, 0xFF, 0xEE, 0x42]),
    (0x200, &[0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    (0x300, &[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    (0x400, &[0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55]),
    (0x0F0, &[0xCA, 0xFE, 0xF0, 0x0D, 0xCA, 0xFE, 0xF0, 0x0D]),
    (0x500, &[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]),
    (0x600, &[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    (0x7FF, &[0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42]),
];

fn repeat_to_64(pattern: &[u8]) -> Vec<u8> {
    pattern.iter().cycle().take(64).copied().collect()
}

// CAN-FD frame patterns — matching canfd_test.py
static CANFD_PATTERNS: LazyLock<Vec<(u32, Vec<u8>)>> = LazyLock::new(|| {
    vec![
        (0x100, repeat_to_64(&[0xC0, 0xFF, 0xEE, 0x42])),
        (0x200, (0u8..64).collect()),
        (0x300, vec![0xFF; 64]),
        (0x400, repeat_to_64(&[0xAA, 0x55])),
        (0x0F0, repeat_to_64(&[0xCA, 0xFE, 0xF0, 0x0D])),
        (0x500, repeat_to_64(&[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80])),
        (0x600, vec![0x00; 8]),  // Classic-size zeros
        (0x7FF, vec![0x42; 48]), // 48-byte payload
    ]
});

// Modbus register numbers to cycle through (holding registers)
const MODBUS_REGISTERS: &[u32] = &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const COUNTER_FRAME_ID: u32 = 0x7E0;

/// Each pattern in turn, then a counter frame carrying the cycle number.
fn pattern_or_counter(
    patterns: &[(u32, impl AsRef<[u8]>)],
    counter: u64,
    counter_len: usize,
) -> (u32, Vec<u8>) {
    let period = patterns.len() as u64 + 1;
    match patterns.get((counter % period) as usize) {
        Some((id, data)) => (*id, data.as_ref().to_vec()),
        None => {
            let cycle = ((counter / period + 1) as u16).to_be_bytes();
            (COUNTER_FRAME_ID, cycle.into_iter().cycle().take(counter_len).collect())
        }
    }
}

/// The frame for tick `counter` of a bus; `None` for serial traffic, which is
/// bytes.
pub(crate) fn frame(
    traffic: &VirtualTrafficType,
    counter: u64,
    bus: u8,
    timestamp_us: u64,
) -> Option<FrameMessage> {
    let (protocol, frame_id, bytes, is_fd) = match traffic {
        VirtualTrafficType::Can => {
            let (id, data) = pattern_or_counter(CAN_PATTERNS, counter, 8);
            ("can", id, data, false)
        }
        VirtualTrafficType::CanFd => {
            let (id, data) = pattern_or_counter(&CANFD_PATTERNS, counter, 64);
            ("can", id, data, true)
        }
        VirtualTrafficType::Modbus => {
            let len = MODBUS_REGISTERS.len() as u64;
            let register = MODBUS_REGISTERS[(counter % len) as usize];
            let value = ((counter / len) & 0xFFFF) as u16;
            ("modbus", register, value.to_be_bytes().to_vec(), false)
        }
        VirtualTrafficType::Serial => return None,
    };
    Some(FrameMessage {
        protocol: protocol.to_string(),
        timestamp_us,
        frame_id,
        bus,
        dlc: bytes.len() as u16,
        bytes,
        is_extended: false,
        is_fd,
        source_address: None,
        incomplete: None,
        direction: Some("rx".to_string()),
        ..Default::default()
    })
}

/// The eight serial bytes for tick `counter`, counting up from its low byte.
pub(crate) fn serial_bytes(counter: u64) -> impl Iterator<Item = u8> {
    let first = (counter & 0xFF) as u8;
    (0..8).map(move |i| first.wrapping_add(i))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generated(traffic: VirtualTrafficType, counter: u64) -> (String, u32, Vec<u8>, bool) {
        let f = frame(&traffic, counter, 3, 42).expect("a frame");
        assert_eq!((f.bus, f.timestamp_us, f.dlc as usize), (3, 42, f.bytes.len()));
        assert!(!f.is_extended);
        assert_eq!(f.direction.as_deref(), Some("rx"));
        (f.protocol, f.frame_id, f.bytes, f.is_fd)
    }

    fn can(id: u32, bytes: Vec<u8>) -> (String, u32, Vec<u8>, bool) {
        ("can".into(), id, bytes, false)
    }

    fn fd(id: u32, bytes: Vec<u8>) -> (String, u32, Vec<u8>, bool) {
        ("can".into(), id, bytes, true)
    }

    #[test]
    fn classic_can_cycles_its_patterns_then_a_counter_frame() {
        let at = |counter| generated(VirtualTrafficType::Can, counter);
        assert_eq!(at(0), can(0x100, vec![0xC0, 0xFF, 0xEE, 0x42, 0xC0, 0xFF, 0xEE, 0x42]));
        assert_eq!(at(7), can(0x7FF, vec![0x42; 8]));
        assert_eq!(at(8), can(0x7E0, vec![0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01]));
        assert_eq!(at(9), can(0x100, vec![0xC0, 0xFF, 0xEE, 0x42, 0xC0, 0xFF, 0xEE, 0x42]));
        assert_eq!(at(17), can(0x7E0, vec![0x00, 0x02, 0x00, 0x02, 0x00, 0x02, 0x00, 0x02]));
        assert_eq!(at(9 * 300 + 8), can(0x7E0, [0x01, 0x2D].repeat(4)));
    }

    #[test]
    fn can_fd_cycles_its_patterns_then_a_64_byte_counter_frame() {
        let at = |counter| generated(VirtualTrafficType::CanFd, counter);
        assert_eq!(at(1), fd(0x200, (0..64).collect()));
        assert_eq!(at(3), fd(0x400, [0xAA, 0x55].repeat(32)));
        assert_eq!(at(6), fd(0x600, vec![0; 8]));
        assert_eq!(at(7), fd(0x7FF, vec![0x42; 48]));
        assert_eq!(at(8), fd(0x7E0, [0x00, 0x01].repeat(32)));
        assert_eq!(at(26), fd(0x7E0, [0x00, 0x03].repeat(32)));
    }

    #[test]
    fn modbus_walks_ten_registers_counting_up_once_per_round() {
        let at = |counter| generated(VirtualTrafficType::Modbus, counter);
        let modbus = |register, value: u16| ("modbus".into(), register, value.to_be_bytes().to_vec(), false);
        assert_eq!(at(0), modbus(0, 0));
        assert_eq!(at(9), modbus(9, 0));
        assert_eq!(at(13), modbus(3, 1));
        assert_eq!(at(655_365), modbus(5, 0));
    }

    #[test]
    fn serial_traffic_is_eight_counting_bytes_and_no_frame() {
        assert!(frame(&VirtualTrafficType::Serial, 0, 0, 0).is_none());
        assert_eq!(serial_bytes(0).collect::<Vec<_>>(), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(
            serial_bytes(0x1FC).collect::<Vec<_>>(),
            [0xFC, 0xFD, 0xFE, 0xFF, 0x00, 0x01, 0x02, 0x03]
        );
    }
}
