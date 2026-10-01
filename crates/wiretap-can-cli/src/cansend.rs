use wiretap_io::can::CanFrame;
use wiretap_protocol::{candump, dlc_to_len, len_to_dlc};

/// A `cansend` frame on `bus`, as `candump::parse_frame` reads it, with an FD
/// payload zero-padded to its length code as the kernel sends it.
pub fn parse(text: &str, bus: u8) -> Result<CanFrame, String> {
    let mut frame = candump::parse_frame(text, bus)
        .map_err(|why| format!("'{text}' is not a cansend frame: {why}"))?;
    if frame.fd {
        frame
            .data
            .resize(dlc_to_len(len_to_dlc(frame.data.len()), true), 0);
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_fd_payload_is_padded_to_its_length_code() {
        let padded = parse(&format!("123##1{}", "11".repeat(9)), 0).unwrap();
        assert_eq!(padded.data.len(), 12);
        assert_eq!(&padded.data[9..], &[0, 0, 0]);
        assert_eq!(parse("123##1DEADBEEF", 0).unwrap().data.len(), 4);
        assert!(parse("123#R", 0).unwrap().rtr);
    }

    #[test]
    fn a_refusal_names_the_frame_and_why() {
        assert_eq!(
            parse("12#00", 1).unwrap_err(),
            "'12#00' is not a cansend frame: the id is 3 hex digits, or 8 for an extended id"
        );
    }
}
