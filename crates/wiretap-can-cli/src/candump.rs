use std::time::{SystemTime, UNIX_EPOCH};

use wiretap_io::can::{CanFrame, Direction};
use wiretap_protocol::candump;

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
    let mut out = String::new();
    candump::encode_line_into(&mut out, since.as_micros() as u64, ifname, frame, direction);
    out
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_read_is_stamped_to_the_microsecond_since_the_epoch() {
        let frame = CanFrame::data(0, 1, false, false, false, vec![]);
        let at = UNIX_EPOCH + Duration::from_micros(1_727_000_000_000_042);
        assert_eq!(line(at, "x", &frame, None), "(1727000000.000042) x 001#");
    }

    #[test]
    fn an_interface_argument_becomes_a_bare_name() {
        let cases = [
            ("socketcan:can0", "socketcan-can0"),
            ("gsusb:205933B831335010/1", "gsusb-205933B831335010-1"),
            ("gsusb:0:5", "gsusb-0-5"),
            ("pcan:0012ABCD/0", "pcan-0012ABCD-0"),
            ("pcan:1:4/1", "pcan-1-4-1"),
            ("slcan:/dev/cu.usbmodem1101", "slcan-dev-cu.usbmodem1101"),
            ("slcan:COM3", "slcan-COM3"),
            ("gvret:[::1]:23", "gvret-1-23"),
        ];
        for (argument, name) in cases {
            assert_eq!(ifname(argument), name);
        }
    }
}
