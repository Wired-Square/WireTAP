//! Secure credential storage using the system keyring.
//!
//! Uses the native OS credential store:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: Secret Service (GNOME Keyring, KWallet)

use keyring::Entry;

// Legacy name retained to preserve existing keyring entries
const SERVICE_NAME: &str = "com.candor.io-profiles";

/// Builds a unique account name for an IO profile credential.
fn account_name(profile_id: &str, field: &str) -> String {
    format!("{}:{}", profile_id, field)
}

/// Store a credential in the system keyring.
#[tauri::command(rename_all = "camelCase")]
pub fn store_credential(profile_id: &str, field: &str, value: &str) -> Result<(), String> {
    let account = account_name(profile_id, field);
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("Failed to store credential: {e}"))
}

/// Retrieve a credential from the system keyring.
/// Returns Ok(None) if no credential is stored.
#[tauri::command(rename_all = "camelCase")]
pub fn get_credential(profile_id: &str, field: &str) -> Result<Option<String>, String> {
    let account = account_name(profile_id, field);
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to retrieve credential: {e}")),
    }
}

/// Delete a credential from the system keyring.
/// Returns Ok(()) even if no credential was stored.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_credential(profile_id: &str, field: &str) -> Result<(), String> {
    let account = account_name(profile_id, field);
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already gone, that's fine
        Err(e) => Err(format!("Failed to delete credential: {e}")),
    }
}

/// Delete all credentials for a profile (password, token, etc.).
#[tauri::command(rename_all = "camelCase")]
pub fn delete_all_credentials(profile_id: &str) -> Result<(), String> {
    // Common credential field names
    let fields = ["password", "token", "api_key", "secret"];
    for field in fields {
        delete_credential_internal(profile_id, field)?;
    }
    Ok(())
}

/// Internal function for deleting a credential (not a Tauri command).
fn delete_credential_internal(profile_id: &str, field: &str) -> Result<(), String> {
    let account = account_name(profile_id, field);
    let entry = Entry::new(SERVICE_NAME, &account)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete credential: {e}")),
    }
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
}
