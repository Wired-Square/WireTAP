use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use once_cell::sync::Lazy;

use serde::{Deserialize, Serialize};

use crate::io::device_kinds::{self, conn_f64, conn_i64, conn_str, req_str};
use crate::io::{
    create_session, current_session_of_app, destroy_session_by, get_session_state, register_subscriber_from,
    session_exists, settle_session, start_session, BackendApiConfig, BackendApiSource, BackendApiSourceOptions, BusMapping,
    CaptureSource, IOBroker, IOSource, MqttConfig, MqttSource, RegisterSubscriberResult, SerialOverrides,
};
use crate::settings::{self, AppSettings, IOProfile};
use crate::{capture_store, credentials, profile_tracker};

use super::ids::session_for_source;
use super::source_config::{attach_modbus_polls, parse_modbus_polls, reader_source_config, resolve_source_configs, MultiSourceInput};
use super::tracking::{claim_session_profile, register_session_profiles};

/// What `open_session` creates when nothing is under the session id yet.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default)]
pub struct OpenSessionOptions {
    /// The saved profile or capture to create the session from when nothing is under its id.
    #[cfg_attr(test, ts(optional))]
    pub source_id: Option<String>,
    /// Devices merged into one session, replacing whatever is under the id.
    #[cfg_attr(test, ts(optional))]
    pub sources: Option<Vec<MultiSourceInput>>,
    #[cfg_attr(test, ts(optional))]
    pub start_time: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub end_time: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub speed: Option<f64>,
    #[cfg_attr(test, ts(optional))]
    pub limit: Option<i64>,
    #[cfg_attr(test, ts(optional))]
    pub bus_override: Option<u8>,
    #[cfg_attr(test, ts(optional))]
    pub modbus_polls: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub serial: Option<SerialOverrides>,
    /// Leave a session this open creates stopped.
    #[cfg_attr(test, ts(optional))]
    pub connect_only: Option<bool>,
}

/// The session an open joined or created, and how the start it made went.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct OpenedSession {
    pub session_id: String,
    #[serde(flatten)]
    pub registration: RegisterSubscriberResult,
    pub created: bool,
    /// Why the start this open made failed. The session stays, in its error state.
    pub start_error: Option<String>,
    /// The buses each source was given, when `sources` opened the session.
    pub bus_mappings: Option<HashMap<String, Vec<BusMapping>>>,
}

/// Why a session command was refused.
#[derive(Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionRefusal {
    /// No session under the id, and nothing to open one from.
    NotFound { message: String },
    Failed { message: String },
}

/// An operation's refusal on `session_id`, as not-found once the session is gone.
pub(super) async fn refused_on<T>(session_id: &str, result: Result<T, String>) -> Result<T, SessionRefusal> {
    match result {
        Ok(value) => Ok(value),
        Err(message) if session_exists(session_id).await => Err(SessionRefusal::Failed { message }),
        Err(message) => Err(SessionRefusal::NotFound { message }),
    }
}

impl From<String> for SessionRefusal {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

impl std::fmt::Display for SessionRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (Self::NotFound { message } | Self::Failed { message }) = self;
        f.write_str(message)
    }
}

/// Join the session under `session_id`, or create it from `opts` and start it,
/// then register the subscriber. One call, so nothing can land between the
/// create, the start and the registration. Without a `session_id`, the session
/// is the one open on `opts.source_id` alone, else a new one.
#[tauri::command(rename_all = "snake_case")]
pub async fn open_session(
    app: tauri::AppHandle,
    session_id: Option<String>,
    subscriber_id: String,
    app_name: Option<String>,
    opts: OpenSessionOptions,
) -> Result<OpenedSession, SessionRefusal> {
    open_from(&app, session_id.as_deref(), &subscriber_id, app_name.as_deref(), opts).await
}

