// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { DiffKind } from "./DiffKind";

/**
 * One row of a unified diff, with 1-based line numbers for the gutter.
 *
 * A struct rather than `serde_json::Value` because two commands return these and one
 * of them counts them by kind: `row["kind"] == "add"` on untyped JSON compiles just
 * as happily when the string is wrong, and reports zero.
 */
export type DiffLine = { kind: DiffKind, text: string, oldLine: number | null, newLine: number | null, };
