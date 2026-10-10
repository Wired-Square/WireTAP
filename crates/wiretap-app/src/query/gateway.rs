// crates/wiretap-app/src/query/gateway.rs
//
// A query against a WireTAP backend: the spec as the gateway's request, with
// RFC3339 bounds, and its answer. The server's SQL is its own; what this side
// can show is the request.

use std::collections::BTreeSet;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use wiretap_gateway::{
    ByteChangeQueryResult, CaptureProtocol, ByteChangesParams, DistributionParams, DistributionQueryResult,
    FirstLastParams, FirstLastQueryResult, FrameChangeQueryResult, FrameChangesParams,
    FrequencyParams, FrequencyQueryResult, GapAnalysisParams, GapAnalysisQueryResult,
    MirrorValidationParams, MirrorValidationQueryResult, MuxStatisticsParams,
    MuxStatisticsQueryResult, PatternSearchParams, PatternSearchQueryResult, QuerySpec,
};

use super::{QueryOutcome, QueryResults};
use crate::apiclient::{self, ApiProfile};

pub(super) enum Request {
    Get(String),
    Post(&'static str, Value),
}

impl Request {
    fn post(path: &'static str, body: impl Serialize) -> Self {
        Self::Post(path, serde_json::to_value(body).expect("gateway params serialise"))
    }

    pub(super) fn text(&self) -> String {
        match self {
            Self::Get(path) => format!("GET {path}"),
            Self::Post(path, body) => {
                format!("POST {path}\n{}", serde_json::to_string_pretty(body).unwrap_or_default())
            }
        }
    }
}

/// `narrowed`: a mirror validation the catalogue narrows asks for every mismatch.
pub(super) fn request(api: &ApiProfile, spec: &QuerySpec, query_id: Option<&str>, narrowed: bool) -> Result<Request, String> {
    let rows = &spec.row_filters()[0];
    if !rows.protocols.is_empty() && rows.protocols != CaptureProtocol::of(api.protocol) {
        return Err("a WireTAP backend profile reads only its own protocol".into());
    }
    let start = rows.start_us.map(apiclient::rfc3339).transpose()?;
    let end = rows.end_us.map(apiclient::rfc3339).transpose()?;
    let query_id = query_id.map(str::to_string);
    let filter = |frame_id: &u32, is_extended: &Option<bool>| {
        api.filter(*frame_id, *is_extended, start.clone(), end.clone())
    };
    Ok(match spec {
        QuerySpec::ByteChanges { frame_id, is_extended, byte_index, limit, .. } => Request::post(
            "/query/byte-changes",
            ByteChangesParams { filter: filter(frame_id, is_extended), byte_index: *byte_index, limit: *limit, query_id },
        ),
        QuerySpec::FrameChanges { frame_id, is_extended, limit, .. } => Request::post(
            "/query/frame-changes",
            FrameChangesParams { filter: filter(frame_id, is_extended), limit: *limit, query_id },
        ),
        QuerySpec::MirrorValidation { mirror_frame_id, source_frame_id, is_extended, tolerance_ms, limit, .. } => {
            Request::post(
                "/query/mirror-validation",
                MirrorValidationParams {
                    protocol: api.wire_protocol(),
                    mirror_frame_id: *mirror_frame_id,
                    source_frame_id: *source_frame_id,
                    is_extended: *is_extended,
                    tolerance_ms: *tolerance_ms,
                    start_time: start,
                    end_time: end,
                    limit: if narrowed { None } else { *limit },
                    query_id,
                },
            )
        }
        QuerySpec::MuxStatistics { frame_id, is_extended, mux_selector_byte, include_16bit, payload_length, limit, .. } => {
            Request::post(
                "/query/mux-statistics",
                MuxStatisticsParams {
                    filter: filter(frame_id, is_extended),
                    mux_selector_byte: *mux_selector_byte,
                    include_16bit: *include_16bit,
                    payload_length: *payload_length,
                    limit: *limit,
                    query_id,
                },
            )
        }
        QuerySpec::FirstLast { frame_id, is_extended, .. } => Request::post(
            "/query/first-last",
            FirstLastParams { filter: filter(frame_id, is_extended), query_id },
        ),
        QuerySpec::Frequency { frame_id, is_extended, bucket_size_ms, limit, .. } => Request::post(
            "/query/frequency",
            FrequencyParams { filter: filter(frame_id, is_extended), bucket_size_ms: *bucket_size_ms, limit: *limit, query_id },
        ),
        QuerySpec::Distribution { frame_id, is_extended, byte_index, .. } => Request::post(
            "/query/distribution",
            DistributionParams { filter: filter(frame_id, is_extended), byte_index: *byte_index, query_id },
        ),
        QuerySpec::GapAnalysis { frame_id, is_extended, gap_threshold_ms, limit, .. } => Request::post(
            "/query/gap-analysis",
            GapAnalysisParams {
                filter: filter(frame_id, is_extended),
                gap_threshold_ms: *gap_threshold_ms,
                limit: *limit,
                query_id,
            },
        ),
        QuerySpec::PatternSearch { pattern, pattern_mask, limit, .. } => Request::post(
            "/query/pattern-search",
            PatternSearchParams {
                protocol: api.wire_protocol(),
                pattern: pattern.clone(),
                pattern_mask: pattern_mask.clone(),
                start_time: start,
                end_time: end,
                limit: *limit,
                query_id,
            },
        ),
        QuerySpec::FrameInventory { .. } => Request::Get(apiclient::inventory_path(api, start.as_deref(), end.as_deref())),
    })
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

async fn api(app: &AppHandle, profile_id: &str) -> Result<ApiProfile, String> {
    apiclient::resolve(&crate::dbquery::backend_profile(app, profile_id).await?)
}

pub async fn run(
    app: &AppHandle,
    profile_id: &str,
    spec: &QuerySpec,
    query_id: &str,
    compare: Option<&BTreeSet<usize>>,
) -> Result<QueryOutcome, String> {
    let api = api(app, profile_id).await?;
    let request = request(&api, spec, Some(query_id), compare.is_some())?;
    let mut outcome = match &request {
        Request::Get(path) => {
            let mut rows = apiclient::read_inventory(&api, path).await?;
            if let QuerySpec::FrameInventory { limit: Some(limit), .. } = spec {
                rows.truncate(*limit as usize);
            }
            QueryOutcome { results: QueryResults::FrameInventory(rows), stats: None, sql: Vec::new() }
        }
        Request::Post(path, body) => decode(spec, apiclient::post_query(&api, path, body, query_id).await?, compare)?,
    };
    outcome.sql = vec![request.text()];
    Ok(outcome)
}

pub async fn preview(app: &AppHandle, profile_id: &str, spec: &QuerySpec, narrowed: bool) -> Result<Vec<String>, String> {
    Ok(vec![request(&api(app, profile_id).await?, spec, None, narrowed)?.text()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiretap_gateway::{MirrorValidationResult, QueryStats};

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