/// `open_session` without a webview. A subscriber is on one session at a time, so
/// the one it leaves is torn down if this empties it.
pub async fn open_from(
    app: &tauri::AppHandle,
    session_id: Option<&str>,
    subscriber_id: &str,
    app_name: Option<&str>,
    mut opts: OpenSessionOptions,
) -> Result<OpenedSession, SessionRefusal> {
    let connect_only = opts.connect_only.unwrap_or(false);
    let replaces = opts.sources.is_some();
    let source_id = opts.source_id.clone();
    let named = (subscriber_id.to_string(), app_name.map(str::to_string));
    let create = |session_id: String| async move {
        match opts.sources.take() {
            Some(sources) => create_from_sources(app, &session_id, sources, opts.modbus_polls.take(), named).await,
            None => {
                let settings = settings::load_settings(app.clone()).await?;
                match source_of(&settings, &session_id, opts.source_id.take())? {
                    Source::Capture(capture_id) => create_from_capture(&session_id, capture_id, opts.speed, named).await,
                    Source::Profile(profile) => create_from_profile(app, &settings, &session_id, profile, opts, named).await,
                }
            }
        }
    };
    match (session_id, source_id) {
        (Some(id), _) => open_or_join(id, subscriber_id, app_name, connect_only, replaces, create(id.to_string())).await,
        (None, Some(source_id)) if !replaces => {
            let settings = settings::load_settings(app.clone()).await?;
            open_source(&source_id, &settings, subscriber_id, app_name, connect_only, create).await
        }
        _ => Err(SessionRefusal::NotFound { message: "No session id, and no single source to open".into() }),
    }
}

/// Opens of one source queue here, so the second joins the session the first made.
static SOURCE_OPENS: Lazy<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = Lazy::new(Default::default);

fn source_open_lock(source_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    SOURCE_OPENS.lock().unwrap_or_else(|e| e.into_inner()).entry(source_id.to_string()).or_default().clone()
}

/// Open `source_id` under the session open on it alone, else under a new one.
async fn open_source<F: Future<Output = Result<Created, SessionRefusal>>>(
    source_id: &str,
    settings: &AppSettings,
    subscriber_id: &str,
    app_name: Option<&str>,
    connect_only: bool,
    create: impl FnOnce(String) -> F,
) -> Result<OpenedSession, SessionRefusal> {
    let lock = source_open_lock(source_id);
    let _opening = lock.lock().await;
    let session_id = session_for_source(source_id, settings).await;
    open_or_join(&session_id, subscriber_id, app_name, connect_only, false, create(session_id.clone())).await
}

/// A session `open_or_join` made, before its start.
pub(super) struct Created {
    starts: bool,
    bus_mappings: Option<HashMap<String, Vec<BusMapping>>>,
}

pub(super) async fn open_or_join(
    session_id: &str,
    subscriber_id: &str,
    app_name: Option<&str>,
    connect_only: bool,
    replaces: bool,
    create: impl Future<Output = Result<Created, SessionRefusal>>,
) -> Result<OpenedSession, SessionRefusal> {
    let leaving = current_session_of_app(subscriber_id);
    settle_session(session_id).await;
    let created = if replaces || !session_exists(session_id).await {
        Some(create.await?)
    } else {
        None
    };
    let start_error = match &created {
        Some(c) if c.starts && !connect_only => start_session(session_id).await.err(),
        _ => None,
    };
    let registered = register_subscriber_from(leaving, session_id, subscriber_id, app_name).await;
    let registration = refused_on(session_id, registered).await?;
    Ok(OpenedSession {
        session_id: session_id.to_string(),
        registration,
        created: created.is_some(),
        start_error,
        bus_mappings: created.and_then(|c| c.bus_mappings),
    })
}

enum Source {
    Capture(String),
    Profile(IOProfile),
}

fn source_of(settings: &AppSettings, session_id: &str, source_id: Option<String>) -> Result<Source, SessionRefusal> {
    let Some(source_id) = source_id else {
        return Err(SessionRefusal::NotFound { message: format!("No session '{session_id}'") });
    };
    if capture_store::is_known_capture(&source_id) {
        return Ok(Source::Capture(source_id));
    }
    match settings.io_profiles.iter().find(|p| p.id == source_id) {
        Some(profile) => Ok(Source::Profile(profile.clone())),
        None => Err(SessionRefusal::NotFound {
            message: format!("No session '{session_id}', and no profile or capture '{source_id}' to open it from"),
        }),
    }
}

async fn create_from_capture(
    session_id: &str,
    capture_id: String,
    speed: Option<f64>,
    (subscriber_id, app_name): (String, Option<String>),
) -> Result<Created, SessionRefusal> {
    claim_session_profile(session_id, &capture_id).await;
    let reader = CaptureSource::new(session_id.to_string(), capture_id, speed.unwrap_or(1.0));
    crate::telemetry::emit_feature_usage("io_source_start", "capture");
    create_session(session_id.to_string(), Box::new(reader), Some(subscriber_id), app_name, None, vec![]).await;
    Ok(Created { starts: false, bus_mappings: None })
}

