//! Secure credential storage using the system keyring.
//!
//! Uses the native OS credential store:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: Secret Service (GNOME Keyring, KWallet)
//!
//! Two live service namespaces. IO-profile secrets and catalogue-sharing tokens
//! are kept apart so sharing tokens are out of scope of
//! [`delete_all_credentials`]'s field sweep — otherwise deleting an unrelated IO
//! profile could wipe a GitHub token.
//!
//! A third, legacy namespace is drained on read and by
//! [`migrate_legacy_io_profile_credentials`]; nothing writes to it.
//!
//! **The drain is transitional — delete it once 0.10 is well established.** The
//! deletable unit is [`LEGACY_IO_PROFILE_SERVICE`], the "legacy namespace drain"
//! block below, [`get_credential`]'s `None` arm, `delete_both`'s second delete,
//! and the `discard_legacy` call in [`store_credential`]. Nothing else depends
//! on it.

use keyring::Entry;

use crate::settings::IOProfile;

/// IO-profile secrets.
pub const IO_PROFILE_SERVICE: &str = "com.wiredsquare.wiretap.io-profiles";

/// Pre-rebrand IO-profile service name. Read-and-drain only — never written to.
const LEGACY_IO_PROFILE_SERVICE: &str = "com.candor.io-profiles";

/// Catalogue-sharing credentials (git hosting tokens).
pub const SHARING_SERVICE: &str = "com.wiredsquare.wiretap.sharing";

/// Fields that may hold a secret for an IO profile. Mirrored by `SECURE_FIELDS`
/// in `src/api/credentials.ts`.
const SECURE_FIELDS: [&str; 4] = ["password", "token", "api_key", "secret"];

/// Builds a unique account name for an IO profile credential.
fn account_name(profile_id: &str, field: &str) -> String {
    format!("{}:{}", profile_id, field)
}

/// Whether a profile's connection carries the `_{field}_stored` marker saying
/// this field's value lives in the keyring rather than in `settings.json`.
pub fn has_stored_marker(profile: &IOProfile, field: &str) -> bool {
    profile
        .connection
        .get(&format!("_{}_stored", field))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Resolve one of a profile's secrets: from the keyring when the profile carries
/// the marker, otherwise from the plaintext connection value that pre-keyring
/// profiles still hold. `None` when neither has it.
pub fn resolve_secret(profile: &IOProfile, field: &str) -> Option<String> {
    if !has_stored_marker(profile, field) {
        return profile
            .connection
            .get(field)
            .and_then(|v| v.as_str())
            .map(str::to_string);
    }

    match get_credential(&profile.id, field) {
        Ok(Some(value)) => Some(value),
        Ok(None) => {
            tlog!(
                "[credentials] Profile {} is marked as storing {} in the keyring, but no entry exists",
                profile.id, field
            );
            None
        }
        Err(e) => {
            tlog!(
                "[credentials] Failed to read {} for profile {}: {}",
                field, profile.id, e
            );
            None
        }
    }
}

// ── Service-parameterised core ───────────────────────────────────────────────

/// Store a secret under an explicit service namespace.
pub fn set_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    entry(service, account)?
        .set_password(value)
        .map_err(|e| format!("Failed to store credential: {e}"))
}

/// Read a secret. `Ok(None)` when no entry exists.
pub fn get_secret(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to retrieve credential: {e}")),
    }
}

/// Delete a secret. Succeeds when there was nothing to delete.
pub fn delete_secret(service: &str, account: &str) -> Result<(), String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete credential: {e}")),
    }
}

fn entry(service: &str, account: &str) -> Result<Entry, String> {
    Entry::new(service, account).map_err(|e| format!("Failed to create keyring entry: {e}"))
}

// ── Legacy namespace drain ───────────────────────────────────────────────────

/// Best-effort removal of a legacy entry. Failure is logged, never propagated —
/// a lingering old entry is recoverable, a failed read or save is not.
fn discard_legacy(account: &str) {
    if let Err(e) = delete_secret(LEGACY_IO_PROFILE_SERVICE, account) {
        tlog!("[credentials] Legacy delete failed for {}: {}", account, e);
    }
}

