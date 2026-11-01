//! Secure credential storage in the OS store (`wslib_secret::OsStore`): the
//! Keychain on macOS and iOS, Credential Manager on Windows, Secret Service on Linux.
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
//! block below, [`migrate_legacy_io_profile_credentials`], `get_credential`'s
//! `None` arm, `delete_both`'s second delete, and the `discard_legacy` call in
//! `store_credential`. Nothing else depends on it.

use wslib_secret::{OsStore, Secret, SecretStore};

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
    os().resolve(profile, field)
}

/// Move a profile's secrets out of `connection` and into `store` (the keyring,
/// via [`store_io_secret`]), leaving a `_<field>_stored` marker behind.
///
/// Every path that writes a profile to settings.json must call this — a password
/// left in `connection` would be serialised in plaintext. A field the caller did
/// not supply is left alone, so an edit that never touched the password keeps
/// the stored one rather than clearing it.
pub fn split_secrets(
    profile: &mut IOProfile,
    mut store: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    for field in SECURE_FIELDS {
        let plaintext = profile
            .connection
            .get(field)
            .and_then(|v| v.as_str())
            .map(str::to_string);
        profile.connection.remove(field);

        if let Some(value) = plaintext.filter(|v| !v.trim().is_empty()) {
            store(&account_name(&profile.id, field), &value)?;
            profile
                .connection
                .insert(format!("_{field}_stored"), true.into());
        }
    }
    Ok(())
}

/// Drop every `_<field>_stored` marker. A new profile id has nothing in the
/// keyring, so a marker carried over from another profile would point at nothing.
pub fn forget_stored_secrets(profile: &mut IOProfile) {
    for field in SECURE_FIELDS {
        profile.connection.remove(&format!("_{field}_stored"));
    }
}

/// Store one IO-profile secret in the keyring, under the account `split_secrets` names.
pub fn store_io_secret(account: &str, value: &str) -> Result<(), String> {
    set_secret(IO_PROFILE_SERVICE, account, value)
}

/// Store a secret under an explicit service namespace.
pub fn set_secret(service: &str, account: &str, value: &str) -> Result<(), String> {
    os().set(service, account, value)
}

/// Read a secret. `Ok(None)` when no entry exists.
pub fn get_secret(service: &str, account: &str) -> Result<Option<String>, String> {
    os().get(service, account)
}

/// Delete a secret. Succeeds when there was nothing to delete.
pub fn delete_secret(service: &str, account: &str) -> Result<(), String> {
    os().delete(service, account)
}

/// Drain any legacy IO-profile secrets for the given profiles into the live
/// namespace, so entries nothing ever reads still get moved and the old
/// namespace empties. Call once, off the startup critical path — [`get_credential`]
/// is what guarantees a secret is migrated before it is used.
pub fn migrate_legacy_io_profile_credentials(profiles: &[IOProfile]) {
    os().migrate_legacy(profiles)
}

/// Store a credential in the system keyring.
#[tauri::command(rename_all = "camelCase")]
pub fn store_credential(profile_id: &str, field: &str, value: &str) -> Result<(), String> {
    os().store_credential(profile_id, field, value)
}

/// Retrieve a credential from the system keyring, falling back to the legacy
/// namespace (and draining it) for profiles saved before the rebrand.
/// Returns Ok(None) if no credential is stored.
#[tauri::command(rename_all = "camelCase")]
pub fn get_credential(profile_id: &str, field: &str) -> Result<Option<String>, String> {
    os().get_credential(profile_id, field)
}

/// Delete a credential from the system keyring.
/// Returns Ok(()) even if no credential was stored.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_credential(profile_id: &str, field: &str) -> Result<(), String> {
    os().delete_both(&account_name(profile_id, field))
}

/// Delete all credentials for a profile (password, token, etc.).
#[tauri::command(rename_all = "camelCase")]
pub fn delete_all_credentials(profile_id: &str) -> Result<(), String> {
    os().delete_all(profile_id)
}

// ── Store-parameterised core ─────────────────────────────────────────────────

fn os() -> Credentials<'static> {
    Credentials(&OsStore)
}

struct Credentials<'a>(&'a dyn SecretStore);

