// ui/src-tauri/src/dbquery.rs
//
// Database query commands for the Query app. Provides analytical queries
// against PostgreSQL data sources to find historical patterns and changes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio_postgres::{CancelToken, NoTls};

use crate::credentials::get_credential;
use crate::settings::{load_settings, IOProfile};

/// Information about a running query
pub struct RunningQuery {
    pub query_type: String,
    pub profile_id: String,
    pub started_at: std::time::Instant,
    pub cancel_token: CancelToken,
}

/// Simplified view of a running query for status logging (without CancelToken)
#[derive(Debug, Clone)]
pub struct RunningQueryInfo {
    pub query_type: String,
    pub profile_id: String,
    pub started_at: std::time::Instant,
}

/// Global state for tracking running queries
static RUNNING_QUERIES: LazyLock<Mutex<HashMap<String, Arc<RunningQuery>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register a query as running
async fn register_query(id: &str, query_type: &str, profile_id: &str, cancel_token: CancelToken) {
    let mut queries = RUNNING_QUERIES.lock().await;
    queries.insert(
        id.to_string(),
        Arc::new(RunningQuery {
            query_type: query_type.to_string(),
            profile_id: profile_id.to_string(),
            started_at: std::time::Instant::now(),
            cancel_token,
        }),
    );
}

/// Unregister a query when complete
async fn unregister_query(id: &str) {
    let mut queries = RUNNING_QUERIES.lock().await;
    queries.remove(id);
}

/// Get running queries for status logging
pub async fn get_running_queries() -> Vec<(String, RunningQueryInfo)> {
    let queries = RUNNING_QUERIES.lock().await;
    queries
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                RunningQueryInfo {
                    query_type: v.query_type.clone(),
                    profile_id: v.profile_id.clone(),
                    started_at: v.started_at,
                },
            )
        })
        .collect()
}

/// Cancel a running database query
#[tauri::command]
pub async fn db_cancel_query(query_id: String) -> Result<(), String> {
    let query = {
        let queries = RUNNING_QUERIES.lock().await;
        queries.get(&query_id).cloned()
    };

    if let Some(query) = query {
        println!("[dbquery] Cancelling query: {}", query_id);
        query
            .cancel_token
            .cancel_query(NoTls)
            .await
            .map_err(|e| format!("Failed to cancel query: {}", e))?;
        println!("[dbquery] Query cancelled: {}", query_id);

        // Remove from running queries
        unregister_query(&query_id).await;
        Ok(())
    } else {
        Err(format!("Query not found: {}", query_id))
    }
}

/// Result of a byte change query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByteChangeResult {
    pub timestamp_us: i64,
    pub old_value: u8,
    pub new_value: u8,
}

/// Result of a frame change query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameChangeResult {
    pub timestamp_us: i64,
    pub old_payload: Vec<u8>,
    pub new_payload: Vec<u8>,
    pub changed_indices: Vec<usize>,
}

/// Query statistics returned with results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryStats {
    /// Number of rows fetched from the database
    pub rows_scanned: usize,
    /// Number of results after filtering
    pub results_count: usize,
    /// Query execution time in milliseconds
    pub execution_time_ms: u64,
}

/// Wrapper for byte change query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByteChangeQueryResult {
    pub results: Vec<ByteChangeResult>,
    pub stats: QueryStats,
}

/// Wrapper for frame change query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameChangeQueryResult {
    pub results: Vec<FrameChangeResult>,
    pub stats: QueryStats,
}

/// Result of a mirror validation query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorValidationResult {
    pub mirror_timestamp_us: i64,
    pub source_timestamp_us: i64,
    pub mirror_payload: Vec<u8>,
    pub source_payload: Vec<u8>,
    pub mismatch_indices: Vec<usize>,
}

/// Wrapper for mirror validation query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorValidationQueryResult {
    pub results: Vec<MirrorValidationResult>,
    pub stats: QueryStats,
}

