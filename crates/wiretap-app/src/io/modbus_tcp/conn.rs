// io/modbus_tcp/conn.rs
//
// A scan connection: one Modbus TCP context plus the timing and reconnect
// policy a discovery sweep needs.
//
// The poll path (`poll.rs`) can assume a device that behaves — it only ever
// reads registers a catalogue says exist. A sweep cannot. It probes addresses
// that may be illegal, on devices whose stacks range from industrial gateways to
// the single-connection microcontroller in a cheap UPS, and it has to tell three
// outcomes apart:
//
//   - a value          → the register exists
//   - a Modbus exception → the register does not, and the reply says which
//   - silence          → no information at all, most often a function code the
//                        device simply doesn't implement
//
// That third case is why this module exists. `tokio-modbus` has no per-request
// timeout, so silence would otherwise hang until the OS gave up.

use std::net::SocketAddr;
use tokio::time::{sleep, timeout, Duration};
use tokio_modbus::client::{self, tcp};
use tokio_modbus::prelude::*;

use super::reader::RegisterType;

/// What one read attempt learned.
#[derive(Debug)]
pub enum ReadOutcome {
    Registers(Vec<u16>),
    Coils(Vec<bool>),
    /// The device replied that it won't serve this request — the reply itself is
    /// evidence the device is alive and the address is wrong.
    Exception(String),
    /// Nothing usable came back — a timeout, or a transport failure. Carries the
    /// reason for the log, but no information about the address: that is the
    /// whole point of the distinction from `Exception`.
    Silent(String),
}

impl ReadOutcome {
    /// True when the device said something. A sweep uses this to tell "this
    /// address is absent" from "this function code is unimplemented".
    pub fn device_replied(&self) -> bool {
        !matches!(self, ReadOutcome::Silent(_))
    }
}

/// A Modbus TCP connection with a scan's timing policy attached.
pub struct ScanConn {
    addr: SocketAddr,
    ctx: client::Context,
    unit_id: u8,
    /// Per-request timeout. `tokio-modbus` has none of its own.
    timeout_ms: u64,
    /// Pause after (re)connecting, before the first request on that socket.
    /// Cheap stacks need a moment to be ready; without it the opening request of
    /// each connection is lost.
    settle_ms: u64,
    /// Open a fresh connection for every request. Some devices accept exactly one
    /// Modbus conversation per socket and stop answering after the first.
    reconnect_per_request: bool,
    /// Set after a timeout so the next request reconnects. A late reply on a
    /// reused socket arrives against a stale transaction id, which `tokio-modbus`
    /// rejects as a header mismatch — that would cascade through the rest of the
    /// sweep as fake failures.
    needs_reconnect: bool,
}

impl ScanConn {
    pub async fn connect(
        host: &str,
        port: u16,
        unit_id: u8,
        timeout_ms: u64,
        settle_ms: u64,
        reconnect_per_request: bool,
    ) -> Result<Self, String> {
        let addr = crate::io::net::resolve_host_port(host, port)
            .await
            .map_err(|e| e.user_message())?;
        let ctx = tcp::connect_slave(addr, Slave(unit_id))
            .await
            .map_err(|e| format!("Failed to connect to Modbus TCP server at {}: {}", addr, e))?;
        if settle_ms > 0 {
            sleep(Duration::from_millis(settle_ms)).await;
        }
        Ok(Self {
            addr,
            ctx,
            unit_id,
            timeout_ms,
            settle_ms,
            reconnect_per_request,
            needs_reconnect: false,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    async fn reconnect(&mut self) -> Result<(), String> {
        self.ctx = tcp::connect_slave(self.addr, Slave(self.unit_id))
            .await
            .map_err(|e| format!("Reconnect to {} failed: {}", self.addr, e))?;
        if self.settle_ms > 0 {
            sleep(Duration::from_millis(self.settle_ms)).await;
        }
        self.needs_reconnect = false;
        Ok(())
    }

    /// Read a block, never hanging longer than the configured timeout.
    pub async fn read(
        &mut self,
        register_type: &RegisterType,
        start: u16,
        count: u16,
    ) -> ReadOutcome {
        if (self.reconnect_per_request || self.needs_reconnect) && self.reconnect().await.is_err() {
            // Report the failed reconnect as a timeout rather than an IO error:
            // an unreachable device is the same "no information" case, and the
            // caller's consecutive-timeout budget is what should end the sweep.
            self.needs_reconnect = true;
            return ReadOutcome::Silent("reconnect failed".to_string());
        }

        let request = async {
            match register_type {
                RegisterType::Holding => self
                    .ctx
                    .read_holding_registers(start, count)
                    .await
                    .map(|r| r.map(ReadOutcome::Registers)),
                RegisterType::Input => self
                    .ctx
                    .read_input_registers(start, count)
                    .await
                    .map(|r| r.map(ReadOutcome::Registers)),
                RegisterType::Coil => self
                    .ctx
                    .read_coils(start, count)
                    .await
                    .map(|r| r.map(ReadOutcome::Coils)),
                RegisterType::Discrete => self
                    .ctx
                    .read_discrete_inputs(start, count)
                    .await
                    .map(|r| r.map(ReadOutcome::Coils)),
            }
        };

        match timeout(Duration::from_millis(self.timeout_ms), request).await {
            Ok(Ok(Ok(outcome))) => outcome,
            Ok(Ok(Err(exc))) => ReadOutcome::Exception(exc.to_string()),
            Ok(Err(e)) => {
                self.needs_reconnect = true;
                ReadOutcome::Silent(e.to_string())
            }
            Err(_) => {
                self.needs_reconnect = true;
                ReadOutcome::Silent("no reply within the timeout".to_string())
            }
        }
    }
}