async fn create_from_profile(
    app: &tauri::AppHandle,
    settings: &AppSettings,
    session_id: &str,
    profile: IOProfile,
    opts: OpenSessionOptions,
    (subscriber_id, app_name): (String, Option<String>),
) -> Result<Created, SessionRefusal> {
    // A same-id open racing this one is about to join, not contend.
    profile_tracker::can_use_profile(&profile.id, &profile.kind, Some(session_id))?;
    profile_tracker::can_use_adapter(&profile.id, &settings.io_profiles, &[], Some(session_id))?;
    crate::telemetry::emit_feature_usage("io_source_start", &profile.kind);

    let reader = profile_reader(app, settings, session_id, &profile, opts)?;
    claim_session_profile(session_id, &profile.id).await;
    let result = create_session(session_id.to_string(), reader, Some(subscriber_id), app_name, None, vec![]).await;
    Ok(Created { starts: result.is_new, bus_mappings: None })
}

fn profile_reader(
    app: &tauri::AppHandle,
    settings: &AppSettings,
    session_id: &str,
    profile: &IOProfile,
    opts: OpenSessionOptions,
) -> Result<Box<dyn IOSource>, String> {
    if device_kinds::is_multi_source(&profile.kind) {
        let source_config = reader_source_config(
            profile,
            opts.bus_override,
            opts.serial.unwrap_or_default(),
            opts.modbus_polls.as_deref(),
            settings.modbus_max_register_errors,
        )?;
        return Ok(Box::new(IOBroker::single_source(
            settings::saved_profiles(app),
            session_id.to_string(),
            source_config,
        )?));
    }
    match profile.kind.as_str() {
        "wiretap" => {
            let config = BackendApiConfig {
                base_url: req_str(profile, "url")?.trim_end_matches('/').to_string(),
                api_key: credentials::resolve_secret(profile, "api_key").unwrap_or_default(),
                database: req_str(profile, "database")?,
                protocol: crate::apiclient::archive_protocol(&profile.connection)?,
            };
            let options = BackendApiSourceOptions {
                start: opts.start_time.or_else(|| conn_str(profile, "start")),
                end: opts.end_time.or_else(|| conn_str(profile, "end")),
                limit: opts.limit.or_else(|| conn_i64(profile, "limit")),
                speed: opts.speed.or_else(|| conn_f64(profile, "speed")).unwrap_or(0.0),
                batch_size: conn_i64(profile, "batch_size").unwrap_or(1000) as i32,
            };
            Ok(Box::new(BackendApiSource::new(session_id.to_string(), config, options)))
        }
        "mqtt" => {
            let topic = profile
                .connection
                .get("formats")
                .and_then(|f| f.get("savvycan"))
                .and_then(|s| s.get("topic"))
                .and_then(|v| v.as_str())
                .unwrap_or("wiretap/#")
                .to_string();
            let config = MqttConfig {
                host: req_str(profile, "host")?,
                port: device_kinds::req_i64(profile, "port")? as u16,
                username: conn_str(profile, "username"),
                password: credentials::resolve_secret(profile, "password"),
                topic,
                client_id: None,
            };
            Ok(Box::new(MqttSource::new(session_id.to_string(), config)))
        }
        kind => Err(format!("Unsupported reader type '{kind}'")),
    }
}

