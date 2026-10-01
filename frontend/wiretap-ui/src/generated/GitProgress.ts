// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Emitted while a clone or fetch is running, so a first browse of a large repository
 * does not look like a hang.
 */
export type GitProgress = { repoId: string, 
/**
 * `clone`, `fetch` or `push` — a first clone is much slower and the UI says so.
 */
phase: "clone" | "fetch" | "push", receivedObjects: number, totalObjects: number, receivedBytes: number, };
