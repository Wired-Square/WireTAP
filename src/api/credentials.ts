// ui/src/api/credentials.ts
// Secure credential storage using the system keyring

import { invoke } from "@tauri-apps/api/core";

/**
 * Store a credential in the system keyring.
 * @param profileId - The IO profile ID (e.g., "io_1704067200000")
 * @param field - The credential field name (e.g., "password", "token")
 * @param value - The secret value to store
 */
export async function storeCredential(
  profileId: string,
  field: string,
  value: string
): Promise<void> {
  await invoke("store_credential", { profileId, field, value });
}

/**
 * Retrieve a credential from the system keyring.
 * @param profileId - The IO profile ID
 * @param field - The credential field name
 * @returns The secret value, or null if not found
 */
export async function getCredential(
  profileId: string,
  field: string
): Promise<string | null> {
  return await invoke<string | null>("get_credential", { profileId, field });
}

/**
 * Delete a credential from the system keyring.
 * @param profileId - The IO profile ID
 * @param field - The credential field name
 */
export async function deleteCredential(
  profileId: string,
  field: string
): Promise<void> {
  await invoke("delete_credential", { profileId, field });
}

/**
 * Delete all credentials for a profile (password, token, api_key, secret).
 * Use this when deleting an IO profile.
 * @param profileId - The IO profile ID
 */
export async function deleteAllCredentials(profileId: string): Promise<void> {
  await invoke("delete_all_credentials", { profileId });
}

/**
 * Fields that should be stored securely in the keyring.
 * When saving a profile, these fields are extracted and stored separately.
 * Mirrored by `SECURE_FIELDS` in `src-tauri/src/credentials.rs`, which sweeps
 * this same list when deleting or migrating a profile's secrets.
 */
export const SECURE_FIELDS = ["password", "token", "api_key", "secret"] as const;

export type SecureField = (typeof SECURE_FIELDS)[number];

/**
 * Check if a field name is a secure field that should be stored in keyring.
 */
export function isSecureField(field: string): field is SecureField {
  return SECURE_FIELDS.includes(field as SecureField);
}