impl Credentials<'_> {
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.0
            .save(service, account, &Secret::new(value))
            .map_err(|e| format!("Failed to store credential: {e}"))
    }

    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        self.0
            .load(service, account)
            .map(|secret| secret.map(|s| s.expose().to_owned()))
            .map_err(|e| format!("Failed to retrieve credential: {e}"))
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        self.0
            .delete(service, account)
            .map_err(|e| format!("Failed to delete credential: {e}"))
    }

    fn holds(&self, service: &str, account: &str) -> bool {
        matches!(self.get(service, account), Ok(Some(_)))
    }

    fn resolve(&self, profile: &IOProfile, field: &str) -> Option<String> {
        if !has_stored_marker(profile, field) {
            return profile
                .connection
                .get(field)
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }

        match self.get_credential(&profile.id, field) {
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

    fn store_credential(&self, profile_id: &str, field: &str, value: &str) -> Result<(), String> {
        let account = account_name(profile_id, field);
        self.set(IO_PROFILE_SERVICE, &account, value)?;
        // A re-save must not leave the old entry behind for the fallback to resurrect.
        self.discard_legacy(&account);
        Ok(())
    }

    fn get_credential(&self, profile_id: &str, field: &str) -> Result<Option<String>, String> {
        let account = account_name(profile_id, field);
        match self.get(IO_PROFILE_SERVICE, &account)? {
            Some(value) => Ok(Some(value)),
            None => Ok(self.drain_legacy(&account)),
        }
    }

    fn delete_all(&self, profile_id: &str) -> Result<(), String> {
        for field in SECURE_FIELDS {
            self.delete_both(&account_name(profile_id, field))?;
        }
        Ok(())
    }

    /// Delete from both namespaces — leaving a legacy entry would let the read
    /// fallback resurrect a deleted secret.
    fn delete_both(&self, account: &str) -> Result<(), String> {
        self.delete(IO_PROFILE_SERVICE, account)?;
        self.delete(LEGACY_IO_PROFILE_SERVICE, account)
    }

    // ── Legacy namespace drain ───────────────────────────────────────────────

    /// Best-effort removal of a legacy entry. Failure is logged, never propagated —
    /// a lingering old entry is recoverable, a failed read or save is not.
    fn discard_legacy(&self, account: &str) {
        if let Err(e) = self.delete(LEGACY_IO_PROFILE_SERVICE, account) {
            tlog!("[credentials] Legacy delete failed for {}: {}", account, e);
        }
    }

    /// Move one account from the legacy namespace into the live one, returning the
    /// value that was moved.
    fn drain_legacy(&self, account: &str) -> Option<String> {
        let value = self.get(LEGACY_IO_PROFILE_SERVICE, account).unwrap_or_else(|e| {
            tlog!("[credentials] Legacy read failed for {}: {}", account, e);
            None
        })?;

        match self.set(IO_PROFILE_SERVICE, account, &value) {
            Ok(()) => {
                tlog!("[credentials] Migrated {} to {}", account, IO_PROFILE_SERVICE);
                self.discard_legacy(account);
            }
            Err(e) => tlog!("[credentials] Legacy copy failed for {}: {}", account, e),
        }

        Some(value)
    }

    /// Probes legacy first: once drained that is a keyring *miss*, which is far
    /// cheaper than the live *hit* the reverse order would pay on every launch.
    fn migrate_legacy(&self, profiles: &[IOProfile]) {
        for profile in profiles {
            for field in SECURE_FIELDS.iter().filter(|f| has_stored_marker(profile, f)) {
                let account = account_name(&profile.id, field);
                // A live entry always wins — draining over it would restore a stale value.
                if self.holds(LEGACY_IO_PROFILE_SERVICE, &account)
                    && !self.holds(IO_PROFILE_SERVICE, &account)
                {
                    self.drain_legacy(&account);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use wslib_secret::MemoryStore;

    fn profile(connection: serde_json::Value) -> IOProfile {
        serde_json::from_value(serde_json::json!({
            "id": "io_1", "name": "Bench", "kind": "gvret_tcp", "connection": connection
        }))
        .unwrap()
    }

    fn loaded(store: &MemoryStore, service: &str, account: &str) -> Option<String> {
        Credentials(store).get(service, account).unwrap()
    }

    fn seed(store: &MemoryStore, service: &str, account: &str, value: &str) {
        Credentials(store).set(service, account, value).unwrap();
    }

    #[test]
    fn an_unmarked_field_resolves_from_the_plaintext_connection() {
        let store = MemoryStore::default();
        seed(&store, IO_PROFILE_SERVICE, "io_1:password", "stored");
        let p = profile(serde_json::json!({ "password": "inline" }));
        assert_eq!(Credentials(&store).resolve(&p, "password").as_deref(), Some("inline"));
    }

    #[test]
    fn a_marked_field_resolves_from_the_store_and_never_from_plaintext() {
        let store = MemoryStore::default();
        let p = profile(serde_json::json!({ "_password_stored": true, "password": "inline" }));
        assert_eq!(Credentials(&store).resolve(&p, "password"), None);
        seed(&store, IO_PROFILE_SERVICE, "io_1:password", "stored");
        assert_eq!(Credentials(&store).resolve(&p, "password").as_deref(), Some("stored"));
    }

    #[test]
    fn a_legacy_only_secret_is_drained_into_the_live_namespace_on_read() {
        let store = MemoryStore::default();
        seed(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:token", "old");
        let p = profile(serde_json::json!({ "_token_stored": true }));
        assert_eq!(Credentials(&store).resolve(&p, "token").as_deref(), Some("old"));
        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:token").as_deref(), Some("old"));
        assert_eq!(loaded(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:token"), None);
    }

    #[test]
    fn storing_a_credential_discards_its_legacy_entry() {
        let store = MemoryStore::default();
        seed(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:password", "old");
        Credentials(&store).store_credential("io_1", "password", "new").unwrap();
        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:password").as_deref(), Some("new"));
        assert_eq!(loaded(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:password"), None);
    }

    #[test]
    fn deleting_a_profile_clears_both_namespaces_and_spares_sharing_tokens() {
        let store = MemoryStore::default();
        for field in SECURE_FIELDS {
            let account = account_name("io_1", field);
            seed(&store, IO_PROFILE_SERVICE, &account, "live");
            seed(&store, LEGACY_IO_PROFILE_SERVICE, &account, "old");
        }
        seed(&store, SHARING_SERVICE, "io_1:token", "github");
        Credentials(&store).delete_all("io_1").unwrap();
        for field in SECURE_FIELDS {
            let account = account_name("io_1", field);
            assert_eq!(loaded(&store, IO_PROFILE_SERVICE, &account), None);
            assert_eq!(loaded(&store, LEGACY_IO_PROFILE_SERVICE, &account), None);
        }
        assert_eq!(loaded(&store, SHARING_SERVICE, "io_1:token").as_deref(), Some("github"));
    }

    #[test]
    fn migration_drains_marked_fields_and_never_overwrites_a_live_entry() {
        let store = MemoryStore::default();
        seed(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:password", "old-password");
        seed(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:api_key", "old-key");
        seed(&store, IO_PROFILE_SERVICE, "io_1:api_key", "live-key");
        seed(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:token", "unmarked");
        let p = profile(serde_json::json!({ "_password_stored": true, "_api_key_stored": true }));

        Credentials(&store).migrate_legacy(&[p]);

        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:password").as_deref(), Some("old-password"));
        assert_eq!(loaded(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:password"), None);
        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:api_key").as_deref(), Some("live-key"));
        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:token"), None);
        assert_eq!(loaded(&store, LEGACY_IO_PROFILE_SERVICE, "io_1:token").as_deref(), Some("unmarked"));
    }

    #[test]
    fn splitting_stores_supplied_secrets_and_keeps_markers_for_untouched_ones() {
        let store = MemoryStore::default();
        let mut p = profile(serde_json::json!({
            "_password_stored": true, "api_key": "key", "token": "  ", "host": "10.0.0.1"
        }));
        split_secrets(&mut p, |account, value| Credentials(&store).set(IO_PROFILE_SERVICE, account, value))
            .unwrap();

        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:api_key").as_deref(), Some("key"));
        assert_eq!(loaded(&store, IO_PROFILE_SERVICE, "io_1:token"), None);
        for field in SECURE_FIELDS {
            assert!(!p.connection.contains_key(field), "{field} left in plaintext");
        }
        assert!(has_stored_marker(&p, "password"));
        assert!(has_stored_marker(&p, "api_key"));
        assert!(!has_stored_marker(&p, "token"));
        assert_eq!(p.connection["host"], "10.0.0.1".into());

        forget_stored_secrets(&mut p);
        assert!(SECURE_FIELDS.iter().all(|f| !has_stored_marker(&p, f)));
    }

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
