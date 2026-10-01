// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What to create a repository as. Also the request shape of the create command.
 */
export type NewRepo = { name: string, description?: string | null, 
/**
 * Defaults to private: catalogues are reverse-engineering notes, so going
 * public should be a deliberate act.
 */
private?: boolean, };
