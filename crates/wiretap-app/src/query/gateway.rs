// crates/wiretap-app/src/query/gateway.rs
//
// A query against a WireTAP backend: the spec as the gateway's request, with
// RFC3339 bounds, and its answer. The server's SQL is its own; what this side
// can show is the request.

use std::collections::BTreeSet;

use serde::de::DeserializeOwned;
use serde_json::Value;
use crate::settings::SettingsSource;
use wslib_wiretap_gateway::{
    ByteChangeQueryResult, DistributionQueryResult, FirstLastQueryResult, FrameChangeQueryResult,
    FrequencyQueryResult, GapAnalysisQueryResult, GatewayRequest, MirrorValidationQueryResult,
    MuxStatisticsQueryResult, PatternSearchQueryResult, Protocol, QuerySpec,
};

use super::{QueryOutcome, QueryResults};
use crate::apiclient::{self, ApiProfile};

/// The request as it is sent, which is what a backend query can show for its SQL.
pub(super) fn text(request: &GatewayRequest) -> String {
    match request {
        GatewayRequest::Inventory(_) => format!("GET {}", request.path()),
        GatewayRequest::Post(path, body) => {
            let body = serde_json::to_value(body).expect("gateway params serialise");
            format!(
                "POST {path}\n{}",
                serde_json::to_string_pretty(&body).unwrap_or_default()
            )
        }
    }
}

/// `narrowed`: a mirror validation the catalogue narrows asks for every mismatch.
pub(super) fn request(
    protocol: Protocol,
    spec: &QuerySpec,
    query_id: Option<&str>,
    narrowed: bool,
) -> Result<GatewayRequest, String> {
    spec.request(protocol, query_id, narrowed)
        .map_err(|e| e.to_string())
}

fn parse<T: DeserializeOwned>(body: Value) -> Result<T, String> {
    serde_json::from_value(body).map_err(|e| format!("API response decode failed: {e}"))
}

fn decode(spec: &QuerySpec, body: Value, compare: Option<&BTreeSet<usize>>) -> Result<QueryOutcome, String> {
    Ok(match spec {
        QuerySpec::ByteChanges { .. } => parse::<ByteChangeQueryResult>(body)?.into(),
        QuerySpec::FrameChanges { .. } => parse::<FrameChangeQueryResult>(body)?.into(),
        QuerySpec::MirrorValidation { limit, .. } => {
            let mut answer: MirrorValidationQueryResult = parse(body)?;
            if let Some(compare) = compare {
                narrow(&mut answer, compare, *limit);
            }
            answer.into()
        }
        QuerySpec::MuxStatistics { .. } => parse::<MuxStatisticsQueryResult>(body)?.into(),
        QuerySpec::FirstLast { .. } => parse::<FirstLastQueryResult>(body)?.into(),
        QuerySpec::Frequency { .. } => parse::<FrequencyQueryResult>(body)?.into(),
        QuerySpec::Distribution { .. } => parse::<DistributionQueryResult>(body)?.into(),
        QuerySpec::GapAnalysis { .. } => parse::<GapAnalysisQueryResult>(body)?.into(),
        QuerySpec::PatternSearch { .. } => parse::<PatternSearchQueryResult>(body)?.into(),
        QuerySpec::FrameInventory { .. } => return Err("an inventory is not a POST".into()),
    })
}

/// The gateway has no catalogue and compares whole payloads, so the narrowing to
/// inherited bytes, and the limit after it, happen here.
fn narrow(answer: &mut MirrorValidationQueryResult, compare: &BTreeSet<usize>, limit: Option<u32>) {
    answer.results.retain_mut(|r| {
        r.mismatch_indices =
            wiretap_analysis::query::differing_byte_indices(&r.mirror_payload, &r.source_payload, Some(compare));
        !r.mismatch_indices.is_empty()
    });
    answer.results.truncate(limit.map_or(usize::MAX, |n| n as usize));
    answer.stats.results_count = answer.results.len() as u64;
}

async fn api(settings: &dyn SettingsSource, profile_id: &str) -> Result<ApiProfile, String> {
    apiclient::resolve(&crate::dbquery::backend_profile(settings, profile_id).await?)
}

pub async fn run(
    settings: &dyn SettingsSource,
    profile_id: &str,
    spec: &QuerySpec,
    query_id: &str,
    compare: Option<&BTreeSet<usize>>,
) -> Result<QueryOutcome, String> {
    let api = api(settings, profile_id).await?;
    let request = request(api.protocol, spec, Some(query_id), compare.is_some())?;
    let mut outcome = match &request {
        GatewayRequest::Inventory(query) => {
            let (rows, truncated) = apiclient::read_inventory(&api, query.clone()).await?;
            QueryOutcome { results: QueryResults::FrameInventory(rows), stats: None, sql: Vec::new(), truncated }
        }
        GatewayRequest::Post(path, body) => {
            let answer = api
                .db()
                .query::<Value>(path, body, query_id)
                .await
                .map_err(apiclient::text)?;
            decode(spec, answer, compare)?
        }
    };
    outcome.sql = vec![text(&request)];
    Ok(outcome)
}

pub async fn preview(
    settings: &dyn SettingsSource,
    profile_id: &str,
    spec: &QuerySpec,
    narrowed: bool,
) -> Result<Vec<String>, String> {
    Ok(vec![text(&request(
        api(settings, profile_id).await?.protocol,
        spec,
        None,
        narrowed,
    )?)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use wslib_wiretap_gateway::{MirrorValidationResult, QueryStats};

    #[test]
    fn a_backend_profile_refuses_another_protocols_window() {
        let spec = |protocol| QuerySpec::FrameInventory {
            window: wslib_wiretap_gateway::RowWindow { protocol, start_us: None, end_us: None },
            limit: Some(5),
        };
        assert!(request(Protocol::ModbusRtu, &spec(Some(Protocol::Can)), None, false).is_err());
        for protocol in [None, Some(Protocol::ModbusRtu)] {
            assert_eq!(
                text(&request(Protocol::ModbusRtu, &spec(protocol), None, false).unwrap()),
                "GET /inventory?protocol=modbus&limit=5"
            );
        }
    }

    #[test]
    fn a_narrowed_mirror_limits_after_narrowing() {
        let mismatch = |ts, source: Vec<u8>| MirrorValidationResult {
            mirror_timestamp_us: ts,
            source_timestamp_us: ts,
            mirror_payload: vec![1, 2, 3],
            source_payload: source,
            mismatch_indices: vec![],
        };
        let mut answer = MirrorValidationQueryResult {
            results: vec![mismatch(1, vec![1, 2, 9]), mismatch(2, vec![9, 2, 3]), mismatch(3, vec![9, 9, 3])],
            stats: QueryStats { rows_scanned: 6, results_count: 3, execution_time_ms: 0 },
        };
        narrow(&mut answer, &BTreeSet::from([0]), Some(1));
        assert_eq!(answer.results.iter().map(|r| r.mirror_timestamp_us).collect::<Vec<_>>(), [2]);
        assert_eq!(answer.results[0].mismatch_indices, [0]);
        assert_eq!(answer.stats.results_count, 1);
    }
}