/// A running query or session from pg_stat_activity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseActivity {
    /// Process ID (pid) of the backend
    pub pid: i32,
    /// Database name
    pub database: Option<String>,
    /// Username
    pub username: Option<String>,
    /// Application name (e.g., "CANdor Query")
    pub application_name: Option<String>,
    /// Client address
    pub client_addr: Option<String>,
    /// Current state (active, idle, idle in transaction, etc.)
    pub state: Option<String>,
    /// Current query text (truncated)
    pub query: Option<String>,
    /// When the query started (ISO 8601)
    pub query_start: Option<String>,
    /// How long the query has been running in seconds
    pub duration_secs: Option<f64>,
    /// Whether this is a query we can cancel (our own connection)
    pub is_cancellable: bool,
}

/// Result of querying database activity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseActivityResult {
    /// Active queries running on the database
    pub queries: Vec<DatabaseActivity>,
    /// Active sessions connected to the database
    pub sessions: Vec<DatabaseActivity>,
}

/// Build PostgreSQL connection string from profile
fn build_connection_string(profile: &IOProfile, password: Option<String>) -> String {
    let conn = &profile.connection;

    let host = conn
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("localhost");
    let port = conn
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(5432);
    let database = conn
        .get("database")
        .and_then(|v| v.as_str())
        .unwrap_or("candor");
    let username = conn
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("postgres");
    let sslmode = conn
        .get("sslmode")
        .and_then(|v| v.as_str())
        .unwrap_or("prefer");

    let mut parts = vec![
        format!("host={}", host),
        format!("port={}", port),
        format!("dbname={}", database),
        format!("user={}", username),
        format!("sslmode={}", sslmode),
    ];

    if let Some(pw) = password {
        parts.push(format!("password={}", pw));
    }

    parts.join(" ")
}

/// Find the profile by ID from settings
fn find_profile(settings: &crate::settings::AppSettings, profile_id: &str) -> Option<IOProfile> {
    settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
}

