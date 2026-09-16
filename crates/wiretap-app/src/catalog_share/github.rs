//! GitHub REST client for the parts of sharing that are not git.
//!
//! Forks and pull requests are GitHub *product* concepts, not git operations, so they
//! need an API client however the files themselves move. Everything that git can do —
//! listing a tree, reading a blob, creating a branch, committing, pushing — now goes
//! through `git.rs` against a real clone, and used to live here.
//!
//! Everything here goes through Rust rather than the webview because the app's CSP
//! blocks `connect-src` to `api.github.com`; see `check_for_updates` in `settings.rs`
//! for the same pattern.
//!
//! ## Request budget
//!
//! The anonymous API limit is 60 requests an hour. What is left in this module is
//! cheap by construction: one `GET /repos/{owner}/{repo}` per browse or publish for
//! the default branch, visibility and push access, plus a handful of pull-request
//! calls. Enumerating and reading catalogues costs no API requests at all now that a
//! clone answers those questions.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use super::error::{ShareError, ShareErrorKind};
use super::registry::GitIdentity;
use super::url::CatalogSource;

const API_ROOT: &str = "https://api.github.com";
const USER_AGENT: &str = "WireTAP-App";
const API_VERSION: &str = "2022-11-28";

/// Only host we can actually talk to. Other hosts parse fine (so the error can be
/// about capability rather than syntax) but stop here.
pub const SUPPORTED_HOST: &str = "github.com";

/// Largest catalogue we will fetch. Real ones are tens of KB; the cap protects the
/// TOML parser and the line diff from a hostile or accidental blob.
pub const MAX_CATALOG_BYTES: u64 = 2 * 1024 * 1024;

/// Upper bound on candidate files offered from one repository.
pub const MAX_CANDIDATES: usize = 200;

/// How many REST calls to run at once. Bounded because GitHub asks that clients avoid
/// many concurrent requests to one endpoint. Used for polling open pull requests.
pub const FETCH_CONCURRENCY: usize = 6;

/// How many repositories to fetch at once during an update check.
///
/// Lower than [`FETCH_CONCURRENCY`] on purpose: these are whole git fetches on
/// blocking threads, not small JSON GETs, and the first check after upgrading has no
/// clones at all — so this is the number of simultaneous *full clones* a user can
/// trigger by pressing "Check for updates" once.
pub const GIT_CONCURRENCY: usize = 3;

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .expect("failed to build HTTP client for catalogue sharing")
});

/// Rejects a source whose host we cannot serve, with a message about capability.
pub fn require_supported_host(source: &CatalogSource) -> Result<(), ShareError> {
    if source.host == SUPPORTED_HOST || source.host == "raw.githubusercontent.com" {
        return Ok(());
    }
    Err(ShareError::new(
        ShareErrorKind::UnsupportedHost,
        format!(
            "Only {SUPPORTED_HOST} is supported at the moment — {} repositories cannot be imported yet",
            source.host
        ),
    ))
}

// ── Wire types ───────────────────────────────────────────────────────────────

/// Subset of the repository object we act on. Frontend-facing, hence camelCase.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub default_branch: String,
    pub private: bool,
    pub fork: bool,
    /// Whether the authenticated user can push — decides fork mode vs direct mode.
    pub can_push: bool,
    pub allow_forking: bool,
    pub html_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `parent.full_name` for a fork, so a candidate fork can be confirmed to
    /// descend from the upstream we mean.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_full_name: Option<String>,
}

// ── GitHub's own shapes (snake_case, deserialise only) ───────────────────────

#[derive(Debug, Deserialize)]
struct RawRepo {
    name: String,
    full_name: String,
    default_branch: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    allow_forking: bool,
    html_url: String,
    description: Option<String>,
    owner: Option<RawOwner>,
    permissions: Option<RawPermissions>,
    /// Only the name is read, so this is deliberately not a recursive `RawRepo` —
    /// a parent object missing any required field would fail the whole parse.
    parent: Option<RawParent>,
}

#[derive(Debug, Deserialize)]
struct RawOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RawParent {
    full_name: String,
}

#[derive(Debug, Deserialize)]
struct RawPermissions {
    #[serde(default)]
    push: bool,
}

