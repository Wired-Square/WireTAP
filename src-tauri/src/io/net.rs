//! Shared host/port resolution for TCP transports.

use std::io;
use std::net::SocketAddr;

/// Resolve a `host` (IP literal or DNS name) and `port` to a [`SocketAddr`].
///
/// Parsing `"host:port"` straight into a [`SocketAddr`] only accepts numeric
/// IP literals, so any DNS hostname fails with "invalid socket address
/// syntax". This resolves through the system resolver and returns the first
/// address, letting every transport accept hostnames identically.
pub async fn resolve_host_port(host: &str, port: u16) -> io::Result<SocketAddr> {
    tokio::net::lookup_host((host, port))
        .await?
        .next()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{host}:{port} resolved to no addresses"),
            )
        })
}
