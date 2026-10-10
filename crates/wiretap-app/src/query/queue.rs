// crates/wiretap-app/src/query/queue.rs
//
// The Query app's queue as process state: one query runs at a time, every
// change is pushed whole to every window, and results stay here until the
// query is removed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::AppHandle;
use wiretap_gateway::QueryStats;

use super::{QueryOutcome, QueryRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum QueryStatus {
    Pending,
    Running,
    Completed,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueryItem {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub request: QueryRequest,
    pub status: QueryStatus,
    pub submitted_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<String>,
    pub result_count: Option<u64>,
    pub stats: Option<QueryStats>,
}

/// The whole queue; `revision` rises with every change.
#[derive(Debug, Clone, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueryQueue {
    pub revision: u64,
    pub items: Vec<QueryItem>,
}

#[derive(Default)]
struct State {
    queue: QueryQueue,
    outcomes: HashMap<String, QueryOutcome>,
    running: Option<(String, Arc<AtomicBool>)>,
    working: bool,
}

static STATE: Lazy<Mutex<State>> = Lazy::new(Mutex::default);

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> i64 {
    (crate::io::now_us() / 1000) as i64
}

fn publish(state: &mut State) {
    state.queue.revision += 1;
    crate::ws::dispatch::send_query_queue(&state.queue);
}

/// The next pending query, marked running.
fn start_next() -> Option<(String, QueryRequest, Arc<AtomicBool>)> {
    let mut state = state();
    let Some(next) = state.queue.items.iter_mut().find(|i| i.status == QueryStatus::Pending) else {
        state.working = false;
        return None;
    };
    next.status = QueryStatus::Running;
    next.started_at_ms = Some(now_ms());
    let (id, request) = (next.id.clone(), next.request.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    state.running = Some((id.clone(), Arc::clone(&cancel)));
    publish(&mut state);
    Some((id, request, cancel))
}

fn finish(id: &str, outcome: Result<QueryOutcome, String>) {
    let mut state = state();
    state.running = None;
    let Some(item) = state.queue.items.iter_mut().find(|i| i.id == id) else { return };
    item.completed_at_ms = Some(now_ms());
    match outcome {
        Ok(outcome) => {
            item.status = QueryStatus::Completed;
            item.result_count = Some(outcome.results.len() as u64);
            item.stats = outcome.stats.clone();
            state.outcomes.insert(id.to_string(), outcome);
        }
        Err(e) => {
            item.status = QueryStatus::Error;
            item.error = Some(e);
        }
    }
    publish(&mut state);
}

async fn work(app: AppHandle) {
    while let Some((id, request, cancel)) = start_next() {
        let outcome = super::run(&app, &request, &id, &cancel).await;
        finish(&id, outcome);
    }
}

/// Stop the running query if it is `id`.
async fn cancel_running(id: &str) {
    let running = state().running.clone();
    if let Some((running_id, cancel)) = running.filter(|(r, _)| r == id) {
        cancel.store(true, Ordering::Relaxed);
        crate::apiclient::cancel_query(&running_id).await;
    }
}

#[tauri::command]
pub fn query_queue_get() -> QueryQueue {
    state().queue.clone()
}

#[tauri::command]
pub fn query_enqueue(app: AppHandle, label: String, request: QueryRequest) -> String {
    let id = super::new_query_id();
    let mut state = state();
    state.queue.items.push(QueryItem {
        id: id.clone(),
        label,
        request,
        status: QueryStatus::Pending,
        submitted_at_ms: now_ms(),
        started_at_ms: None,
        completed_at_ms: None,
        error: None,
        result_count: None,
        stats: None,
    });
    publish(&mut state);
    if !state.working {
        state.working = true;
        tauri::async_runtime::spawn(work(app));
    }
    id
}

/// Remove a query, cancelling it if it is running.
#[tauri::command]
pub async fn query_remove(id: String) {
    cancel_running(&id).await;
    let mut state = state();
    state.queue.items.retain(|i| i.id != id);
    state.outcomes.remove(&id);
    publish(&mut state);
}

#[tauri::command]
pub fn query_result(id: String) -> Result<QueryOutcome, String> {
    state().outcomes.get(&id).cloned().ok_or_else(|| format!("No results for query {id}"))
}

#[tauri::command]
pub fn query_export_csv(id: String) -> Result<String, String> {
    state()
        .outcomes
        .get(&id)
        .map(|o| super::csv::render(&o.results))
        .ok_or_else(|| format!("No results for query {id}"))
}

#[tauri::command]
pub async fn query_preview(app: AppHandle, request: QueryRequest) -> Result<Vec<String>, String> {
    super::preview(&app, &request).await
}
