// Copyright (c) 2026, Wired Square Pty Ltd
//
// Asks a FrameLink device which protocol version it speaks, after a connection
// has already failed.
//
// The protocol has no handshake: `connect` writes nothing, so a successful TCP
// connect proves only that a socket opened. A peer whose version differs drops
// our frames *before dispatch* without replying, so the first real request
// stalls for the full command timeout and we learn nothing — which is how a v3
// add-on and a v1 build produced a healthy-looking session carrying no frames.
//
// The device never volunteers its version, but it will answer a frame it can
// parse. So ask in every dialect at once: one PING per version, a single listen
// window, and whichever one comes back names the version. Three properties make
// this sound, and all three are pinned by tests or verified against history:
//
//   1. The 5-byte header has never changed. Only the CRC *trailer* was ever
//      removed, and the v1 -> v3 bump changed nothing but the constant.
//   2. COBS framing is version-independent and is decoded before the version
//      check, in every implementation.
//   3. `parse_frame` reports the peer's version in its error, so reading a
//      foreign reply needs no hand-rolled parsing.

use std::net::SocketAddr;
use std::time::Duration;

use framelink::codec::frame::{parse_frame, HEADER_SIZE};
use framelink::codec::{cobs, FrameError};
use framelink::protocol::types::MSG_PING;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The version nibble is four bits, so this is every version the wire can name.
const ALL_VERSIONS: std::ops::RangeInclusive<u8> = 0..=15;

/// How long to wait for the one device that recognises one of our pings.
const LISTEN_WINDOW: Duration = Duration::from_millis(1500);

/// What the probe learned.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum VersionVerdict {
    /// The peer answered in our own version — a version mismatch is *not* the
    /// fault, and the caller must not claim otherwise.
    SameVersion,
    /// The peer answered in a version we do not speak.
    Speaks(u8),
    /// Something answered, but in a shape we cannot parse at all. Most likely
    /// firmware predating the CRC-16 removal — that shipped without a version
    /// bump, so "v1" names two incompatible wire forms.
    Unintelligible,
    /// Nothing came back at any version.
    Silent,
}

/// Build a PING framed at an arbitrary protocol version.
///
/// This is the one thing the library cannot do for us: `build_frame` stamps
/// `PROTOCOL_VERSION` into every frame it makes, and the whole point here is to
/// speak versions this build does not. Only the 5-byte header is assembled by
/// hand — COBS is the real codec — and `probe_frame_matches_library` pins the
/// result byte-for-byte against `build_frame` so the two cannot drift.
fn ping_at_version(version: u8) -> Vec<u8> {
    let mut raw = Vec::with_capacity(HEADER_SIZE);
    raw.push(version << 4); // low nibble is flags — none set
    raw.push(MSG_PING);
    raw.push(0); // seq — nothing correlates replies, so keep the anchor test plain
    raw.extend_from_slice(&0u16.to_le_bytes()); // empty payload

    wrap(&raw)
}

/// COBS-encode a raw frame and delimit it, as the wire expects.
fn wrap(raw: &[u8]) -> Vec<u8> {
    let encoded = cobs::encode(raw);
    let mut frame = Vec::with_capacity(encoded.len() + 2);
    frame.push(0x00);
    frame.extend_from_slice(&encoded);
    frame.push(0x00);
    frame
}

/// Classify the bytes a device sent back — the first frame that parses, or
/// names a version, decides.
///
/// It scans rather than taking chunk zero because a read can start mid-stream:
/// a device already streaming leaves a partial frame ahead of its PONG.
/// `Unintelligible` is the fallback for "frames arrived, none of them parsed".
fn classify(buf: &[u8]) -> VersionVerdict {
    let mut verdict = VersionVerdict::Silent;

    for chunk in buf.split(|b| *b == 0x00).filter(|c| !c.is_empty()) {
        match parse_frame(chunk) {
            Ok(_) => return VersionVerdict::SameVersion,
            Err(FrameError::UnsupportedVersion(v)) => return VersionVerdict::Speaks(v),
            // Framed correctly enough to split, but not to parse.
            Err(_) => verdict = VersionVerdict::Unintelligible,
        }
    }

    verdict
}

