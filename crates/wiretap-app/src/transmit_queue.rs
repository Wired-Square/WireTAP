// Copyright 2026 Wired Square Pty Ltd

//! The Transmit queue as process state: every window and the MCP read and edit
//! one queue, its repeats run here, and each change is pushed whole over WS.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::io::periodic::Cadence;
use crate::io::{CanTransmitFrame, SignalThrottle};
use crate::transmit::{Outgoing, SerialFraming};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueuePayload {
    Can { frame: CanTransmitFrame },
    /// `bytes` before framing.
    Serial {
        bytes: Vec<u8>,
        #[serde(default)]
        framing: SerialFraming,
    },
}

impl QueuePayload {
    fn outgoing(&self) -> Outgoing {
        match self {
            Self::Can { frame } => Outgoing::Can(frame.clone()),
            Self::Serial { bytes, framing } => Outgoing::Serial(framing.frame(bytes)),
        }
    }

    fn is_can(&self) -> bool {
        matches!(self, Self::Can { .. })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum QueueOrigin {
    #[default]
    User,
    Agent,
}

/// The session a row sends through, and the profile it is shown under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueueRowSession {
    pub session_id: String,
    pub profile_id: String,
    pub profile_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueueRow {
    pub id: String,
    #[serde(flatten)]
    pub session: QueueRowSession,
    pub payload: QueuePayload,
    pub interval_ms: u64,
    pub enabled: bool,
    pub group: Option<String>,
    pub origin: QueueOrigin,
    /// Sending now, on its own or in its running group.
    pub repeating: bool,
    /// Why its last repeat stopped by itself.
    pub last_error: Option<String>,
}

/// The whole queue; `revision` rises with every change.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TransmitQueue {
    pub revision: u64,
    pub rows: Vec<QueueRow>,
    pub active_groups: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct NewQueueRow {
    #[serde(flatten)]
    pub session: QueueRowSession,
    pub payload: QueuePayload,
    pub interval_ms: u64,
    #[serde(default)]
    pub group: Option<String>,
}

/// The fields to change; a blank `group` clears it.
#[derive(Clone, Debug, Default, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct QueueRowEdit {
    pub interval_ms: Option<u64>,
    pub enabled: Option<bool>,
    pub bus: Option<u8>,
    pub group: Option<String>,
    pub session: Option<QueueRowSession>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum RepeatKey {
    Row(String),
    Group(String),
}

/// A repeat that is sending, and the rows it sends as they were at its start.
struct Running {
    cancel: Arc<AtomicBool>,
    rows: Vec<String>,
}

#[derive(Default)]
struct Queue {
    rows: Vec<QueueRow>,
    running: HashMap<RepeatKey, Running>,
    revision: u64,
    next_id: u64,
}

fn group_name(group: Option<String>) -> Option<String> {
    group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty())
}

fn check_interval(interval_ms: u64) -> Result<(), String> {
    if interval_ms == 0 {
        return Err("Interval must be at least 1ms".to_string());
    }
    Ok(())
}

impl Queue {
    fn row(&self, id: &str) -> Result<&QueueRow, String> {
        self.rows.iter().find(|r| r.id == id).ok_or_else(|| format!("No queue row '{id}'"))
    }

    /// The running repeats that send row `id`.
    fn sending(&self, id: &str) -> Vec<RepeatKey> {
        self.running.iter().filter(|(_, r)| r.rows.iter().any(|row| row == id)).map(|(key, _)| key.clone()).collect()
    }

    fn snapshot(&self) -> TransmitQueue {
        let mut active_groups: Vec<String> = self
            .running
            .keys()
            .filter_map(|k| match k {
                RepeatKey::Group(g) => Some(g.clone()),
                RepeatKey::Row(_) => None,
            })
            .collect();
        active_groups.sort();
        TransmitQueue {
            revision: self.revision,
            rows: self.rows.iter().map(|r| QueueRow { repeating: !self.sending(&r.id).is_empty(), ..r.clone() }).collect(),
            active_groups,
        }
    }

