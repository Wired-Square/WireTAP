//! The error type for every catalogue-sharing command.
//!
//! Module-level rather than transport-level: the URL parser, the provenance
//! registry and the filesystem paths all return it, and a later SSH publish
//! backend will too. Mapping an HTTP status onto a [`ShareErrorKind`] stays in
//! `github.rs`, which is the only place that knows about statuses.

use serde::{Deserialize, Serialize};

/// A typed failure. `kind` drives UI behaviour — whether to offer Retry, deep-link
/// to the account settings, or just show the message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareError {
    pub kind: ShareErrorKind,
    pub message: String,
    /// Seconds until a rate limit resets, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareErrorKind {
    /// Bad or missing token. The UI should route to account settings.
    Auth,
    /// Authenticated but not permitted — typically a fine-grained token missing
    /// a required permission.
    Forbidden,
    RateLimited,
    NotFound,
    /// Transport failure; retrying is reasonable.
    Network,
    /// The remote said no for some other reason; show its message verbatim.
    Api,
    /// A host we cannot serve.
    UnsupportedHost,
    /// Bad input, or a response we could not make sense of.
    Invalid,
}

impl ShareError {
    pub fn new(kind: ShareErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry_after_secs: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ShareErrorKind::Invalid, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ShareErrorKind::Network, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ShareErrorKind::NotFound, message)
    }
}

impl std::fmt::Display for ShareError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ShareError {}

impl From<reqwest::Error> for ShareError {
    fn from(e: reqwest::Error) -> Self {
        Self::network(format!("Network error: {e}"))
    }
}
