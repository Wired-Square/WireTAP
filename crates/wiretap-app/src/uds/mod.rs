//! A read-only UDS tester on a session: one client per bus, tester id and ECU
//! id, dropped with the session. What it sends goes through the session, so it
//! lands in the session's capture.

mod isotp;
mod scan;
pub mod tap;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use wslib_uds::{Client, DtcRequest, Event, NonEmpty, ReadOnly, Request, SubFunction, Timing};

use isotp::{Link, Route};
pub use scan::{report as scan_report, start as start_scan, stop as stop_scan, Plan};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Parties {
    pub session_id: String,
    pub bus: u8,
    pub extended: bool,
    pub tester: u32,
    pub ecu: u32,
}

impl Parties {
    async fn check(&self) -> Result<(), String> {
        check_ids(self.extended, [self.tester, self.ecu])?;
        if self.tester == self.ecu {
            return Err("the tester and the ECU need ids of their own".into());
        }
        check_session(&self.session_id).await
    }
}

fn check_ids(extended: bool, ids: impl IntoIterator<Item = u32>) -> Result<(), String> {
    let (widest, bits) = if extended {
        (0x1FFF_FFFF, 29)
    } else {
        (0x7FF, 11)
    };
    match ids.into_iter().find(|id| *id > widest) {
        Some(id) => Err(format!("0x{id:X} does not fit in {bits} bits")),
        None => Ok(()),
    }
}

async fn check_session(session_id: &str) -> Result<(), String> {
    match crate::io::session_exists(session_id).await {
        true => Ok(()),
        false => Err(format!("Session '{session_id}' not found")),
    }
}

/// A request's final event, and the message that ended it: `None` for a
/// timeout or a suppressed answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub event: Event,
    pub bytes: Option<Vec<u8>>,
}

impl Serialize for Reply {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match &self.event {
            Event::Positive(response) => {
                map.serialize_entry("outcome", "positive")?;
                map.serialize_entry("response", response)?;
            }
            Event::Negative { service, code } => {
                map.serialize_entry("outcome", "negative")?;
                map.serialize_entry("service", service)?;
                map.serialize_entry("code", code)?;
                map.serialize_entry("meaning", &code.name())?;
            }
            Event::Malformed(_) => map.serialize_entry("outcome", "malformed")?,
            Event::Timeout { service } => {
                map.serialize_entry("outcome", "timeout")?;
                map.serialize_entry("service", service)?;
            }
            Event::Suppressed { service } => {
                map.serialize_entry("outcome", "suppressed")?;
                map.serialize_entry("service", service)?;
            }
            other => map.serialize_entry("outcome", &format!("{other:?}"))?,
        }
        map.serialize_entry("bytes", &self.bytes)?;
        map.end()
    }
}

/// Where a request's answer comes from.
trait Messages {
    type Message: AsRef<[u8]>;
    async fn next(&mut self) -> Option<Self::Message>;
    /// An answer is part way in, so the client's deadline waits for it.
    fn is_receiving(&self) -> bool;
}

/// How often a deadline that fell due mid-message looks again.
const RECHECK: Duration = Duration::from_millis(20);

/// Received frames reach a tap in the broker's batches, up to 50 ms late.
const TRANSPORT_DELAY: Duration = Duration::from_millis(150);

pub(super) fn timing() -> Timing {
    Timing { margin: TRANSPORT_DELAY, ..Timing::default() }
}

/// Waits out responsePending answers and messages that answer something else.
/// The client times only whole messages, so a deadline that falls while one is
/// part way in waits for it; ISO-TP's own N_Cr gives up on a stalled one.
async fn await_final<M: Messages>(
    client: &mut Client,
    messages: &mut M,
) -> (Event, Option<M::Message>) {
    loop {
        let due = client
            .next_deadline()
            .unwrap_or_else(|| Instant::now() + client.timing().p2_star);
        let until = match messages.is_receiving() {
            true => due.max(Instant::now() + RECHECK),
            false => due,
        };
        match tokio::time::timeout_at(until.into(), messages.next()).await {
            Ok(Some(message)) => match client.receive(message.as_ref(), Instant::now()) {
                event @ (Event::Positive(_) | Event::Negative { .. } | Event::Malformed(_)) => {
                    return (event, Some(message))
                }
                _ => continue,
            },
            Ok(None) => tokio::time::sleep_until(until.into()).await,
            Err(_) => {}
        }
        if messages.is_receiving() {
            continue;
        }
        if let Some(event @ (Event::Timeout { .. } | Event::Suppressed { .. })) =
            client.poll(Instant::now())
        {
            return (event, None);
        }
    }
}

struct Tester {
    client: Client,
    link: Link,
}

impl Tester {
    fn open(parties: &Parties) -> Self {
        let route = Route {
            session_id: parties.session_id.clone(),
            bus: parties.bus,
            extended: parties.extended,
            id: parties.tester,
        };
        Self {
            client: Client::new(timing()),
            link: Link::open(route, parties.ecu),
        }
    }

    /// P2 runs from the end of the request, so the client is told of it once sent.
    async fn ask(&mut self, request: ReadOnly) -> Result<Reply, String> {
        self.link.discard_late();
        self.link.send(&request.request().encode()).await?;
        self.client
            .send_read_only(request, Instant::now())
            .map_err(|busy| busy.to_string())?;
        let (event, bytes) = await_final(&mut self.client, &mut self.link).await;
        Ok(Reply { event, bytes })
    }
}

type Shared = Arc<tokio::sync::Mutex<Tester>>;

static TESTERS: Lazy<Mutex<HashMap<Parties, Shared>>> = Lazy::new(Default::default);

fn testers() -> MutexGuard<'static, HashMap<Parties, Shared>> {
    TESTERS.lock().unwrap_or_else(|e| e.into_inner())
}

async fn tester(parties: &Parties) -> Result<Shared, String> {
    parties.check().await?;
    let mut testers = testers();
    let tester = testers
        .entry(parties.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(Tester::open(parties))));
    Ok(tester.clone())
}

/// One request and its final answer; another request to the same ECU waits its turn.
async fn ask(parties: &Parties, request: ReadOnly) -> Result<Reply, String> {
    let tester = tester(parties).await?;
    let mut tester = tester.lock().await;
    tester.ask(request).await
}

fn read_only(request: Request) -> ReadOnly {
    ReadOnly::new(request).expect("0x19, 0x22 and 0x3E are read-only")
}

pub async fn tester_present(parties: &Parties) -> Result<Reply, String> {
    ask(
        parties,
        read_only(Request::TesterPresent {
            sub_function: SubFunction::new(0),
        }),
    )
    .await
}

/// Several DIDs go in one request.
pub async fn read_data_by_identifier(parties: &Parties, dids: Vec<u16>) -> Result<Reply, String> {
    let dids = NonEmpty::new(dids).map_err(|_| "name at least one DID".to_string())?;
    ask(parties, read_only(Request::ReadDataByIdentifier { dids })).await
}

pub async fn read_dtc_information(parties: &Parties, report: DtcRequest) -> Result<Reply, String> {
    let request = Request::ReadDtcInformation {
        report,
        suppress_positive_response: false,
    };
    ask(parties, read_only(request)).await
}

/// Drops the session's testers and stops its scans.
pub fn forget_session(session_id: &str) {
    testers().retain(|parties, _| parties.session_id != session_id);
    scan::stop_session(session_id);
}
