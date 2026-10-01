// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Info about a registered subscriber (for TypeScript)
 */
export type SubscriberInfo = { subscriber_id: string, 
/**
 * Human-readable app name (e.g., "discovery", "decoder")
 */
app_name: string, 
/**
 * Seconds since registration
 */
registered_seconds_ago: number, 
/**
 * Whether this subscriber is actively receiving frames
 */
is_active: boolean, };
