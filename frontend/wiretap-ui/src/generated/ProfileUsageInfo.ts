// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Response type for profile usage query
 */
export type ProfileUsageInfo = { 
/**
 * Profile ID
 */
profile_id: string, 
/**
 * Session IDs using this profile
 */
session_ids: Array<string>, 
/**
 * Number of sessions using this profile
 */
session_count: number, 
/**
 * Whether reconfiguration is locked (2+ sessions)
 */
config_locked: boolean, };
