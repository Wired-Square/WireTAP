// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MuxCaseDraft } from "./MuxCaseDraft";
import type { MuxSelector } from "./MuxSelector";

export type MuxDraft = { selector: MuxSelector, cases: { [key in number]: MuxCaseDraft }, };
