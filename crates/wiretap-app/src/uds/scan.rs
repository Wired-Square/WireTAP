//! Scans run one probe at a time on a task of their own, and stop between probes.

use std::collections::HashMap;
use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use once_cell::sync::Lazy;
use serde::Serialize;
use wslib_isotp::{Reassembler, Segmenter, StMin, Step};
use wslib_uds::{
    AddressProbe, AddressScan, Client, DidFinding, DidScan, DidVerdict, ReadOnlyServiceScan,
    ScanProgress, ServiceFinding,
};

use super::isotp::{framing, Route};
use super::tap::{self, Listen, Tap};
use super::{ask, await_final, check_ids, check_session, Messages, Parties};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    Scanning,
    Complete,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answered {
    pub request_id: u32,
    pub response_id: u32,
}

/// A DID scan leaves out the DIDs refused as out of range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "found", rename_all = "camelCase")]
pub enum Findings {
    Dids(Vec<DidFinding>),
    Services(Vec<ServiceFinding>),
    Addresses(Vec<Answered>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scan_id: String,
    pub status: ScanStatus,
    pub progress: ScanProgress,
    pub findings: Findings,
    pub error: Option<String>,
}

pub enum Plan {
    Dids {
        parties: Parties,
        scan: DidScan,
    },
    Services {
        parties: Parties,
        scan: ReadOnlyServiceScan,
    },
    Addresses {
        session_id: String,
        bus: u8,
        extended: bool,
        scan: AddressScan,
        answered: Vec<Answered>,
    },
}

const NOTHING_TO_SCAN: &str = "the range is empty: its first id is above its last";

impl Plan {
    pub fn dids(parties: Parties, dids: RangeInclusive<u16>) -> Result<Self, String> {
        if dids.is_empty() {
            return Err(NOTHING_TO_SCAN.into());
        }
        Ok(Self::Dids {
            parties,
            scan: DidScan::new(dids),
        })
    }

    pub fn services(parties: Parties) -> Self {
        Self::Services {
            parties,
            scan: ReadOnlyServiceScan::new(),
        }
    }

    /// A tester present to each request id in `ids`, answered from any id.
    pub fn addresses(
        session_id: String,
        bus: u8,
        extended: bool,
        ids: RangeInclusive<u32>,
    ) -> Result<Self, String> {
        check_ids(extended, [*ids.start(), *ids.end()])?;
        if ids.is_empty() {
            return Err(NOTHING_TO_SCAN.into());
        }
        Ok(Self::Addresses {
            session_id,
            bus,
            extended,
            scan: AddressScan::new(ids),
            answered: Vec::new(),
        })
    }

    async fn check(&self) -> Result<(), String> {
        match self {
            Self::Dids { parties, .. } | Self::Services { parties, .. } => parties.check().await,
            Self::Addresses { session_id, .. } => check_session(session_id).await,
        }
    }

    fn session_id(&self) -> &str {
        match self {
            Self::Dids { parties, .. } | Self::Services { parties, .. } => &parties.session_id,
            Self::Addresses { session_id, .. } => session_id,
        }
    }

    /// `false` once there is nothing left to probe.
    async fn step(&mut self) -> Result<bool, String> {
        match self {
            Self::Dids { parties, scan } => {
                let Some(probe) = scan.next_probe() else {
                    return Ok(false);
                };
                let reply = ask(parties, probe.request()).await?;
                scan.report(reply.bytes.as_deref());
            }
            Self::Services { parties, scan } => {
                let Some(probe) = scan.next_probe() else {
                    return Ok(false);
                };
                let reply = ask(parties, probe.request()).await?;
                scan.report(reply.bytes.as_deref());
            }
            Self::Addresses {
                session_id,
                bus,
                extended,
                scan,
                answered,
            } => {
                let Some(probe) = scan.next_probe() else {
                    return Ok(false);
                };
                let route = Route {
                    session_id: session_id.clone(),
                    bus: *bus,
                    extended: *extended,
                    id: probe.address,
                };
                let heard = probe_address(route, probe).await?;
                let ecu_answered = scan.report(heard.as_ref().map(|h| &h.data[..]));
                if let (Some(true), Some(heard)) = (ecu_answered, heard) {
                    answered.push(Answered {
                        request_id: probe.address,
                        response_id: heard.id,
                    });
                }
            }
        }
        Ok(true)
    }