    fn add(&mut self, rows: Vec<NewQueueRow>, origin: QueueOrigin) -> Result<Vec<String>, String> {
        for row in &rows {
            check_interval(row.interval_ms)?;
            if matches!(&row.payload, QueuePayload::Serial { bytes, .. } if bytes.is_empty()) {
                return Err("No bytes to transmit".to_string());
            }
        }
        Ok(rows
            .into_iter()
            .map(|row| {
                self.next_id += 1;
                let id = format!("tx-{}", self.next_id);
                self.rows.push(QueueRow {
                    id: id.clone(),
                    session: row.session,
                    payload: row.payload,
                    interval_ms: row.interval_ms,
                    enabled: true,
                    group: group_name(row.group),
                    origin,
                    repeating: false,
                    last_error: None,
                });
                id
            })
            .collect())
    }

    /// A row that is sending keeps its definition until it is stopped, so what
    /// it shows is always what goes out.
    fn edit(&mut self, id: &str, edit: QueueRowEdit) -> Result<(), String> {
        self.row(id)?;
        if !self.sending(id).is_empty() {
            return Err("Stop the repeat before changing this row".to_string());
        }
        if let Some(interval_ms) = edit.interval_ms {
            check_interval(interval_ms)?;
        }
        let row = self.rows.iter_mut().find(|r| r.id == id).expect("found above");
        if let Some(interval_ms) = edit.interval_ms {
            row.interval_ms = interval_ms;
        }
        if let Some(enabled) = edit.enabled {
            row.enabled = enabled;
        }
        if let (Some(bus), QueuePayload::Can { frame }) = (edit.bus, &mut row.payload) {
            frame.bus = bus;
        }
        if edit.group.is_some() {
            row.group = group_name(edit.group);
        }
        if let Some(session) = edit.session {
            row.session = session;
        }
        Ok(())
    }

    /// Removes the rows `matches` picks, stopping whatever sends them.
    fn remove(&mut self, matches: impl Fn(&QueueRow) -> bool) {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.rows).into_iter().partition(|r| matches(r));
        self.rows = kept;
        for key in gone.iter().flat_map(|r| self.sending(&r.id)).collect::<Vec<_>>() {
            self.stop(&key);
        }
    }

    fn stop(&mut self, key: &RepeatKey) {
        if let Some(running) = self.running.remove(key) {
            running.cancel.store(true, Ordering::Relaxed);
        }
    }

