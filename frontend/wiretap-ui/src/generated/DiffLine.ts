// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { DiffKind } from "./DiffKind";

/**
 * One row of a unified diff, with 1-based line numbers for the gutter.
 */
export type DiffLine = { kind: DiffKind, text: string, oldLine: number | null, newLine: number | null, };
