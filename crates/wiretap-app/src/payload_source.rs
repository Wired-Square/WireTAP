// ui/crates/wiretap-app/src/payload_source.rs
//
// The app's `PayloadSource`s: a SQLite capture, and a WireTAP backend profile
// reached through the settings.

use wiretap_analysis::source::{InventoryRow, PayloadQuery, PayloadSource, Source};

use crate::capture_db::{self, source_error};
use crate::settings::SettingsSource;

/// Where a query runs: a SQLite capture or a WireTAP backend profile.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum QuerySource {
    Capture(String),
    Backend(String),
}

/// Resolve the source from the dual `capture_id` / `profile_id` MCP params.
pub fn resolve(
    capture_id: Option<String>,
    profile_id: Option<String>,
) -> Result<QuerySource, String> {
    match (capture_id, profile_id) {
        (Some(c), None) => Ok(QuerySource::Capture(c)),
        (None, Some(p)) => Ok(QuerySource::Backend(p)),
        (Some(_), Some(_)) => Err("Provide exactly one of capture_id / profile_id, not both".into()),
        (None, None) => Err("Provide one of capture_id or profile_id".into()),
    }
}

impl QuerySource {
    pub fn reader<'a>(&'a self, settings: &'a dyn SettingsSource) -> AppSource<'a> {
        match self {
            QuerySource::Capture(id) => AppSource::Capture(id),
            QuerySource::Backend(profile_id) => AppSource::Gateway(Gateway { settings, profile_id }),
        }
    }
}

/// A time bound typed into the MCP: RFC3339 with an offset, or integer epoch
/// microseconds. Anything else is refused rather than dropped.
pub fn parse_bound(s: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_micros())
        .or_else(|_| s.trim().parse::<i64>())
        .map_err(|_| format!("time bound {s:?} is neither RFC3339 with an offset nor integer microseconds"))
}

pub struct Gateway<'a> {
    settings: &'a dyn SettingsSource,
    profile_id: &'a str,
}

impl Source for Gateway<'_> {
    type Error = String;
}

impl PayloadSource for Gateway<'_> {
    async fn inventory(&self, start_us: Option<i64>, end_us: Option<i64>) -> Result<Vec<InventoryRow>, String> {
        crate::dbquery::db_frame_inventory(self.settings, self.profile_id, start_us, end_us).await
    }

    // No protocol and no stride: a backend profile reads one protocol, and a
    // modulo window over a multi-month archive is a full scan where the tail
    // query is an index seek. A capture is bounded and local, which is what
    // makes striding it affordable.
    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
        crate::dbquery::db_fetch_frame_payloads(
            self.settings,
            self.profile_id,
            q.frame_id,
            q.is_extended,
            q.limit,
        )
        .await
    }
}

pub enum AppSource<'a> {
    Capture(&'a str),
    Gateway(Gateway<'a>),
}

impl Source for AppSource<'_> {
    type Error = String;
}

impl PayloadSource for AppSource<'_> {
    async fn inventory(&self, start_us: Option<i64>, end_us: Option<i64>) -> Result<Vec<InventoryRow>, String> {
        match self {
            AppSource::Capture(id) => {
                capture_db::analyse(id, async move |c| c.inventory(start_us, end_us).await)
                    .await?
                    .map_err(source_error)
            }
            AppSource::Gateway(s) => s.inventory(start_us, end_us).await,
        }
    }

    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
        match self {
            AppSource::Capture(id) => {
                let (protocol, q) = (
                    q.protocol.map(str::to_owned),
                    PayloadQuery {
                        protocol: None,
                        ..q
                    },
                );
                capture_db::analyse(id, async move |c| {
                    c.payloads(PayloadQuery {
                        protocol: protocol.as_deref(),
                        ..q
                    })
                    .await
                })
                .await?
                .map_err(source_error)
            }
            AppSource::Gateway(s) => s.payloads(q).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_bound;

    /// The `rust` column of the bounds table: what the MCP makes of each input.
    #[test]
    fn parse_bound_matches_the_bounds_table() {
        let table: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../frontend/wiretap-ui/src/tests/fixtures/data/queryBounds.json"
            ))
            .expect("table"),
        )
        .expect("table json");
        for row in table["rows"].as_array().expect("rows") {
            let input = row["input"].as_str().expect("input");
            let expected = row["rust"].as_i64().ok_or("refused");
            assert_eq!(parse_bound(input).map_err(|_| "refused"), expected, "{input:?}");
        }
    }
}
