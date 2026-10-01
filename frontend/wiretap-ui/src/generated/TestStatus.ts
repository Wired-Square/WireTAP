// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What the run is doing, as the panel reads it.
 *
 * `Listening` is a responder that has not been bound to a run yet; everything
 * after `Running` is terminal. Typed rather than a bare string because
 * `run_auto` decides a phase passed by reading it back.
 */
export type TestStatus = "running" | "listening" | "completed" | "stopped" | "failed";
