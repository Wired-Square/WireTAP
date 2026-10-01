// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * The cached GitHub identity. Whether a token exists lives in the keychain; this is
 * only what we resolved it to, so the UI can show a login without a round trip.
 */
export type GitIdentity = { host: string, login: string, scopes: Array<string>, validatedAt: string, };