    fn stop_all(&mut self) {
        for (_, running) in self.running.drain() {
            running.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// The enabled CAN rows of `group`, in queue order.
    fn group_members(&self, group: &str) -> Result<Vec<QueueRow>, String> {
        let members: Vec<QueueRow> = self
            .rows
            .iter()
            .filter(|r| r.group.as_deref() == Some(group) && r.enabled && r.payload.is_can())
            .cloned()
            .collect();
        if members.is_empty() {
            return Err(format!("No enabled CAN frames in group '{group}'"));
        }
        Ok(members)
    }

    /// Starts sending `ids` as they stand, every interval of the first one.
    fn launch(&mut self, key: RepeatKey, ids: Vec<String>) -> Result<(), String> {
        let members: Vec<&QueueRow> = ids.iter().map(|id| self.row(id)).collect::<Result<_, _>>()?;
        let interval_ms = members.first().ok_or("Nothing to send")?.interval_ms;
        let sends = members.iter().map(|r| (r.session.session_id.clone(), r.payload.outgoing())).collect();
        self.stop(&key);
        let cancel = Arc::new(AtomicBool::new(false));
        tauri::async_runtime::spawn(repeat(key.clone(), sends, interval_ms, cancel.clone()));
        for row in self.rows.iter_mut().filter(|r| ids.contains(&r.id)) {
            row.last_error = None;
        }
        self.running.insert(key, Running { cancel, rows: ids });
        Ok(())
    }

    /// A repeat that stopped by itself: its rows say why, unless a newer run has its key.
    fn ended(&mut self, key: &RepeatKey, cancel: &Arc<AtomicBool>, reason: &str) -> Result<(), String> {
        if !self.running.get(key).is_some_and(|r| Arc::ptr_eq(&r.cancel, cancel)) {
            return Err("superseded".to_string());
        }
        let ids = self.running.remove(key).map(|r| r.rows).unwrap_or_default();
        for row in self.rows.iter_mut().filter(|r| ids.contains(&r.id)) {
            row.last_error = Some(reason.to_string());
        }
        Ok(())
    }
}

static QUEUE: Lazy<Mutex<Queue>> = Lazy::new(Mutex::default);

fn queue() -> MutexGuard<'static, Queue> {
    QUEUE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Applies a change and, when it succeeds, pushes the queue to every window.
fn change<T>(apply: impl FnOnce(&mut Queue) -> Result<T, String>) -> Result<T, String> {
    let (out, snapshot) = {
        let mut q = queue();
        let out = apply(&mut q)?;
        q.revision += 1;
        (out, q.snapshot())
    };
    crate::ws::dispatch::send_transmit_queue(&snapshot);
    Ok(out)
}

pub fn snapshot() -> TransmitQueue {
    queue().snapshot()
}

pub fn add(rows: Vec<NewQueueRow>, origin: QueueOrigin) -> Result<Vec<String>, String> {
    change(|q| q.add(rows, origin))
}

pub fn edit(id: &str, edit: QueueRowEdit) -> Result<(), String> {
    change(|q| q.edit(id, edit))
}

pub fn remove(id: &str) -> Result<(), String> {
    change(|q| {
        q.row(id)?;
        q.remove(|r| r.id == id);
        Ok(())
    })
}

fn always(apply: impl FnOnce(&mut Queue)) {
    let _ = change(|q| {
        apply(q);
        Ok(())
    });
}

pub fn clear() {
    always(|q| q.remove(|_| true));
}

pub fn stop_all() {
    always(Queue::stop_all);
}

pub fn stop_row(id: &str) {
    always(|q| q.stop(&RepeatKey::Row(id.to_string())));
}

pub fn stop_group(group: &str) {
    always(|q| q.stop(&RepeatKey::Group(group.to_string())));
}

/// The queue's record of `session_id`: its first profile, by name.
pub fn session_row(app: &tauri::AppHandle, session_id: &str) -> QueueRowSession {
    let profile_id = crate::sessions::get_session_profile_ids(session_id).into_iter().next().unwrap_or_default();
    let profile_name = crate::settings::profile_by_id(app, &profile_id).map_or_else(|_| profile_id.clone(), |p| p.name);
    QueueRowSession { session_id: session_id.to_string(), profile_id, profile_name }
}

async fn check_session(session: &QueueRowSession, can: bool) -> Result<(), String> {
    let name = &session.profile_name;
    let traits = crate::io::get_session_capabilities(&session.session_id)
        .await
        .ok_or_else(|| format!("Session '{name}' is not connected. Connect to it first."))?
        .traits;
    match (can, traits.tx_frames, traits.tx_bytes) {
        (true, true, _) | (false, _, true) => Ok(()),
        (true, ..) => Err(format!("Session '{name}' does not support CAN transmit")),
        (false, ..) => Err(format!("Session '{name}' does not support serial transmit")),
    }
}

pub async fn start_row(id: &str) -> Result<(), String> {
    let row = queue().row(id)?.clone();
    if !row.enabled {
        return Err("This row is disabled".to_string());
    }
    check_session(&row.session, row.payload.is_can()).await?;
    change(|q| q.launch(RepeatKey::Row(row.id.clone()), vec![row.id]))
}

/// Starts `group` unless it is running. Every member's session must take CAN
/// frames, or nothing is sent.
pub async fn start_group(group: &str) -> Result<(), String> {
    let key = RepeatKey::Group(group.to_string());
    let members = {
        let q = queue();
        if q.running.contains_key(&key) {
            return Ok(());
        }
        q.group_members(group)?
    };
    for member in &members {
        check_session(&member.session, true).await?;
    }
    change(|q| q.launch(key, members.into_iter().map(|r| r.id).collect()))
}

pub async fn add_and_start(row: NewQueueRow, origin: QueueOrigin) -> Result<String, String> {
    let id = add(vec![row], origin)?.remove(0);
    if let Err(e) = start_row(&id).await {
        let _ = remove(&id);
        return Err(e);
    }
    Ok(id)
}

/// Sends every one of `sends` in order with no gap between them, then waits the
/// interval, until cancelled or a send fails for good.
async fn repeat(key: RepeatKey, sends: Vec<(String, Outgoing)>, interval_ms: u64, cancel: Arc<AtomicBool>) {
    let mut throttle = SignalThrottle::new();
    let mut cadence = Cadence::new(interval_ms, cancel.clone());
    while cadence.next().await.is_some() {
        for (session_id, out) in &sends {
            let result = crate::transmit::send_and_record(session_id, out).await;
            if let Some(reason) = crate::transmit::permanent_failure(session_id, &result).await {
                tlog!("[transmit_queue] Stopping {:?} on a permanent error: {}", key, reason);
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::next_revision());
                let _ = change(|q| q.ended(&key, &cancel, &reason));
                return;
            }
            if throttle.should_signal("transmit-updated") {
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::next_revision());
            }
        }
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub fn transmit_queue_get() -> TransmitQueue {
    snapshot()
}

#[tauri::command]
pub fn transmit_queue_add(rows: Vec<NewQueueRow>) -> Result<Vec<String>, String> {
    add(rows, QueueOrigin::User)
}

#[tauri::command]
pub fn transmit_queue_edit(id: String, edit: QueueRowEdit) -> Result<(), String> {
    self::edit(&id, edit)
}

#[tauri::command]
pub fn transmit_queue_remove(id: String) -> Result<(), String> {
    remove(&id)
}

#[tauri::command]
pub fn transmit_queue_clear() {
    clear();
}

#[tauri::command]
pub async fn transmit_queue_start(id: String) -> Result<(), String> {
    start_row(&id).await
}

#[tauri::command]
pub fn transmit_queue_stop(id: String) {
    stop_row(&id);
}

#[tauri::command]
pub async fn transmit_group_start(group: String) -> Result<(), String> {
    start_group(&group).await
}

#[tauri::command]
pub fn transmit_group_stop(group: String) {
    stop_group(&group);
}

#[tauri::command]
pub fn transmit_queue_stop_all() {
    stop_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::test_source::TestSource;
    use crate::io::{TransmitPayload, TransmitResult};
    use std::time::Duration;

    fn frame(frame_id: u32) -> CanTransmitFrame {
        CanTransmitFrame { frame_id, data: vec![0], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false }
    }

    fn session(session_id: &str) -> QueueRowSession {
        QueueRowSession { session_id: session_id.into(), profile_id: format!("p_{session_id}"), profile_name: format!("n_{session_id}") }
    }

    fn can_row(session_id: &str, frame_id: u32, interval_ms: u64, group: Option<&str>) -> NewQueueRow {
        NewQueueRow {
            session: session(session_id),
            payload: QueuePayload::Can { frame: frame(frame_id) },
            interval_ms,
            group: group.map(str::to_string),
        }
    }

    fn serial_row(session_id: &str, bytes: &[u8]) -> NewQueueRow {
        NewQueueRow {
            session: session(session_id),
            payload: QueuePayload::Serial { bytes: bytes.to_vec(), framing: SerialFraming::Raw },
            interval_ms: 1000,
            group: None,
        }
    }

    fn running(q: &mut Queue, key: RepeatKey, ids: &[&String]) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        q.running.insert(key, Running { cancel: cancel.clone(), rows: ids.iter().map(|id| id.to_string()).collect() });
        cancel
    }

    #[test]
    fn an_added_row_is_enabled_idle_and_a_blank_group_is_none() {
        let mut q = Queue::default();
        let ids = q.add(vec![can_row("a", 1, 50, Some("  ")), can_row("a", 2, 50, Some(" g "))], QueueOrigin::User).unwrap();
        let rows = q.snapshot().rows;
        assert_eq!(ids, ["tx-1", "tx-2"]);
        assert!(rows.iter().all(|r| r.enabled && !r.repeating && r.origin == QueueOrigin::User));
        assert_eq!(rows.iter().map(|r| r.group.as_deref()).collect::<Vec<_>>(), [None, Some("g")]);
    }

    #[test]
    fn an_add_refuses_a_zero_interval_or_empty_serial_bytes_and_adds_nothing() {
        let mut q = Queue::default();
        assert!(q.add(vec![can_row("a", 1, 50, None), can_row("a", 2, 0, None)], QueueOrigin::User).is_err());
        assert!(q.add(vec![serial_row("a", &[])], QueueOrigin::User).is_err());
        assert!(q.rows.is_empty());
    }

    #[test]
    fn a_sending_row_refuses_edits_and_an_idle_one_takes_them() {
        let mut q = Queue::default();
        let ids = q.add(vec![can_row("a", 1, 50, None), serial_row("a", &[1])], QueueOrigin::User).unwrap();
        running(&mut q, RepeatKey::Row(ids[0].clone()), &[&ids[0]]);
        assert!(q.edit(&ids[0], QueueRowEdit { interval_ms: Some(10), ..Default::default() }).is_err());
        assert!(q.edit(&ids[1], QueueRowEdit { interval_ms: Some(0), ..Default::default() }).is_err());

        let edit = QueueRowEdit { interval_ms: Some(10), enabled: Some(false), bus: Some(3), group: Some("g".into()), session: Some(session("b")) };
        q.edit(&ids[1], edit).unwrap();
        let row = &q.snapshot().rows[1];
        assert_eq!((row.interval_ms, row.enabled, row.group.as_deref(), row.session.session_id.as_str()), (10, false, Some("g"), "b"));
        assert_eq!(row.payload, QueuePayload::Serial { bytes: vec![1], framing: SerialFraming::Raw }, "bus is a CAN field");
    }

    #[test]
    fn a_running_group_marks_the_rows_it_sends_and_refuses_their_edits() {
        let mut q = Queue::default();
        let ids = q.add(vec![can_row("a", 1, 50, Some("g")), can_row("a", 2, 50, Some("g")), can_row("a", 3, 50, None)], QueueOrigin::User).unwrap();
        q.edit(&ids[1], QueueRowEdit { enabled: Some(false), ..Default::default() }).unwrap();
        running(&mut q, RepeatKey::Group("g".into()), &[&ids[0]]);
        q.edit(&ids[1], QueueRowEdit { enabled: Some(true), ..Default::default() }).unwrap();

        let snapshot = q.snapshot();
        assert_eq!(snapshot.active_groups, ["g"]);
        assert_eq!(snapshot.rows.iter().map(|r| r.repeating).collect::<Vec<_>>(), [true, false, false], "a row enabled after the start is not sent");
        assert!(q.edit(&ids[0], QueueRowEdit { enabled: Some(false), ..Default::default() }).is_err());
    }

    #[test]
    fn group_members_are_its_enabled_can_rows_in_queue_order() {
        let mut q = Queue::default();
        let ids = q
            .add(
                vec![can_row("a", 1, 10, Some("g")), can_row("b", 2, 20, Some("g")), can_row("a", 3, 30, Some("g")), can_row("a", 4, 40, Some("g")), can_row("a", 5, 50, Some("h"))],
                QueueOrigin::User,
            )
            .unwrap();
        q.edit(&ids[2], QueueRowEdit { enabled: Some(false), ..Default::default() }).unwrap();
        let members = q.group_members("g").unwrap();
        assert_eq!(members.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [&ids[0], &ids[1], &ids[3]]);
        assert_eq!(members[0].interval_ms, 10);
        assert!(q.group_members("none").is_err());
    }

    #[test]
    fn removing_a_row_stops_its_repeat_and_its_group() {
        let mut q = Queue::default();
        let ids = q.add(vec![can_row("a", 1, 50, Some("g")), can_row("a", 2, 50, None)], QueueOrigin::User).unwrap();
        let group = running(&mut q, RepeatKey::Group("g".into()), &[&ids[0]]);
        let alone = running(&mut q, RepeatKey::Row(ids[1].clone()), &[&ids[1]]);
        q.remove(|r| r.id == ids[0]);
        assert!(group.load(Ordering::Relaxed) && !alone.load(Ordering::Relaxed));
        q.stop_all();
        assert!(alone.load(Ordering::Relaxed) && q.running.is_empty());
    }

    // The tests below drive the process queue, so each uses rows and groups of its own.

    type Sent = Arc<std::sync::Mutex<Vec<(String, u32)>>>;

    async fn open_recording(session_id: &str, sent: &Sent) {
        let sent = sent.clone();
        let source = TestSource::new(session_id).transmitting(move |session_id, payload| {
            if let TransmitPayload::CanFrame(frame) = payload {
                sent.lock().unwrap().push((session_id.to_string(), frame.frame_id));
            }
            TransmitResult::success()
        });
        crate::io::create_session(session_id.into(), Box::new(source), None, None, None, vec![]).await;
        crate::io::start_session(session_id).await.unwrap();
    }

    async fn until(mut done: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !done() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the repeat never got there");
    }

    fn row_of(id: &str) -> QueueRow {
        snapshot().rows.into_iter().find(|r| r.id == id).expect("row")
    }

    #[tokio::test]
    async fn one_group_repeats_across_two_sessions_in_its_order() {
        let sent = Sent::default();
        open_recording("f_qgroup_a", &sent).await;
        open_recording("f_qgroup_b", &sent).await;
        let g = Some("q_two");
        let ids = add(vec![can_row("f_qgroup_a", 1, 10_000, g), can_row("f_qgroup_b", 2, 10_000, g), can_row("f_qgroup_a", 3, 10_000, g)], QueueOrigin::User).unwrap();

        start_group("q_two").await.unwrap();
        until(|| sent.lock().unwrap().len() >= 3).await;
        assert!(row_of(&ids[1]).repeating);
        stop_group("q_two");

        let a = |id| ("f_qgroup_a".to_string(), id);
        assert_eq!(*sent.lock().unwrap(), [a(1), ("f_qgroup_b".to_string(), 2), a(3)]);
        assert!(!row_of(&ids[1]).repeating);
        queue().remove(|r| ids.contains(&r.id));
        for id in ["f_qgroup_a", "f_qgroup_b"] {
            crate::io::destroy_session(id, false).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_group_with_a_member_session_gone_sends_nothing() {
        let sent = Sent::default();
        open_recording("f_qgroup_alive", &sent).await;
        let g = Some("q_gone");
        let ids = add(vec![can_row("f_qgroup_alive", 1, 1, g), can_row("f_qgroup_missing", 2, 1, g)], QueueOrigin::User).unwrap();

        let refused = start_group("q_gone").await.unwrap_err();

        assert!(refused.contains("n_f_qgroup_missing"), "{refused}");
        assert!(sent.lock().unwrap().is_empty());
        assert!(!snapshot().active_groups.contains(&"q_gone".to_string()));
        queue().remove(|r| ids.contains(&r.id));
        crate::io::destroy_session("f_qgroup_alive", false).await.unwrap();
    }

    #[tokio::test]
    async fn a_repeat_whose_session_goes_stops_and_says_why() {
        let sent = Sent::default();
        open_recording("f_qrow_going", &sent).await;
        let id = add(vec![can_row("f_qrow_going", 7, 1, None)], QueueOrigin::User).unwrap().remove(0);
        start_row(&id).await.unwrap();
        until(|| !sent.lock().unwrap().is_empty()).await;

        crate::io::destroy_session("f_qrow_going", false).await.unwrap();
        until(|| !row_of(&id).repeating).await;

        assert!(row_of(&id).last_error.is_some());
        remove(&id).unwrap();
    }

    #[tokio::test]
    async fn a_disabled_row_does_not_start() {
        let id = add(vec![can_row("f_qrow_disabled", 1, 10, None)], QueueOrigin::User).unwrap().remove(0);
        edit(&id, QueueRowEdit { enabled: Some(false), ..Default::default() }).unwrap();
        assert!(start_row(&id).await.is_err());
        assert!(!row_of(&id).repeating);
        remove(&id).unwrap();
    }

    #[tokio::test]
    async fn an_agent_repeat_is_a_queue_row_and_one_refused_leaves_none() {
        let sent = Sent::default();
        open_recording("f_qagent", &sent).await;
        let id = add_and_start(can_row("f_qagent", 9, 10_000, None), QueueOrigin::Agent).await.unwrap();
        let row = row_of(&id);
        assert_eq!((row.origin, row.repeating), (QueueOrigin::Agent, true));
        remove(&id).unwrap();

        assert!(add_and_start(can_row("f_qagent_missing", 9, 10, None), QueueOrigin::Agent).await.is_err());
        assert!(snapshot().rows.iter().all(|r| r.session.session_id != "f_qagent_missing"));
        crate::io::destroy_session("f_qagent", false).await.unwrap();
    }

    #[test]
    fn a_row_serialises_flat_with_its_payload_tagged() {
        let mut q = Queue::default();
        q.add(vec![serial_row("a", &[0x41])], QueueOrigin::Agent).unwrap();
        let json = serde_json::to_value(&q.snapshot().rows[0]).unwrap();
        assert_eq!(json["session_id"], "a");
        assert_eq!(json["origin"], "agent");
        assert_eq!(json["payload"], serde_json::json!({ "kind": "serial", "bytes": [0x41], "framing": { "mode": "raw" } }));
    }
}
