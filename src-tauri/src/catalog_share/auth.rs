//! Keychain-backed GitHub token access.
//!
//! Keying the account by host leaves room for GitHub Enterprise later with no
//! schema change. The keyring service is deliberately separate from the
//! IO-profile one — see `credentials.rs`.
//!
//! Anonymous browsing and importing must keep working with no token at all: that
//! is the low-friction on-ramp. A token only lifts the rate limit, unlocks private
//! repositories, and enables publishing.
//!
//! Keychain is the only credential source in scope. Resolution goes through
//! [`stored_token`] so alternatives (a 1Password `op://` reference, `GITHUB_TOKEN`,
//! `gh auth token`) can be added later without touching any call site.

use tauri::{AppHandle, Manager};

use super::error::{ShareError, ShareErrorKind};
use super::github::{self, GitHubClient};
use super::registry::{CatalogSourceRegistry, GitIdentity};
use crate::credentials::{delete_secret, get_secret, set_secret, SHARING_SERVICE};

fn account_name(host: &str) -> String {
    format!("{host}:token")
}

/// Read the stored token for a host, if there is one.
///
/// A keyring failure is reported as "no token" rather than an error: the caller can
/// fall back to anonymous access, and failing a browse because the keychain was
/// locked would be worse than the rate limit.
pub fn stored_token(host: &str) -> Option<String> {
    get_secret(SHARING_SERVICE, &account_name(host))
        .ok()
        .flatten()
        .filter(|t| !t.trim().is_empty())
}

/// Read the token, or fail with an error the UI routes to account settings.
pub fn require_token(host: &str) -> Result<String, ShareError> {
    stored_token(host).ok_or_else(|| {
        ShareError::new(
            ShareErrorKind::Auth,
            "Connect a GitHub account first — Settings → Catalogs",
        )
    })
}

/// Validate a token and store it.
///
/// Validated *before* storing, so a typo never becomes a persisted credential that
/// fails later at publish time with a confusing error.
#[tauri::command(rename_all = "camelCase")]
pub async fn set_git_token(
    app: AppHandle,
    host: String,
    token: String,
) -> Result<GitIdentity, ShareError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(ShareError::invalid("Paste a personal access token"));
    }

    let identity = GitHubClient::new(Some(token.clone()))
        .get_authenticated_identity(&host)
        .await?;

    set_secret(SHARING_SERVICE, &account_name(&host), &token)
        .map_err(|e| ShareError::invalid(format!("Could not save the token: {e}")))?;

    // Cache the resolved login so the settings UI can show it without a round trip.
    app.state::<CatalogSourceRegistry>()
        .write(&app, |r| r.identity = Some(identity.clone()));
    Ok(identity)
}

/// The cached identity for a host, or `None` when no token is stored.
///
/// The token itself never crosses the IPC boundary — only whether one exists and
/// what it resolved to.
#[tauri::command(rename_all = "camelCase")]
pub fn get_git_identity(app: AppHandle, host: String) -> Result<Option<GitIdentity>, ShareError> {
    if stored_token(&host).is_none() {
        return Ok(None);
    }
    Ok(app
        .state::<CatalogSourceRegistry>()
        .read(&app, |r| r.identity.clone())
        .filter(|i| i.host == host))
}

/// Re-validate the stored token, refreshing the cached login and scopes.
#[tauri::command(rename_all = "camelCase")]
pub async fn verify_git_token(app: AppHandle, host: String) -> Result<GitIdentity, ShareError> {
    let token = require_token(&host)?;
    let identity = GitHubClient::new(Some(token))
        .get_authenticated_identity(&host)
        .await
        .inspect_err(|e| {
            // A rejected token leaves the keychain entry alone, so the message can be
            // "token rejected" rather than "no token".
            if e.kind == ShareErrorKind::Auth {
                app.state::<CatalogSourceRegistry>()
                    .write_if(&app, |r| r.identity.take().is_some());
            }
        })?;
    app.state::<CatalogSourceRegistry>()
        .write(&app, |r| r.identity = Some(identity.clone()));
    Ok(identity)
}

/// Forget the stored token and cached identity.
#[tauri::command(rename_all = "camelCase")]
pub fn clear_git_token(app: AppHandle, host: String) -> Result<(), ShareError> {
    delete_secret(SHARING_SERVICE, &account_name(&host))
        .map_err(|e| ShareError::invalid(format!("Could not remove the token: {e}")))?;
    app.state::<CatalogSourceRegistry>()
        .write_if(&app, |r| r.identity.take().is_some());
    Ok(())
}

/// URL of GitHub's token-creation page, pre-filled with the scope publishing needs.
///
/// `public_repo` on a classic token is the recommendation: fine-grained tokens are
/// pinned to named repositories, which cannot express "fork an upstream I have not
/// forked yet".
#[tauri::command(rename_all = "camelCase")]
pub fn git_token_setup_url() -> String {
    format!(
        "https://{}/settings/tokens/new?scopes=public_repo&description=WireTAP",
        github::SUPPORTED_HOST
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_name_is_host_scoped() {
        assert_eq!(account_name("github.com"), "github.com:token");
        assert_eq!(account_name("ghe.example.com"), "ghe.example.com:token");
    }

    /// The whole point of the separate constant — guard against someone "tidying up"
    /// by pointing this at the IO-profile bucket, whose bulk delete would wipe it.
    #[test]
    fn sharing_service_is_not_the_io_profile_service() {
        assert_ne!(SHARING_SERVICE, crate::credentials::IO_PROFILE_SERVICE);
    }

    #[test]
    fn setup_url_requests_the_scope_publishing_needs() {
        let url = git_token_setup_url();
        assert!(url.starts_with("https://github.com/settings/tokens/new"));
        assert!(url.contains("scopes=public_repo"));
    }
}