    fn report(&self, scan_id: &str, status: ScanStatus, error: Option<String>) -> ScanReport {
        let (progress, findings) = match self {
            Self::Dids { scan, .. } => {
                let found = scan
                    .findings()
                    .iter()
                    .filter(|f| f.verdict != DidVerdict::Absent)
                    .copied();
                (scan.progress(), Findings::Dids(found.collect()))
            }
            Self::Services { scan, .. } => (
                scan.progress(),
                Findings::Services(scan.findings().to_vec()),
            ),
            Self::Addresses { scan, answered, .. } => {
                (scan.progress(), Findings::Addresses(answered.clone()))
            }
        };
        ScanReport {
            scan_id: scan_id.into(),
            status,
            progress,
            findings,
            error,
        }
    }
}

struct Heard {
    id: u32,
    data: Vec<u8>,
}

impl AsRef<[u8]> for Heard {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

/// Single frames from any id but the one probed, which is its own echo.
struct AnyId {
    tap: Tap,
    probed: u32,
}

impl Messages for AnyId {
    type Message = Heard;

    async fn next(&mut self) -> Option<Heard> {
        loop {
            let frame = self.tap.frames.recv().await?;
            if frame.frame_id == self.probed {
                continue;
            }
            if let Step::Message(data) = Reassembler::with_framing(0, StMin(0), framing())
                .on_frame(&frame.bytes)
                .step
            {
                return Some(Heard {
                    id: frame.frame_id,
                    data,
                });
            }
        }
    }

    fn is_receiving(&self) -> bool {
        false
    }
}

/// No flow control is ever sent for what it hears: on a bus of other traffic
/// a frame that looks like a first frame usually is not one.
async fn probe_address(route: Route, probe: AddressProbe) -> Result<Option<Heard>, String> {
    let listen = Listen {
        bus: route.bus,
        extended: route.extended,
        id: None,
    };
    let mut heard = AnyId {
        tap: tap::listen(&route.session_id, listen),
        probed: probe.address,
    };
    let mut client = Client::new(super::timing());
    let request = probe.request();
    let message = request.request().encode();
    let frame = Segmenter::with_framing(&message, &framing())
        .map_err(|e| e.to_string())?
        .first();
    route.send(frame).await?;
    client
        .send_read_only(request, Instant::now())
        .map_err(|busy| busy.to_string())?;
    Ok(await_final(&mut client, &mut heard).await.1)
}

struct Running {
    session_id: String,
    report: ScanReport,
    stop: Arc<AtomicBool>,
}

static SCANS: Lazy<Mutex<HashMap<String, Running>>> = Lazy::new(Default::default);
static NEXT_SCAN: AtomicU64 = AtomicU64::new(1);

fn scans() -> std::sync::MutexGuard<'static, HashMap<String, Running>> {
    SCANS.lock().unwrap_or_else(|e| e.into_inner())
}

fn publish(report: ScanReport) {
    if let Some(running) = scans().get_mut(&report.scan_id) {
        running.report = report;
    }
}

/// Returns the scan's id at once; [`report`] follows it.
pub async fn start(plan: Plan) -> Result<String, String> {
    plan.check().await?;
    let scan_id = format!("uds-scan-{}", NEXT_SCAN.fetch_add(1, Ordering::Relaxed));
    let stop = Arc::new(AtomicBool::new(false));
    let running = Running {
        session_id: plan.session_id().into(),
        report: plan.report(&scan_id, ScanStatus::Scanning, None),
        stop: stop.clone(),
    };
    scans().insert(scan_id.clone(), running);
    tokio::spawn(run(scan_id.clone(), plan, stop));
    Ok(scan_id)
}

async fn run(scan_id: String, mut plan: Plan, stop: Arc<AtomicBool>) {
    let (status, error) = loop {
        if stop.load(Ordering::Relaxed) {
            break (ScanStatus::Stopped, None);
        }
        match plan.step().await {
            Ok(true) => publish(plan.report(&scan_id, ScanStatus::Scanning, None)),
            Ok(false) => break (ScanStatus::Complete, None),
            Err(e) => break (ScanStatus::Failed, Some(e)),
        }
    };
    publish(plan.report(&scan_id, status, error));
}

pub fn report(scan_id: &str) -> Option<ScanReport> {
    scans().get(scan_id).map(|running| running.report.clone())
}

/// The probe in flight finishes first.
pub fn stop(scan_id: &str) -> Result<(), String> {
    let scans = scans();
    let running = scans
        .get(scan_id)
        .ok_or_else(|| format!("Scan '{scan_id}' not found"))?;
    running.stop.store(true, Ordering::Relaxed);
    Ok(())
}

pub(super) fn stop_session(session_id: &str) {
    for running in scans().values().filter(|r| r.session_id == session_id) {
        running.stop.store(true, Ordering::Relaxed);
    }
}
