use wiretap_io::can::CanFrame;
use wiretap_protocol::{dlc_to_len, len_to_dlc};

/// A `cansend` frame on `bus`: `123#DEADBEEF`, `12345678#…` extended,
/// `123##<flags><data>` FD (flags BRS=1, ESI=2), `123#R[<dlc>]` remote.
/// Data may be dotted; an FD payload is zero-padded to its length code.
pub fn parse(text: &str, bus: u8) -> Result<CanFrame, String> {
    let bad = |why: &str| format!("'{text}' is not a cansend frame: {why}");
    let (id, body) = text.split_once('#').ok_or_else(|| bad("no '#'"))?;
    let extended = match id.len() {
        3 => false,
        8 => true,
        _ => return Err(bad("the id is 3 hex digits, or 8 for an extended id")),
    };
    let arb_id = u32::from_str_radix(id, 16).map_err(|_| bad("the id is not hex"))?;

    if let Some(dlc) = body.strip_prefix(['R', 'r']) {
        let dlc = match dlc {
            "" => 0,
            _ => dlc
                .parse::<u8>()
                .ok()
                .filter(|dlc| *dlc <= 8)
                .ok_or_else(|| bad("a remote frame's length is one digit, 0 to 8"))?,
        };
        return Ok(CanFrame::remote(bus, arb_id, extended, dlc));
    }

    let (fd, flags, data) = match body.strip_prefix('#') {
        Some(rest) => {
            let mut chars = rest.chars();
            let flags = chars
                .next()
                .and_then(|c| c.to_digit(16))
                .ok_or_else(|| bad("'##' is followed by one hex flags digit"))?;
            (true, flags as u8, chars.as_str())
        }
        None => (false, 0, body),
    };
    let mut data =
        hex::decode(data.replace('.', "")).map_err(|_| bad("the data is not whole hex bytes"))?;
    let max = if fd { 64 } else { 8 };
    if data.len() > max {
        return Err(bad(&format!("{} bytes is more than {max}", data.len())));
    }
    if fd {
        data.resize(dlc_to_len(len_to_dlc(data.len()), true), 0);
    }
    let mut frame = CanFrame::data(bus, arb_id, extended, fd, flags & 1 != 0, data);
    frame.esi = flags & 2 != 0;
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(text: &str) -> CanFrame {
        parse(text, 0).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn classic_frames_parse() {
        assert_eq!(
            frame("123#DEADBEEF"),
            CanFrame::data(0, 0x123, false, false, false, vec![0xDE, 0xAD, 0xBE, 0xEF])
        );
        assert_eq!(
            frame("7FF#"),
            CanFrame::data(0, 0x7FF, false, false, false, vec![])
        );
        assert_eq!(
            frame("1a2#de.ad.be.ef"),
            CanFrame::data(0, 0x1A2, false, false, false, vec![0xDE, 0xAD, 0xBE, 0xEF])
        );
        assert_eq!(
            frame("12345678#0102"),
            CanFrame::data(0, 0x1234_5678, true, false, false, vec![1, 2])
        );
        assert_eq!(
            frame("00000123#"),
            CanFrame::data(0, 0x123, true, false, false, vec![])
        );
    }

    #[test]
    fn the_bus_is_the_callers() {
        assert_eq!(parse("123#", 1).unwrap().bus, 1);
    }

    #[test]
    fn remote_frames_parse_with_an_optional_length() {
        assert_eq!(frame("123#R"), CanFrame::remote(0, 0x123, false, 0));
        assert_eq!(frame("123#r3"), CanFrame::remote(0, 0x123, false, 3));
        assert_eq!(
            frame("1ABCDEF0#R8"),
            CanFrame::remote(0, 0x1ABC_DEF0, true, 8)
        );
    }

    #[test]
    fn fd_frames_take_their_flags_and_pad_to_a_length_code() {
        assert_eq!(
            frame("123##1DEADBEEF"),
            CanFrame::data(0, 0x123, false, true, true, vec![0xDE, 0xAD, 0xBE, 0xEF])
        );
        assert_eq!(
            frame("123##0"),
            CanFrame::data(0, 0x123, false, true, false, vec![])
        );
        let esi = frame("123##2AA");
        assert!(esi.fd && esi.esi && !esi.brs);
        let padded = frame(&format!("123##1{}", "11".repeat(9)));
        assert_eq!(padded.data.len(), 12);
        assert_eq!(&padded.data[9..], &[0, 0, 0]);
        assert_eq!(frame(&format!("123##1{}", "00".repeat(64))).data.len(), 64);
    }

    #[test]
    fn malformed_frames_are_refused() {
        for text in [
            "123",
            "12#00",
            "1234#00",
            "XYZ#00",
            "123#0",
            "123#GG",
            "123#010203040506070809",
            "123#R9",
            "123#R12",
            "123##",
            "123##G00",
            &format!("123##1{}", "00".repeat(65)),
        ] {
            assert!(parse(text, 0).is_err(), "{text}");
        }
    }

    #[test]
    fn an_id_the_bus_cannot_carry_is_left_to_the_library() {
        assert_eq!(frame("FFF#").arb_id, 0xFFF);
    }
}