/// Get password for a PostgreSQL profile
fn get_profile_password(profile: &IOProfile) -> Option<String> {
    // Check if password is stored in credential storage
    // Note: field is "_password_stored" with underscore prefix (metadata field)
    let password_stored = profile.connection.get("_password_stored")
        .or_else(|| profile.connection.get("password_stored"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    println!("[dbquery] get_profile_password: password_stored={}", password_stored);

    if password_stored {
        // Try to get from credential storage (field is "password")
        match get_credential(&profile.id, "password") {
            Ok(Some(pw)) => {
                println!("[dbquery] get_profile_password: got password from credential storage");
                Some(pw)
            }
            Ok(None) => {
                println!("[dbquery] get_profile_password: no password in credential storage");
                None
            }
            Err(e) => {
                println!("[dbquery] get_profile_password: credential storage error: {}", e);
                None
            }
        }
    } else {
        // Fall back to connection config
        let pw = profile.connection.get("password").and_then(|v| v.as_str()).map(|s| s.to_string());
        println!("[dbquery] get_profile_password: from config: {}", if pw.is_some() { "found" } else { "not found" });
        pw
    }
}

/// Query for byte changes in a specific frame
///
/// Returns a list of timestamps where the specified byte changed value.
#[tauri::command]
pub async fn db_query_byte_changes(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    byte_index: u8,
    is_extended: bool,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<ByteChangeQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);
    let query_id = query_id.unwrap_or_else(|| format!("byte_changes_{}", query_start.elapsed().as_nanos()));

    println!("[dbquery] db_query_byte_changes called with profile_id='{}', frame_id={}, byte_index={}, is_extended={}, limit={}",
        profile_id, frame_id, byte_index, is_extended, result_limit);

    // Load settings to get profile
    let settings = load_settings(app).await.map_err(|e| format!("Failed to load settings: {}", e))?;

    println!("[dbquery] Loaded settings, found {} IO profiles", settings.io_profiles.len());

    let profile = find_profile(&settings, &profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    println!("[dbquery] Found profile: id='{}', kind='{}', name='{}'",
        profile.id, profile.kind, profile.name);
    println!("[dbquery] Profile connection config: {:?}", profile.connection);

    if profile.kind != "postgres" {
        return Err("Profile is not a PostgreSQL profile".to_string());
    }

    // Get password
    let password = get_profile_password(&profile);
    println!("[dbquery] Got password: {}", if password.is_some() { "yes (hidden)" } else { "no" });

    let conn_str = build_connection_string(&profile, password);
    // Log connection string but redact password
    let safe_conn_str = conn_str.split(' ')
        .map(|part| if part.starts_with("password=") { "password=***" } else { part })
        .collect::<Vec<_>>()
        .join(" ");
    println!("[dbquery] Connection string: {}", safe_conn_str);

    // Connect to database
    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| {
            println!("[dbquery] Connection failed: {:?}", e);
            format!("Failed to connect to database: {}", e)
        })?;

    // Get cancel token before spawning connection handler
    let cancel_token = client.cancel_token();
    register_query(&query_id, "byte_changes", &profile_id, cancel_token).await;

    // Spawn connection handler
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Build query - filter byte changes in SQL using get_byte_safe() for efficiency
    // This avoids fetching all rows and comparing in Rust
    let frame_id_i32 = frame_id as i32;
    let byte_index_i32 = byte_index as i32;
    // Convert bool to i32 for PostgreSQL compatibility (some schemas use integer for extended)
    let is_extended_int: i32 = if is_extended { 1 } else { 0 };

    // Build the base query that extracts and compares the specific byte in SQL
    // Use explicit type casts to help tokio-postgres type inference
    let mut query = String::from(
        r#"
        WITH ordered_frames AS (
            SELECT
                ts,
                public.get_byte_safe(data_bytes, $3::int4) as curr_byte,
                LAG(public.get_byte_safe(data_bytes, $3::int4)) OVER (ORDER BY ts) as prev_byte
            FROM public.can_frame
            WHERE id = $1::int4 AND extended = ($2::int4 != 0)
        "#
    );

    // Add time range conditions to the CTE
    let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&frame_id_i32, &is_extended_int, &byte_index_i32];

    // Use explicit text cast to help PostgreSQL type inference for timestamp conversion
    if let Some(ref start) = start_time {
        let idx = params.len() + 1;
        query.push_str(&format!(" AND ts >= (${}::text)::timestamptz", idx));
        params.push(start as &(dyn tokio_postgres::types::ToSql + Sync));
    }
    if let Some(ref end) = end_time {
        let idx = params.len() + 1;
        query.push_str(&format!(" AND ts < (${}::text)::timestamptz", idx));
        params.push(end as &(dyn tokio_postgres::types::ToSql + Sync));
    }

    // Filter to only rows where the byte actually changed (in SQL, not Rust)
    query.push_str(&format!(
        r#"
            ORDER BY ts
        )
        SELECT
            (EXTRACT(EPOCH FROM ts) * 1000000)::float8 as timestamp_us,
            prev_byte,
            curr_byte
        FROM ordered_frames
        WHERE prev_byte IS NOT NULL
          AND curr_byte IS NOT NULL
          AND prev_byte IS DISTINCT FROM curr_byte
        ORDER BY ts
        LIMIT {}
        "#,
        result_limit
    ));

    println!("[dbquery] Executing query:\n{}", query);
    println!("[dbquery] Query params: frame_id={}, is_extended={} (int={}), byte_index={}, start_time={:?}, end_time={:?}",
        frame_id_i32, is_extended, is_extended_int, byte_index_i32, start_time, end_time);

    let rows = client
        .query(&query, &params)
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    let rows_scanned = rows.len();
    println!("[dbquery] Query returned {} change rows (filtered in SQL)", rows_scanned);

    // Parse results - byte comparison already done in SQL
    let mut results = Vec::new();
    for row in &rows {
        let timestamp_us: f64 = row.get("timestamp_us");
        let prev_byte: i32 = row.get("prev_byte");
        let curr_byte: i32 = row.get("curr_byte");

        results.push(ByteChangeResult {
            timestamp_us: timestamp_us as i64,
            old_value: prev_byte as u8,
            new_value: curr_byte as u8,
        });
    }

    let execution_time_ms = query_start.elapsed().as_millis() as u64;
    println!("[dbquery] byte_changes: frame=0x{:X} byte={} ext={} | {} changes, {}ms",
        frame_id, byte_index, is_extended, results.len(), execution_time_ms);

    unregister_query(&query_id).await;

    Ok(ByteChangeQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms,
        },
        results,
    })
}

