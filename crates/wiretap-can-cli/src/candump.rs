use std::{
    fmt::Write,
    time::{SystemTime, UNIX_EPOCH},
};

use wiretap_io::can::{CanFrame, Direction};

/// An interface argument as a candump interface name: no whitespace, so a log
/// line stays four fields, and the channel last, where `walk-diff` reads a bus.
pub fn ifname(argument: &str) -> String {
    let mut name = String::with_capacity(argument.len());
    for c in argument.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            c
        } else {
            '-'
        };
        if !(c == '-' && (name.is_empty() || name.ends_with('-'))) {
            name.push(c);
        }
    }
    name.trim_end_matches('-').to_owned()
}

/// One `candump -L` line, with `-x`'s ` T` / ` R` when `direction` is given.
pub fn line(
    at: SystemTime,
    ifname: &str,
    frame: &CanFrame,
    direction: Option<Direction>,
) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let mut out = format!(
        "({:010}.{:06}) {ifname} ",
        since.as_secs(),
        since.subsec_micros()
    );
    if frame.extended {
        let _ = write!(out, "{:08X}#", frame.arb_id);
    } else {
        let _ = write!(out, "{:03X}#", frame.arb_id);
    }
    if frame.rtr && !frame.fd {
        out.push('R');
        let dlc = frame.dlc();
        if (1..=8).contains(&dlc) {
            let _ = write!(out, "{dlc}");
        }
    } else {
        if frame.fd {
            let flags = u8::from(frame.brs) | u8::from(frame.esi) << 1;
            let _ = write!(out, "#{flags:X}");
        }
        out.push_str(&hex::encode_upper(&frame.data));
    }
    match direction {
        Some(Direction::Tx) => out.push_str(" T"),
        Some(Direction::Rx) => out.push_str(" R"),
        None => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at() -> SystemTime {
        UNIX_EPOCH + Duration::from_micros(1_727_000_000_000_042)
    }

    fn fd(brs: bool, esi: bool, data: Vec<u8>) -> CanFrame {
        let mut frame = CanFrame::data(0, 0x123, false, true, brs, data);
        frame.esi = esi;
        frame
    }

    #[test]
    fn each_frame_kind_prints_as_candump_logs_it() {
        let cases = [
            (
                CanFrame::data(0, 0x123, false, false, false, vec![0xDE, 0xAD, 0xBE, 0xEF]),
                "123#DEADBEEF",
            ),
            (CanFrame::data(0, 0x7, false, false, false, vec![]), "007#"),
            (
                CanFrame::data(0, 0x1234567, true, false, false, vec![1, 2]),
                "01234567#0102",
            ),
            (CanFrame::remote(0, 0x123, false, 0), "123#R"),
            (CanFrame::remote(0, 0x123, false, 5), "123#R5"),
            (CanFrame::remote(0, 0x1ABCDEF0, true, 8), "1ABCDEF0#R8"),
            (
                fd(true, false, vec![0xA5; 12]),
                "123##1A5A5A5A5A5A5A5A5A5A5A5A5",
            ),
            (fd(false, false, vec![0xAA]), "123##0AA"),
            (fd(false, true, vec![]), "123##2"),
            (fd(true, true, vec![0x01]), "123##301"),
        ];
        for (frame, text) in cases {
            assert_eq!(
                line(at(), "can0", &frame, None),
                format!("(1727000000.000042) can0 {text}"),
                "{frame:?}"
            );
        }
    }

    #[test]
    fn own_frames_carry_their_direction() {
        let frame = CanFrame::data(0, 0x10, false, false, false, vec![0x42]);
        assert_eq!(
            line(at(), "can0", &frame, Some(Direction::Tx)),
            "(1727000000.000042) can0 010#42 T"
        );
        assert_eq!(
            line(at(), "can0", &frame, Some(Direction::Rx)),
            "(1727000000.000042) can0 010#42 R"
        );
    }

    #[test]
    fn the_seconds_are_zero_padded_to_ten_digits() {
        let frame = CanFrame::data(0, 1, false, false, false, vec![]);
        assert_eq!(
            line(UNIX_EPOCH + Duration::from_millis(1500), "x", &frame, None),
            "(0000000001.500000) x 001#"
        );
    }

    #[test]
    fn an_interface_argument_becomes_a_bare_name() {
        let cases = [
            ("socketcan:can0", "socketcan-can0"),
            ("gsusb:205933B831335010/1", "gsusb-205933B831335010-1"),
            ("gsusb:0:5", "gsusb-0-5"),
            ("slcan:/dev/cu.usbmodem1101", "slcan-dev-cu.usbmodem1101"),
            ("slcan:COM3", "slcan-COM3"),
            ("gvret:[::1]:23", "gvret-1-23"),
        ];
        for (argument, name) in cases {
            assert_eq!(ifname(argument), name);
        }
    }
}
