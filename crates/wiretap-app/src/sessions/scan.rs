use crate::io::modbus_tcp::{modbus_endpoint_str, scan_source::scan_holding, session_modbus_profile};
use crate::io::{self, IOCapabilities, ModbusScanSource, ScanJob};
use crate::settings::AppSettings;

use super::tracking::claim_session_profile;

/// Create a stopped session that runs `job`. `pollers` are the settings a
/// poller of the same endpoint is looked for in; `None` allows contention.
pub async fn create_scan_session(
    session_id: String,
    job: ScanJob,
    profile_id: Option<String>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    pollers: Option<&AppSettings>,
) -> Result<IOCapabilities, String> {
    refuse_contended_sweep(&job.endpoint(), &session_id, pollers).await?;

    if let Some(pid) = &profile_id {
        claim_session_profile(&session_id, pid).await;
    }

    let source = ModbusScanSource::new(session_id.clone(), job);
    let result = io::create_session(
        session_id,
        Box::new(source),
        subscriber_id,
        app_name,
        None,
        vec![],
    )
    .await;
    Ok(result.capabilities)
}

/// A sweep opens its own connection. Devices that serve one Modbus
/// conversation at a time — the cheap stacks this feature exists for — break
/// when a second one arrives, and pausing a poller doesn't help because it
/// keeps its socket. Name the conflict rather than producing junk data.
pub async fn refuse_contended_sweep(
    endpoint: &str,
    session_id: &str,
    pollers: Option<&AppSettings>,
) -> Result<(), String> {
    if let Some(holder) = scan_holding(endpoint) {
        if holder != session_id {
            return Err(format!(
                "A Modbus scan of {} is already running as session '{}' — stop it first.",
                endpoint, holder
            ));
        }
    }

    if let Some(settings) = pollers {
        if let Some((holder, name)) = endpoint_in_use_by_poller(settings, endpoint, session_id).await {
            return Err(format!(
                "{name} is being polled by session '{holder}' — that device may only serve one \
                 Modbus connection at a time. Stop that session, or re-run allowing contention."
            ));
        }
    }
    Ok(())
}

/// Find a live session already polling this `host:port`, so a sweep can name the
/// conflict instead of quietly contending for the socket.
///
/// `scan_holding` only sees other *sweeps*; this sees pollers, which is the case
/// that matters now that the Discovery tools only appear during a live session.
async fn endpoint_in_use_by_poller(
    settings: &AppSettings,
    endpoint: &str,
    exclude: &str,
) -> Option<(String, String)> {
    for info in io::list_sessions().await {
        // A paused poller still holds its socket — pause stops requests, not the
        // connection — so it contends exactly as a running one does.
        let holds_socket = matches!(info.state, io::IOState::Running | io::IOState::Paused);
        if info.session_id == exclude || !holds_socket {
            continue;
        }
        let Some(profile) = session_modbus_profile(settings, &info.session_id) else {
            continue;
        };
        if modbus_endpoint_str(profile) == endpoint {
            return Some((info.session_id.clone(), profile.name.clone()));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::modbus_tcp::scan_source::{register_scan, unregister_scan};
    use crate::io::test_source::TestSource;
    use crate::settings::IOProfile;

    fn settings_polling(profile_id: &str, host: &str) -> AppSettings {
        let device = IOProfile {
            id: profile_id.into(),
            name: "Meter".into(),
            kind: "modbus_tcp".into(),
            connection: [
                ("host".to_string(), host.into()),
                ("port".to_string(), 502i64.into()),
            ]
            .into(),
            ..Default::default()
        };
        AppSettings { io_profiles: vec![device], ..Default::default() }
    }

    #[tokio::test]
    async fn another_sessions_sweep_of_the_endpoint_is_refused_even_allowing_contention() {
        register_scan("m_sweep_holder", "10.9.9.1:502");
        let other = refuse_contended_sweep("10.9.9.1:502", "m_sweep_other", None).await;
        let own = refuse_contended_sweep("10.9.9.1:502", "m_sweep_holder", None).await;
        let elsewhere = refuse_contended_sweep("10.9.9.2:502", "m_sweep_other", None).await;
        unregister_scan("m_sweep_holder");

        assert_eq!(
            other.unwrap_err(),
            "A Modbus scan of 10.9.9.1:502 is already running as session 'm_sweep_holder' — stop it first."
        );
        assert_eq!(own, Ok(()));
        assert_eq!(elsewhere, Ok(()));
    }

    #[tokio::test]
    async fn a_running_or_paused_poller_is_refused_unless_contention_is_allowed() {
        let poller = "m_contended_poller";
        let settings = settings_polling("contended-meter", "10.9.9.3");
        let endpoint = modbus_endpoint_str(&settings.io_profiles[0]);
        io::create_session(poller.into(), Box::new(TestSource::new(poller)), None, None, None, vec![]).await;
        super::super::register_session_profile(poller, "contended-meter");
        let refusal = || refuse_contended_sweep(&endpoint, "m_contended_sweep", Some(&settings));

        let _ = io::start_session(poller).await;
        let running = refusal().await;
        let allowed = refuse_contended_sweep(&endpoint, "m_contended_sweep", None).await;
        let itself = refuse_contended_sweep(&endpoint, poller, Some(&settings)).await;
        let _ = io::pause_session(poller).await;
        let paused = refusal().await;
        let _ = io::stop_session(poller).await;
        let stopped = refusal().await;
        io::destroy_session(poller, false).await.unwrap();

        assert_eq!(
            running.unwrap_err(),
            "Meter is being polled by session 'm_contended_poller' — that device may only serve one \
             Modbus connection at a time. Stop that session, or re-run allowing contention."
        );
        assert_eq!((allowed, itself), (Ok(()), Ok(())));
        assert!(paused.is_err(), "a paused poller keeps its socket");
        assert_eq!(stopped, Ok(()));
    }

    #[tokio::test]
    async fn a_scan_session_is_created_stopped_holding_its_profile() {
        let session_id = "m_scan_created";
        let job: ScanJob = serde_json::from_value(serde_json::json!({
            "kind": "unit_ids",
            "config": {
                "host": "127.0.0.1", "port": 9, "start_unit_id": 1, "end_unit_id": 1,
                "test_register": 0, "register_type": "holding", "inter_request_delay_ms": 0,
            },
        }))
        .expect("a job");

        let created = create_scan_session(session_id.into(), job, Some("scan-meter".into()), None, None, None).await;
        let state = io::get_session_state(session_id).await;
        let held = super::super::get_session_profile_ids(session_id);
        io::destroy_session(session_id, false).await.unwrap();

        assert!(created.is_ok(), "{created:?}");
        assert_eq!(state, Some(io::IOState::Stopped));
        assert_eq!(held, ["scan-meter"]);
    }
}