/// Query for frame payload changes
///
/// Returns a list of timestamps where any byte in the frame's payload changed.
#[tauri::command]
pub async fn db_query_frame_changes(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    is_extended: bool,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<FrameChangeQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);
    let query_id = query_id.unwrap_or_else(|| format!("frame_changes_{}", query_start.elapsed().as_nanos()));

    println!("[dbquery] db_query_frame_changes called with profile_id='{}', frame_id={}, is_extended={}, limit={}",
        profile_id, frame_id, is_extended, result_limit);

    // Load settings to get profile
    let settings = load_settings(app).await.map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = find_profile(&settings, &profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    println!("[dbquery] Found profile: id='{}', kind='{}', name='{}'",
        profile.id, profile.kind, profile.name);
    println!("[dbquery] Profile connection config: {:?}", profile.connection);

    if profile.kind != "postgres" {
        return Err("Profile is not a PostgreSQL profile".to_string());
    }

    // Get password
    let password = get_profile_password(&profile);
    println!("[dbquery] Got password: {}", if password.is_some() { "yes (hidden)" } else { "no" });

    let conn_str = build_connection_string(&profile, password);
    // Log connection string but redact password
    let safe_conn_str = conn_str.split(' ')
        .map(|part| if part.starts_with("password=") { "password=***" } else { part })
        .collect::<Vec<_>>()
        .join(" ");
    println!("[dbquery] Connection string: {}", safe_conn_str);

    // Connect to database
    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| {
            println!("[dbquery] Connection failed: {:?}", e);
            format!("Failed to connect to database: {}", e)
        })?;

    // Get cancel token before spawning connection handler
    let cancel_token = client.cancel_token();
    register_query(&query_id, "frame_changes", &profile_id, cancel_token).await;

    // Spawn connection handler
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Build query - filter frame changes in SQL for efficiency
    // Only return rows where the payload differs from the previous frame
    let frame_id_i32 = frame_id as i32;
    // Convert bool to i32 for PostgreSQL compatibility (some schemas use integer for extended)
    let is_extended_int: i32 = if is_extended { 1 } else { 0 };

    // Use explicit type casts to help tokio-postgres type inference
    let mut query = String::from(
        r#"
        WITH ordered_frames AS (
            SELECT
                ts,
                data_bytes,
                LAG(data_bytes) OVER (ORDER BY ts) as prev_data
            FROM public.can_frame
            WHERE id = $1::int4 AND extended = ($2::int4 != 0)
        "#
    );

    let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&frame_id_i32, &is_extended_int];

    // Use explicit text cast to help PostgreSQL type inference for timestamp conversion
    if let Some(ref start) = start_time {
        let idx = params.len() + 1;
        query.push_str(&format!(" AND ts >= (${}::text)::timestamptz", idx));
        params.push(start as &(dyn tokio_postgres::types::ToSql + Sync));
    }
    if let Some(ref end) = end_time {
        let idx = params.len() + 1;
        query.push_str(&format!(" AND ts < (${}::text)::timestamptz", idx));
        params.push(end as &(dyn tokio_postgres::types::ToSql + Sync));
    }

    // Filter to only rows where payload changed (bytea comparison in SQL)
    query.push_str(&format!(
        r#"
            ORDER BY ts
        )
        SELECT
            (EXTRACT(EPOCH FROM ts) * 1000000)::float8 as timestamp_us,
            prev_data,
            data_bytes
        FROM ordered_frames
        WHERE prev_data IS NOT NULL
          AND prev_data IS DISTINCT FROM data_bytes
        ORDER BY ts
        LIMIT {}
        "#,
        result_limit
    ));

    println!("[dbquery] Executing query:\n{}", query);
    println!("[dbquery] Query params: frame_id={}, is_extended={} (int={}), start_time={:?}, end_time={:?}",
        frame_id_i32, is_extended, is_extended_int, start_time, end_time);

    let rows = client
        .query(&query, &params)
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    let rows_scanned = rows.len();
    println!("[dbquery] Query returned {} change rows (filtered in SQL)", rows_scanned);

    // Parse results - only changed frames are returned
    let mut results = Vec::new();
    for row in &rows {
        let timestamp_us: f64 = row.get("timestamp_us");
        let prev_data: Vec<u8> = row.get("prev_data");
        let data_bytes: Vec<u8> = row.get("data_bytes");

        // Find changed indices
        let mut changed_indices = Vec::new();
        let max_len = prev_data.len().max(data_bytes.len());

        for i in 0..max_len {
            let prev_byte = prev_data.get(i).copied().unwrap_or(0);
            let curr_byte = data_bytes.get(i).copied().unwrap_or(0);
            if prev_byte != curr_byte {
                changed_indices.push(i);
            }
        }

        results.push(FrameChangeResult {
            timestamp_us: timestamp_us as i64,
            old_payload: prev_data,
            new_payload: data_bytes,
            changed_indices,
        });
    }

    let execution_time_ms = query_start.elapsed().as_millis() as u64;
    println!("[dbquery] frame_changes: frame=0x{:X} ext={} | {} changes, {}ms",
        frame_id, is_extended, results.len(), execution_time_ms);

    unregister_query(&query_id).await;

    Ok(FrameChangeQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms,
        },
        results,
    })
}

