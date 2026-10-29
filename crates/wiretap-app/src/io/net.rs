//! Shared host/port resolution for TCP transports.

use std::net::SocketAddr;
use std::time::Duration;

use crate::io::error::IoError;

/// How long a hostname lookup may take before it is treated as a DNS failure.
///
/// `getaddrinfo` does not fail fast when the resolver itself is unreachable — with
/// a VPN down it blocks for however long libc retries (tens of seconds, sometimes
/// indefinitely). Without this bound the wait either bypasses a caller's connect
/// timeout entirely, or trips it and gets misreported as a connect failure.
///
/// Two things this bound does *not* do. It is additive to the caller's own connect
/// timeout rather than carved out of it, so a profile configured for 1s can still
/// spend `DNS_TIMEOUT` here first. And it bounds only the caller's wait: the lookup
/// runs on a blocking thread that `getaddrinfo` gives no way to cancel, so the
/// thread stays parked until libc gives up.
pub const DNS_TIMEOUT: Duration = Duration::from_secs(5);

/// How long to wait for a TCP connection that a client library opens for itself.
///
/// [`resolve_host_port`] cannot wrap a transport that resolves *inside* its own
/// client — rumqttc and reqwest both do — so those two get a library-level bound
/// instead. Without one they inherit the OS default, which on an unreachable host
/// is a couple of minutes of a session that looks like it is still connecting.
///
/// A fixed value rather than a profile field: neither `mqtt` nor `wiretap`
/// declares a `timeout` in the kind table, and inventing one for two kinds when
/// the setting would be identical everywhere is not worth the settings surface.
/// It bounds the connect only; a slow *response* from a broker or backend that
/// answered is a different problem with a different fix.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The first address `host` (an IP literal or a DNS name) resolves to on `port`.
///
/// **Resolve with this helper first, then connect to the returned address.**
/// Passing a `(host, port)` tuple to `TcpStream::connect` resolves inside the
/// connect future, which is what makes a DNS failure and an unreachable host
/// indistinguishable.
pub async fn resolve_host_port(host: &str, port: u16) -> Result<SocketAddr, IoError> {
    wslib_tcp::resolve(host, port, DNS_TIMEOUT)
        .await
        .map(|addrs| addrs[0])
        .map_err(|reason| IoError::from_resolve(host, &reason))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unresolvable_name_is_a_dns_error_not_a_connection_error() {
        // ".invalid" is reserved by RFC 2606 and never resolves, so this exercises
        // the real resolver without depending on the host's DNS setup. This is the
        // one path whose detail text comes from the OS, so it is also where a
        // stray "not found" could slip into the message.
        let err = resolve_host_port("wiretap-test.invalid", 23)
            .await
            .unwrap_err();
        assert!(
            matches!(err, IoError::DnsResolution { .. }),
            "expected DnsResolution, got {err:?}"
        );
        assert!(!err.user_message().contains("not found"));
    }
}
