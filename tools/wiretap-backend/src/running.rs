//! Running-query registry: query_id → CancelToken, the backend counterpart
//! of RUNNING_QUERIES in the desktop's dbquery.rs. DELETE /v1/queries/{id}
//! cancels the in-flight statement.

use std::collections::HashMap;
use std::sync::LazyLock;

use tokio::sync::Mutex;
use tokio_postgres::{CancelToken, NoTls};

static RUNNING: LazyLock<Mutex<HashMap<String, CancelToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub async fn register(query_id: &str, token: CancelToken) {
    RUNNING.lock().await.insert(query_id.to_string(), token);
}

pub async fn unregister(query_id: &str) {
    RUNNING.lock().await.remove(query_id);
}

/// Cancel a running query. Ok(false) = unknown id.
pub async fn cancel(query_id: &str) -> Result<bool, String> {
    let token = RUNNING.lock().await.remove(query_id);
    match token {
        Some(token) => {
            token
                .cancel_query(NoTls)
                .await
                .map_err(|e| format!("cancel failed: {e}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// RAII guard: unregisters on drop so error paths can't leak entries.
pub struct QueryGuard {
    id: String,
}

impl QueryGuard {
    pub async fn new(query_id: String, token: CancelToken) -> Self {
        register(&query_id, token).await;
        Self { id: query_id }
    }
}

impl Drop for QueryGuard {
    fn drop(&mut self) {
        let id = std::mem::take(&mut self.id);
        tokio::spawn(async move { unregister(&id).await });
    }
}