impl From<RawRepo> for RepoInfo {
    fn from(r: RawRepo) -> Self {
        let owner = r
            .owner
            .as_ref()
            .map(|o| o.login.clone())
            .or_else(|| r.full_name.split('/').next().map(str::to_string))
            .unwrap_or_default();
        Self {
            owner,
            name: r.name,
            full_name: r.full_name,
            default_branch: r.default_branch.unwrap_or_else(|| "main".to_string()),
            private: r.private,
            fork: r.fork,
            can_push: r.permissions.map(|p| p.push).unwrap_or(false),
            allow_forking: r.allow_forking,
            html_url: r.html_url,
            description: r.description,
            parent_full_name: r.parent.map(|p| p.full_name),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RawPull {
    number: u64,
    html_url: String,
    #[serde(default)]
    merged: bool,
}


/// An open or merged pull request.
#[derive(Debug, Clone)]
pub struct PullRequest {
    pub number: u64,
    pub html_url: String,
    pub merged: bool,
}

/// What to create a repository as. Also the request shape of the create command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRepo {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Defaults to private: catalogues are reverse-engineering notes, so going
    /// public should be a deliberate act.
    #[serde(default = "default_true")]
    pub private: bool,
}

fn default_true() -> bool {
    true
}


/// The pull request to open. Grouped because the same fields travel together
/// through the client and the publish backend.
#[derive(Debug, Clone)]
pub struct PullSpec {
    /// Owner of the branch — the fork, or the upstream with direct push access.
    pub head_owner: String,
    pub branch: String,
    pub base: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

// ── Tree cache ───────────────────────────────────────────────────────────────

// ── Client ───────────────────────────────────────────────────────────────────

pub struct GitHubClient {
    token: Option<String>,
}

impl GitHubClient {
    pub fn new(token: Option<String>) -> Self {
        Self { token }
    }

    pub fn is_authenticated(&self) -> bool {
        self.token.is_some()
    }

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.request(reqwest::Method::GET, url)
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let mut req = HTTP
            .request(method, url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", API_VERSION);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        req
    }

    /// `GET /user` — validates the token and resolves the login.
    ///
    /// Classic tokens report their grants in `x-oauth-scopes`; fine-grained ones send
    /// nothing, so an empty scope list is not an error.
    pub async fn get_authenticated_identity(
        &self,
        host: &str,
    ) -> Result<GitIdentity, ShareError> {
        let response = self.get(&format!("{API_ROOT}/user")).send().await?;
        let scopes = response
            .headers()
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let response = self.check(response, "the authenticated user").await?;
        let user: RawUser = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read the GitHub account: {e}")))?;
        Ok(GitIdentity {
            host: host.to_string(),
            login: user.login,
            scopes,
            validated_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// `POST /user/repos` — create a repository under the authenticated account.
    ///
    /// `auto_init` matters: an empty repository has no default branch, and the refs
    /// API answers 409 for it, so the first publish would need a special case.
    pub async fn create_repo(&self, new: &NewRepo) -> Result<RepoInfo, ShareError> {
        let body = serde_json::json!({
            "name": new.name,
            "description": new.description,
            "private": new.private,
            "auto_init": true,
        });
        let response = self
            .request(reqwest::Method::POST, &format!("{API_ROOT}/user/repos"))
            .json(&body)
            .send()
            .await?;
        let response = self.check(response, &new.name).await?;
        let raw: RawRepo = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read the new repository: {e}")))?;
        Ok(raw.into())
    }

    /// `POST /repos/{owner}/{repo}/forks`
    ///
    /// Returns the fork's `full_name` from the response rather than assuming
    /// `{login}/{repo}` — GitHub appends `-1` when you already own a repository of
    /// that name. Forking is asynchronous, so the caller must poll.
    pub async fn create_fork(&self, owner: &str, repo: &str) -> Result<String, ShareError> {
        let url = format!("{API_ROOT}/repos/{owner}/{repo}/forks");
        let response = self.request(reqwest::Method::POST, &url).send().await?;
        let response = self.check(response, &format!("{owner}/{repo}")).await?;
        let raw: RawRepo = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read the fork: {e}")))?;
        Ok(raw.full_name)
    }

    /// The open pull request for `{head_owner}:{branch}` **against `base`**, if there
    /// is one.
    ///
    /// Checked before creating: a push to a branch already under review updates that
    /// PR, so opening a second would be wrong.
    ///
    /// Filtering on `base` as well as `head` matters now that the base varies with a
    /// catalogue's provenance. Without it, an open PR from the same branch against a
    /// *different* base is reported as this one, and the base the user was shown in
    /// the plan is silently discarded.
    pub async fn find_open_pull(
        &self,
        owner: &str,
        repo: &str,
        head_owner: &str,
        branch: &str,
        base: &str,
    ) -> Result<Option<PullRequest>, ShareError> {
        let url = format!(
            "{API_ROOT}/repos/{owner}/{repo}/pulls?head={head_owner}:{branch}&base={base}&state=open"
        );
        let response = self.get(&url).send().await?;
        let response = self.check(response, "pull requests").await?;
        let pulls: Vec<RawPull> = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read pull requests: {e}")))?;
        Ok(pulls.into_iter().next().map(|p| PullRequest {
            number: p.number,
            html_url: p.html_url,
            merged: p.merged,
        }))
    }

    /// `POST /repos/{owner}/{repo}/pulls`
    pub async fn create_pull(
        &self,
        owner: &str,
        repo: &str,
        spec: &PullSpec,
    ) -> Result<PullRequest, ShareError> {
        let url = format!("{API_ROOT}/repos/{owner}/{repo}/pulls");
        let body = serde_json::json!({
            "title": spec.title,
            "body": spec.body,
            "head": format!("{}:{}", spec.head_owner, spec.branch),
            "base": spec.base,
            "draft": spec.draft,
            "maintainer_can_modify": true,
        });
        let response = self
            .request(reqwest::Method::POST, &url)
            .json(&body)
            .send()
            .await?;
        let response = self.check(response, &format!("{owner}/{repo}")).await?;
        let pull: RawPull = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read the pull request: {e}")))?;
        Ok(PullRequest {
            number: pull.number,
            html_url: pull.html_url,
            merged: pull.merged,
        })
    }

    /// `GET /repos/{owner}/{repo}/pulls/{number}` — current state of one PR.
    pub async fn get_pull(
        &self,
        owner: &str,
        repo: &str,
        number: u64,
    ) -> Result<PullRequest, ShareError> {
        let url = format!("{API_ROOT}/repos/{owner}/{repo}/pulls/{number}");
        let response = self.get(&url).send().await?;
        let response = self.check(response, &format!("pull request #{number}")).await?;
        let pull: RawPull = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read the pull request: {e}")))?;
        Ok(PullRequest {
            number: pull.number,
            html_url: pull.html_url,
            merged: pull.merged,
        })
    }

    /// `GET /repos/{owner}/{repo}`
    pub async fn get_repo(&self, owner: &str, repo: &str) -> Result<RepoInfo, ShareError> {
        let url = format!("{API_ROOT}/repos/{owner}/{repo}");
        let response = self.get(&url).send().await?;
        let response = self.check(response, &format!("{owner}/{repo}")).await?;
        let raw: RawRepo = response
            .json()
            .await
            .map_err(|e| ShareError::invalid(format!("Could not read repository details: {e}")))?;
        Ok(raw.into())
    }

    /// Map a non-2xx response onto a typed error, preferring GitHub's own message.
    async fn check(
        &self,
        response: reqwest::Response,
        subject: &str,
    ) -> Result<reqwest::Response, ShareError> {
        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status();
        let remaining = read_rate_remaining(&response);
        let reset_in = read_rate_reset_secs(&response);
        let detail = read_error_message(response).await;

        let kind = match status.as_u16() {
            401 => ShareErrorKind::Auth,
            403 | 429 if remaining == Some(0) => ShareErrorKind::RateLimited,
            403 => ShareErrorKind::Forbidden,
            404 => ShareErrorKind::NotFound,
            _ => ShareErrorKind::Api,
        };

        let message = match kind {
            ShareErrorKind::Auth => {
                "GitHub rejected the stored token — reconnect your GitHub account".to_string()
            }
            ShareErrorKind::RateLimited => {
                let base = if self.is_authenticated() {
                    "GitHub's API rate limit is exhausted".to_string()
                } else {
                    "GitHub's anonymous API rate limit (60 requests an hour) is exhausted — \
                     connecting a GitHub account raises it to 5000"
                        .to_string()
                };
                match reset_in {
                    Some(secs) => format!("{base}. It resets in about {} minutes", secs / 60 + 1),
                    None => base,
                }
            }
            ShareErrorKind::Forbidden => format!(
                "GitHub refused access to {subject}: {detail}. A fine-grained token needs \
                 Contents (read) on that repository"
            ),
            ShareErrorKind::NotFound => format!(
                "{subject} was not found — check the URL, and note that a private repository \
                 needs a connected GitHub account"
            ),
            _ => format!("GitHub returned {status} for {subject}: {detail}"),
        };

        Err(ShareError {
            kind,
            message,
            retry_after_secs: reset_in,
        })
    }
}

fn read_rate_remaining(response: &reqwest::Response) -> Option<u32> {
    response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

/// Seconds until the limit resets. `x-ratelimit-reset` is an absolute unix time,
/// so this needs the wall clock.
fn read_rate_reset_secs(response: &reqwest::Response) -> Option<u64> {
    let reset = response
        .headers()
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())?;
    let now = chrono::Utc::now().timestamp();
    (reset > now).then(|| (reset - now) as u64)
}

/// GitHub error bodies are `{ "message": ..., "errors": [...] }`. Its messages are
/// good, so surface them rather than inventing our own.
async fn read_error_message(response: reqwest::Response) -> String {
    #[derive(Deserialize)]
    struct ErrorBody {
        message: Option<String>,
    }
    match response.json::<ErrorBody>().await {
        Ok(body) => body.message.unwrap_or_else(|| "no detail given".to_string()),
        Err(_) => "no detail given".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog_share::url::parse_catalog_source;

    #[test]
    fn unsupported_hosts_are_rejected_by_capability() {
        let source = parse_catalog_source("https://gitlab.com/o/r").expect("parses");
        let err = require_supported_host(&source).expect_err("gitlab is not supported");
        assert_eq!(err.kind, ShareErrorKind::UnsupportedHost);
        assert!(err.message.contains("gitlab.com"));
    }

    #[test]
    fn github_and_raw_hosts_are_supported() {
        for input in [
            "https://github.com/o/r",
            "https://raw.githubusercontent.com/o/r/main/x.toml",
        ] {
            let source = parse_catalog_source(input).expect("parses");
            assert!(require_supported_host(&source).is_ok(), "{input}");
        }
    }
}