/// Move one account from the legacy namespace into the live one, returning the
/// value that was moved.
fn drain_legacy(account: &str) -> Option<String> {
    let value = get_secret(LEGACY_IO_PROFILE_SERVICE, account).unwrap_or_else(|e| {
        tlog!("[credentials] Legacy read failed for {}: {}", account, e);
        None
    })?;

    match set_secret(IO_PROFILE_SERVICE, account, &value) {
        Ok(()) => {
            tlog!("[credentials] Migrated {} to {}", account, IO_PROFILE_SERVICE);
            discard_legacy(account);
        }
        Err(e) => tlog!("[credentials] Legacy copy failed for {}: {}", account, e),
    }

    Some(value)
}

/// Drain any legacy IO-profile secrets for the given profiles into the live
/// namespace, so entries nothing ever reads still get moved and the old
/// namespace empties. Call once, off the startup critical path — [`get_credential`]
/// is what guarantees a secret is migrated before it is used.
///
/// Probes legacy first: once drained that is a keyring *miss*, which is far
/// cheaper than the live *hit* the reverse order would pay on every launch.
pub fn migrate_legacy_io_profile_credentials(profiles: &[IOProfile]) {
    for profile in profiles {
        for field in SECURE_FIELDS.iter().filter(|f| has_stored_marker(profile, f)) {
            let account = account_name(&profile.id, field);
            if get_secret(LEGACY_IO_PROFILE_SERVICE, &account).ok().flatten().is_none() {
                continue;
            }
            // A live entry always wins — draining over it would restore a stale value.
            if get_secret(IO_PROFILE_SERVICE, &account).ok().flatten().is_none() {
                drain_legacy(&account);
            }
        }
    }
}

// ── IO-profile commands ──────────────────────────────────────────────────────

/// Store a credential in the system keyring.
#[tauri::command(rename_all = "camelCase")]
pub fn store_credential(profile_id: &str, field: &str, value: &str) -> Result<(), String> {
    let account = account_name(profile_id, field);
    set_secret(IO_PROFILE_SERVICE, &account, value)?;
    // A re-save must not leave the old entry behind for the fallback to resurrect.
    discard_legacy(&account);
    Ok(())
}

/// Retrieve a credential from the system keyring, falling back to the legacy
/// namespace (and draining it) for profiles saved before the rebrand.
/// Returns Ok(None) if no credential is stored.
#[tauri::command(rename_all = "camelCase")]
pub fn get_credential(profile_id: &str, field: &str) -> Result<Option<String>, String> {
    let account = account_name(profile_id, field);
    match get_secret(IO_PROFILE_SERVICE, &account)? {
        Some(value) => Ok(Some(value)),
        None => Ok(drain_legacy(&account)),
    }
}

/// Delete a credential from the system keyring.
/// Returns Ok(()) even if no credential was stored.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_credential(profile_id: &str, field: &str) -> Result<(), String> {
    delete_both(&account_name(profile_id, field))
}

/// Delete all credentials for a profile (password, token, etc.).
#[tauri::command(rename_all = "camelCase")]
pub fn delete_all_credentials(profile_id: &str) -> Result<(), String> {
    for field in SECURE_FIELDS {
        delete_both(&account_name(profile_id, field))?;
    }
    Ok(())
}

/// Delete from both namespaces — leaving a legacy entry would let the read
/// fallback resurrect a deleted secret.
fn delete_both(account: &str) -> Result<(), String> {
    delete_secret(IO_PROFILE_SERVICE, account)?;
    delete_secret(LEGACY_IO_PROFILE_SERVICE, account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_account_name() {
        assert_eq!(
            account_name("io_123456", "password"),
            "io_123456:password"
        );
    }

    /// The separation is load-bearing: a sharing token filed under the IO-profile
    /// service would be in scope of `delete_all_credentials`'s field sweep.
    #[test]
    fn service_namespaces_are_distinct() {
        assert_ne!(IO_PROFILE_SERVICE, SHARING_SERVICE);
    }

    /// Live namespaces carry the current identifier; only the drain-only legacy
    /// constant may name the old app.
    #[test]
    fn live_services_are_wiretap_namespaced() {
        for service in [IO_PROFILE_SERVICE, SHARING_SERVICE] {
            assert!(service.starts_with("com.wiredsquare.wiretap"));
            assert!(!service.to_lowercase().contains("candor"));
        }
    }
}