/// Merge `sources` into one session under `session_id`, replacing any session
/// already there so the buses are the ones asked for now.
async fn create_from_sources(
    app: &tauri::AppHandle,
    session_id: &str,
    sources: Vec<MultiSourceInput>,
    modbus_polls: Option<String>,
    (subscriber_id, app_name): (String, Option<String>),
) -> Result<Created, SessionRefusal> {
    if sources.is_empty() {
        return Err("At least one source is required".to_string().into());
    }
    let settings = settings::load_settings(app.clone()).await?;
    let parsed_polls = parse_modbus_polls(modbus_polls.as_deref())?;
    let mut source_configs = resolve_source_configs(sources, &settings, 0)?;
    for config in &mut source_configs {
        attach_modbus_polls(config, &parsed_polls, settings.modbus_max_register_errors);
    }

    for (idx, config) in source_configs.iter().enumerate() {
        if !device_kinds::is_multi_source(&config.profile_kind) {
            return Err(format!(
                "Profile '{}' has unsupported type '{}' for multi-source mode.",
                config.profile_id, config.profile_kind
            )
            .into());
        }
        if !device_kinds::spec(&config.profile_kind).is_some_and(|s| s.available) {
            return Err(format!(
                "Profile '{}' uses {}, which this platform cannot open.",
                config.profile_id, config.profile_kind
            )
            .into());
        }
        profile_tracker::can_use_profile(&config.profile_id, &config.profile_kind, Some(session_id))?;
        let joining: Vec<&str> = source_configs[..idx].iter().map(|c| c.profile_id.as_str()).collect();
        profile_tracker::can_use_adapter(&config.profile_id, &settings.io_profiles, &joining, Some(session_id))?;
    }

    // `reset: true` — the session is recreated under this same id, so apps must not
    // treat the teardown as an external death and adopt the orphaned capture: doing
    // so made the capture the app's next session id and churned this path in a loop.
    if get_session_state(session_id).await.is_some() {
        let _ = destroy_session_by(session_id, true, Some(&subscriber_id)).await;
    }

    let profile_ids: Vec<String> = source_configs.iter().map(|c| c.profile_id.clone()).collect();
    let display_names = source_configs.iter().map(|c| c.display_name.clone()).collect();
    let bus_mappings = source_configs.iter().map(|c| (c.profile_id.clone(), c.bus_mappings.clone())).collect();
    let stored_configs = source_configs.clone();
    let reader = IOBroker::new(settings::saved_profiles(app), session_id.to_string(), source_configs)?;

    register_session_profiles(session_id, &profile_ids);
    let mut seen = std::collections::HashSet::new();
    for config in &stored_configs {
        if seen.insert(config.profile_kind.as_str()) {
            crate::telemetry::emit_feature_usage("io_source_start", &config.profile_kind);
        }
    }

    create_session(
        session_id.to_string(),
        Box::new(reader),
        Some(subscriber_id),
        app_name,
        Some(display_names),
        stored_configs,
    )
    .await;
    Ok(Created { starts: true, bus_mappings: Some(bus_mappings) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::test_source::{Gate, TestSource};
    use crate::io::{destroy_session, IOState, SessionMode, SessionSourceKind, SourceConfig};
    use std::time::Duration;

    fn create_test_source(session_id: &str) -> impl Future<Output = Result<Created, SessionRefusal>> + '_ {
        async move {
            let result =
                create_session(session_id.into(), Box::new(TestSource::new(session_id)), None, None, None, vec![]).await;
            Ok(Created { starts: result.is_new, bus_mappings: None })
        }
    }

    async fn not_created() -> Result<Created, SessionRefusal> {
        panic!("a join created a session")
    }

    async fn open(session_id: &str, subscriber: &str) -> Result<OpenedSession, SessionRefusal> {
        open_or_join(session_id, subscriber, None, false, false, create_test_source(session_id)).await
    }

    #[tokio::test]
    async fn an_open_creates_starts_and_registers_in_one_call() {
        let id = "f_open_creates";
        let opened = open(id, "open-creates-app").await.unwrap();
        assert!(opened.created);
        assert_eq!(opened.start_error, None);
        assert_eq!(opened.registration.state, IOState::Running);
        assert_eq!(opened.registration.subscriber_count, 1);
        assert_eq!(opened.registration.source_kind, SessionSourceKind::Device);
        assert_eq!(opened.registration.mode, SessionMode::Live);
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_opens_of_one_source_end_in_one_session() {
        let source = "p-open-concurrent";
        let settings = AppSettings::default();
        let create = |id: String| async move {
            tokio::task::yield_now().await;
            super::super::register_session_profile(&id, source);
            create_test_source(&id).await
        };
        let opened = futures::future::join_all(
            ["concurrent-a", "concurrent-b", "concurrent-c"]
                .map(|subscriber| open_source(source, &settings, subscriber, None, false, create)),
        )
        .await;

        let ids: std::collections::BTreeSet<String> = opened.into_iter().map(|o| o.unwrap().session_id).collect();
        let subscribers: Vec<usize> = ids.iter().map(|id| crate::io::subscriber_count_for_session(id)).collect();
        for id in &ids {
            destroy_session(id, false).await.unwrap();
        }
        assert_eq!(subscribers, [3], "{ids:?}");
    }

    #[tokio::test]
    async fn a_capture_session_reports_the_capture_it_replays() {
        crate::capture_db::use_in_memory_database();
        let capture = capture_store::create_standalone_capture(capture_store::CaptureKind::Frames, "replayed".into());
        let id = "c_open_capture";
        let create = create_from_capture(id, capture.clone(), None, ("open-capture-app".into(), None));
        let opened = open_or_join(id, "open-capture-app", None, false, false, create).await.unwrap();
        assert_eq!(opened.registration.capture_id.as_deref(), Some(capture.as_str()));
        assert_eq!(opened.registration.mode, SessionMode::Capture);
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn an_open_of_a_live_session_joins_it() {
        let id = "f_open_joins";
        open(id, "open-joins-first").await.unwrap();
        let joined = open_or_join(id, "open-joins-second", None, false, false, not_created()).await.unwrap();
        assert!(!joined.created);
        assert_eq!(joined.registration.subscriber_count, 2);
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn a_subscriber_that_opens_another_session_leaves_no_session_unwatched() {
        let (first, second) = ("f_open_moves_a", "f_open_moves_b");
        open(first, "open-moves-app").await.unwrap();
        open(second, "open-moves-app").await.unwrap();
        assert!(!session_exists(first).await, "the session it left still streams with no subscriber");
        destroy_session(second, false).await.unwrap();
    }

    #[tokio::test]
    async fn the_mcp_keeps_every_session_it_opens() {
        let sessions = ["f_open_mcp_a", "f_open_mcp_b"];
        for id in sessions {
            open(id, &crate::mcp::session::subscriber_for(id)).await.unwrap();
        }
        for id in sessions {
            assert_eq!(crate::io::subscriber_count_for_session(id), 1, "{id}");
            destroy_session(id, false).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_connect_only_open_leaves_the_session_stopped() {
        let id = "f_open_connect_only";
        let opened = open_or_join(id, "connect-only-app", None, true, false, create_test_source(id)).await.unwrap();
        assert_eq!(opened.registration.state, IOState::Stopped);
        destroy_session(id, false).await.unwrap();
    }

    fn slcan_at(bitrate: u32) -> IOProfile {
        IOProfile {
            id: "p-open-slcan".into(),
            name: "Bench SLCAN".into(),
            kind: "slcan".into(),
            connection: serde_json::from_value(serde_json::json!({ "port": "/dev/wiretap-no-such-port", "bitrate": bitrate }))
                .unwrap(),
            preferred_catalog: None,
            ephemeral: true,
        }
    }

    #[tokio::test]
    async fn a_refused_start_comes_back_from_the_open_and_the_session_stays() {
        crate::capture_db::use_in_memory_database();
        let id = "f_open_refused";
        let profile = slcan_at(33_333);
        let saved = vec![profile.clone()];
        let create = async {
            let config = SourceConfig {
                profile_id: profile.id.clone(),
                profile_kind: profile.kind.clone(),
                display_name: profile.name.clone(),
                bus_mappings: super::super::profile_bus_mappings(&profile),
                ..Default::default()
            };
            let broker = IOBroker::new(Arc::new(move || Ok(saved.clone())), id.into(), vec![config])?;
            create_session(id.into(), Box::new(broker), None, None, None, vec![]).await;
            Ok(Created { starts: true, bus_mappings: None })
        };
        let opened = open_or_join(id, "open-refused-app", None, false, false, create).await.unwrap();

        let error = opened.start_error.expect("an SLCAN rate the protocol cannot name refuses the start");
        assert!(error.contains("33333") && error.contains("10000"), "{error}");
        assert!(matches!(opened.registration.state, IOState::Error(_)));
        assert!(session_exists(id).await);
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn an_open_on_a_retiring_session_waits_and_creates_afresh() {
        let id = "f_open_retiring";
        let gate = Arc::new(Gate::default());
        create_session(id.into(), Box::new(TestSource::new(id).slow_stop(&gate)), None, None, None, vec![]).await;
        let teardown = tokio::spawn(destroy_session(id, false));
        gate.entered().await;

        let mut reopen = tokio::spawn(async move { open(id, "open-retiring-app").await });
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut reopen).await.is_err());

        gate.release();
        teardown.await.unwrap().unwrap();
        let opened = reopen.await.unwrap().unwrap();
        assert!(opened.created);
        assert_eq!(opened.registration.state, IOState::Running);
        destroy_session(id, false).await.unwrap();
    }

    #[test]
    fn an_id_that_names_neither_a_profile_nor_a_capture_is_not_found() {
        let refused = source_of(&AppSettings::default(), "f_nothing", Some("p-nothing".into())).err();
        assert!(matches!(refused, Some(SessionRefusal::NotFound { .. })));
    }

    #[test]
    fn a_session_id_is_never_read_as_the_profile_to_open() {
        let settings = AppSettings { io_profiles: vec![slcan_at(500_000)], ..AppSettings::default() };
        let refused = source_of(&settings, "p-open-slcan", None).err();
        assert!(matches!(refused, Some(SessionRefusal::NotFound { .. })));
    }

    #[test]
    fn a_refusal_reaches_typescript_tagged_by_kind() {
        let refused = serde_json::to_value(SessionRefusal::NotFound { message: "gone".into() }).unwrap();
        assert_eq!(refused, serde_json::json!({ "kind": "not_found", "message": "gone" }));
    }
}