/// Query for mirror validation mismatches
///
/// Compares payloads between mirror and source frames at matching timestamps
/// (within tolerance). Returns timestamps where payloads differ.
#[tauri::command]
pub async fn db_query_mirror_validation(
    app: AppHandle,
    profile_id: String,
    mirror_frame_id: u32,
    source_frame_id: u32,
    is_extended: bool,
    tolerance_ms: u32,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<MirrorValidationQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);
    let query_id = query_id.unwrap_or_else(|| format!("mirror_validation_{}", query_start.elapsed().as_nanos()));

    println!("[dbquery] db_query_mirror_validation called with profile_id='{}', mirror=0x{:X}, source=0x{:X}, tolerance={}ms, limit={}",
        profile_id, mirror_frame_id, source_frame_id, tolerance_ms, result_limit);

    // Load settings to get profile
    let settings = load_settings(app).await.map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = find_profile(&settings, &profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    println!("[dbquery] Found profile: id='{}', kind='{}', name='{}'",
        profile.id, profile.kind, profile.name);

    if profile.kind != "postgres" {
        return Err("Profile is not a PostgreSQL profile".to_string());
    }

    // Get password and connect
    let password = get_profile_password(&profile);
    let conn_str = build_connection_string(&profile, password);

    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    // Get cancel token before spawning connection handler
    let cancel_token = client.cancel_token();
    register_query(&query_id, "mirror_validation", &profile_id, cancel_token).await;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Build query - join mirror and source frames by timestamp proximity
    let mirror_id_i32 = mirror_frame_id as i32;
    let source_id_i32 = source_frame_id as i32;
    let is_extended_int: i32 = if is_extended { 1 } else { 0 };
    let tolerance_ms_i32 = tolerance_ms as i32;

    let mut query = String::from(
        r#"
        WITH mirror_frames AS (
            SELECT ts, data_bytes
            FROM public.can_frame
            WHERE id = $1::int4 AND extended = ($3::int4 != 0)
        "#
    );

    let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![
        &mirror_id_i32,
        &source_id_i32,
        &is_extended_int,
        &tolerance_ms_i32,
    ];

    // Add time bounds to mirror_frames CTE
    if let Some(ref start) = start_time {
        let idx = params.len() + 1;
        query.push_str(&format!(" AND ts >= (${}::text)::timestamptz", idx));
        params.push(start as &(dyn tokio_postgres::types::ToSql + Sync));
    }
    if let Some(ref end) = end_time {
        let idx = params.len() + 1;
        query.push_str(&format!(" AND ts < (${}::text)::timestamptz", idx));
        params.push(end as &(dyn tokio_postgres::types::ToSql + Sync));
    }

    query.push_str(
        r#"
        ),
        source_frames AS (
            SELECT ts, data_bytes
            FROM public.can_frame
            WHERE id = $2::int4 AND extended = ($3::int4 != 0)
        "#
    );

    // Add same time bounds to source_frames CTE
    if let Some(ref start) = start_time {
        let idx = params.iter().position(|p| std::ptr::eq(*p, start as &(dyn tokio_postgres::types::ToSql + Sync))).unwrap() + 1;
        query.push_str(&format!(" AND ts >= (${}::text)::timestamptz", idx));
    }
    if let Some(ref end) = end_time {
        let idx = params.iter().position(|p| std::ptr::eq(*p, end as &(dyn tokio_postgres::types::ToSql + Sync))).unwrap() + 1;
        query.push_str(&format!(" AND ts < (${}::text)::timestamptz", idx));
    }

    query.push_str(&format!(
        r#"
        )
        SELECT
            (EXTRACT(EPOCH FROM m.ts) * 1000000)::float8 as mirror_ts,
            (EXTRACT(EPOCH FROM s.ts) * 1000000)::float8 as source_ts,
            m.data_bytes as mirror_payload,
            s.data_bytes as source_payload
        FROM mirror_frames m
        JOIN source_frames s
            ON ABS(EXTRACT(EPOCH FROM (m.ts - s.ts)) * 1000) < $4::int4
        WHERE m.data_bytes IS DISTINCT FROM s.data_bytes
        ORDER BY m.ts
        LIMIT {}
        "#,
        result_limit
    ));

    println!("[dbquery] Executing mirror validation query");

    let rows = client
        .query(&query, &params)
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    let rows_scanned = rows.len();
    println!("[dbquery] Query returned {} mismatch rows", rows_scanned);

    // Parse results and compute mismatch indices
    let mut results = Vec::new();
    for row in &rows {
        let mirror_timestamp_us: f64 = row.get("mirror_ts");
        let source_timestamp_us: f64 = row.get("source_ts");
        let mirror_payload: Vec<u8> = row.get("mirror_payload");
        let source_payload: Vec<u8> = row.get("source_payload");

        // Compute mismatch indices
        let mut mismatch_indices = Vec::new();
        let max_len = mirror_payload.len().max(source_payload.len());
        for i in 0..max_len {
            let mirror_byte = mirror_payload.get(i).copied().unwrap_or(0);
            let source_byte = source_payload.get(i).copied().unwrap_or(0);
            if mirror_byte != source_byte {
                mismatch_indices.push(i);
            }
        }

        results.push(MirrorValidationResult {
            mirror_timestamp_us: mirror_timestamp_us as i64,
            source_timestamp_us: source_timestamp_us as i64,
            mirror_payload,
            source_payload,
            mismatch_indices,
        });
    }

    let execution_time_ms = query_start.elapsed().as_millis() as u64;
    println!("[dbquery] mirror_validation: mirror=0x{:X} source=0x{:X} | {} mismatches, {}ms",
        mirror_frame_id, source_frame_id, results.len(), execution_time_ms);

    unregister_query(&query_id).await;

    Ok(MirrorValidationQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms,
        },
        results,
    })
}

