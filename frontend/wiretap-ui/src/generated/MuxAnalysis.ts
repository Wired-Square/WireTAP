// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MuxCaseProfile } from "./MuxCaseProfile";
import type { MuxDetection } from "./MuxDetection";

/**
 * A mux frame's cases, each profiled on its own.
 */
export type MuxAnalysis = { detection: MuxDetection, cases: Array<MuxCaseProfile>, };