/// Ask `addr` which protocol version it speaks.
///
/// Only ever called once a connection has already failed, so its cost is paid on
/// a path that was going to error anyway. The caller must have dropped its
/// `FrameLinkSession` first — the device serves one client, so the probe cannot
/// get in until that socket is closed.
pub(crate) async fn probe_version(addr: SocketAddr) -> VersionVerdict {
    let mut stream = match TcpStream::connect(addr).await {
        Ok(s) => s,
        // A device that will not take a second connection is one that is busy
        // or gone, which is what Silent already reports.
        Err(_) => return VersionVerdict::Silent,
    };
    let _ = stream.set_nodelay(true);

    let mut pings = Vec::new();
    for version in ALL_VERSIONS {
        pings.extend_from_slice(&ping_at_version(version));
    }
    if stream.write_all(&pings).await.is_err() {
        return VersionVerdict::Silent;
    }

    // One read, not a drain: the device answers exactly one of the sixteen and
    // then holds the socket open, so waiting for EOF would always burn the full
    // window even when the reply landed immediately.
    let mut buf = vec![0u8; 512];
    match tokio::time::timeout(LISTEN_WINDOW, stream.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => classify(&buf[..n]),
        _ => VersionVerdict::Silent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use framelink::codec::frame::{build_frame, PROTOCOL_VERSION};

    /// The hand-assembled header must be exactly what the library would emit.
    /// If the envelope ever changes, this fails rather than the probe silently
    /// asking the wrong question.
    #[test]
    fn probe_frame_matches_library() {
        assert_eq!(
            ping_at_version(PROTOCOL_VERSION),
            build_frame(MSG_PING, 0, 0, &[]),
            "the probe's frame envelope has drifted from framelink::codec"
        );
    }

    /// A reply in a version we do not speak is the whole point — the peer's
    /// version has to come back out.
    #[test]
    fn a_foreign_version_reply_names_its_version() {
        for version in [0u8, 1, 2, 4, 15] {
            if version == PROTOCOL_VERSION {
                continue;
            }
            let reply = ping_at_version(version);
            assert_eq!(classify(&reply), VersionVerdict::Speaks(version));
        }
    }

    #[test]
    fn our_own_version_is_not_reported_as_a_mismatch() {
        let reply = ping_at_version(PROTOCOL_VERSION);
        assert_eq!(classify(&reply), VersionVerdict::SameVersion);
    }

    /// Correctly framed, right version, but the length field disagrees — the
    /// pre-CRC-removal dialect, which is not a version mismatch and must not be
    /// reported as one.
    #[test]
    fn a_frame_we_cannot_parse_is_not_a_version() {
        let mut raw = vec![(PROTOCOL_VERSION << 4), MSG_PING, 0];
        raw.extend_from_slice(&9u16.to_le_bytes()); // claims 9 bytes, carries 0
        assert_eq!(classify(&wrap(&raw)), VersionVerdict::Unintelligible);
    }

    #[test]
    fn nothing_back_is_silence() {
        assert_eq!(classify(&[]), VersionVerdict::Silent);
        assert_eq!(classify(&[0x00, 0x00]), VersionVerdict::Silent);
    }

    /// A partial or junk frame ahead of the reply must not stop the scan — a
    /// device may still be streaming when we probe it.
    #[test]
    fn the_scan_continues_past_an_unparseable_chunk() {
        let mut buf = vec![0x00, 0x02, 0x99, 0x00]; // junk frame
        buf.extend_from_slice(&ping_at_version(1));
        assert_eq!(classify(&buf), VersionVerdict::Speaks(1));
    }

    /// Against a real device. Ignored by default — it needs the network and a
    /// FrameLink endpoint that nothing else is holding, since a device serves
    /// exactly one client.
    ///
    /// `FRAMELINK_PROBE_ADDR=host:120 cargo test -- --ignored probe_a_real_device`
    #[tokio::test]
    #[ignore = "needs a reachable FrameLink device"]
    async fn probe_a_real_device() {
        let addr: SocketAddr = std::env::var("FRAMELINK_PROBE_ADDR")
            .expect("set FRAMELINK_PROBE_ADDR=host:port")
            .parse()
            .expect("FRAMELINK_PROBE_ADDR must be ip:port");

        let verdict = probe_version(addr).await;
        println!("verdict: {verdict:?}");
        assert_ne!(
            verdict,
            VersionVerdict::Silent,
            "no reply at any version — is another client holding the device?"
        );
    }
}