/// Query pg_stat_activity for running queries and active sessions
///
/// Returns information about queries currently running on the database
/// and all active sessions (connections).
#[tauri::command]
pub async fn db_query_activity(
    app: AppHandle,
    profile_id: String,
) -> Result<DatabaseActivityResult, String> {
    println!("[dbquery] db_query_activity called for profile '{}'", profile_id);

    // Load settings to get profile
    let settings = load_settings(app).await.map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = find_profile(&settings, &profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    if profile.kind != "postgres" {
        return Err("Profile is not a PostgreSQL profile".to_string());
    }

    // Get password and connect
    let password = get_profile_password(&profile);
    let conn_str = build_connection_string(&profile, password);

    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Get the database name from the profile for filtering
    let database_name = profile.connection.get("database")
        .and_then(|v| v.as_str())
        .unwrap_or("candor");

    // Query pg_stat_activity for this database
    // We filter to the specific database and show both active queries and idle sessions
    let query = r#"
        SELECT
            pid,
            datname as database,
            usename as username,
            application_name,
            client_addr::text,
            state,
            LEFT(query, 500) as query,
            query_start::text,
            EXTRACT(EPOCH FROM (now() - query_start))::float8 as duration_secs,
            pg_backend_pid() = pid as is_own_connection
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid != pg_backend_pid()
        ORDER BY
            CASE WHEN state = 'active' THEN 0 ELSE 1 END,
            query_start DESC NULLS LAST
    "#;

    let rows = client
        .query(query, &[&database_name])
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut queries = Vec::new();
    let mut sessions = Vec::new();

    for row in &rows {
        let state: Option<String> = row.get("state");
        let is_active = state.as_deref() == Some("active");

        let activity = DatabaseActivity {
            pid: row.get("pid"),
            database: row.get("database"),
            username: row.get("username"),
            application_name: row.get("application_name"),
            client_addr: row.get("client_addr"),
            state: state.clone(),
            query: row.get("query"),
            query_start: row.get("query_start"),
            duration_secs: row.get("duration_secs"),
            // Users can cancel any query in the same database they have access to
            is_cancellable: is_active,
        };

        if is_active {
            queries.push(activity);
        } else {
            sessions.push(activity);
        }
    }

    println!("[dbquery] Found {} active queries, {} idle sessions for database '{}'",
        queries.len(), sessions.len(), database_name);

    Ok(DatabaseActivityResult { queries, sessions })
}

/// Cancel a running query by backend PID using pg_cancel_backend
///
/// This sends a SIGINT to the backend process, which will cancel the current query
/// but keep the connection alive.
#[tauri::command]
pub async fn db_cancel_backend(
    app: AppHandle,
    profile_id: String,
    pid: i32,
) -> Result<bool, String> {
    println!("[dbquery] db_cancel_backend called for pid {} on profile '{}'", pid, profile_id);

    // Load settings to get profile
    let settings = load_settings(app).await.map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = find_profile(&settings, &profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    if profile.kind != "postgres" {
        return Err("Profile is not a PostgreSQL profile".to_string());
    }

    // Get password and connect
    let password = get_profile_password(&profile);
    let conn_str = build_connection_string(&profile, password);

    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Use pg_cancel_backend to cancel the query
    // This is safer than pg_terminate_backend as it only cancels the current query
    let row = client
        .query_one("SELECT pg_cancel_backend($1)", &[&pid])
        .await
        .map_err(|e| format!("Failed to cancel backend: {}", e))?;

    let cancelled: bool = row.get(0);
    println!("[dbquery] pg_cancel_backend({}) returned: {}", pid, cancelled);

    Ok(cancelled)
}

/// Terminate a backend session by PID using pg_terminate_backend
///
/// This terminates the entire connection, not just the current query.
/// Use with caution.
#[tauri::command]
pub async fn db_terminate_backend(
    app: AppHandle,
    profile_id: String,
    pid: i32,
) -> Result<bool, String> {
    println!("[dbquery] db_terminate_backend called for pid {} on profile '{}'", pid, profile_id);

    // Load settings to get profile
    let settings = load_settings(app).await.map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = find_profile(&settings, &profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    if profile.kind != "postgres" {
        return Err("Profile is not a PostgreSQL profile".to_string());
    }

    // Get password and connect
    let password = get_profile_password(&profile);
    let conn_str = build_connection_string(&profile, password);

    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Use pg_terminate_backend to terminate the connection
    let row = client
        .query_one("SELECT pg_terminate_backend($1)", &[&pid])
        .await
        .map_err(|e| format!("Failed to terminate backend: {}", e))?;

    let terminated: bool = row.get(0);
    println!("[dbquery] pg_terminate_backend({}) returned: {}", pid, terminated);

    Ok(terminated)
}
