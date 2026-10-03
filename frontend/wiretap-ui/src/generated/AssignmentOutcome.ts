// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CatalogueFinding } from "./CatalogueFinding";

export type AssignmentOutcome = { "outcome": "done", warnings: Array<CatalogueFinding>, } | { "outcome": "rejected", error: string, findings: Array<CatalogueFinding>, } | { "outcome": "conflict", current: string | null, };
