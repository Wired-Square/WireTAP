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

/// Resolve a `host` (IP literal or DNS name) and `port` to a [`SocketAddr`].
///
/// Parsing `"host:port"` straight into a [`SocketAddr`] only accepts numeric IP
/// literals, so any DNS hostname fails with "invalid socket address syntax". This
/// resolves through the system resolver and returns the first address, letting
/// every transport accept hostnames identically.
///
/// **Resolve with this helper first, then connect to the returned address.**
/// Passing a `(host, port)` tuple to `TcpStream::connect` resolves inside the
/// connect future, which is what makes a DNS failure and an unreachable host
/// indistinguishable.
pub async fn resolve_host_port(host: &str, port: u16) -> Result<SocketAddr, IoError> {
    let dns_err = |details: &str| IoError::dns_resolution(host, details);

    match tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host, port))).await {
        Ok(Ok(mut addrs)) => addrs
            .next()
            .ok_or_else(|| dns_err("the name resolved to no addresses")),
        Ok(Err(e)) => Err(dns_err(&e.to_string())),
        Err(_) => Err(dns_err("the DNS resolver did not respond")),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolves_an_ip_literal_without_touching_dns() {
        let addr = resolve_host_port("127.0.0.1", 8080).await.unwrap();
        assert_eq!(addr.to_string(), "127.0.0.1:8080");
    }

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
