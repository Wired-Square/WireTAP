// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ChecksumCandidate } from "./ChecksumCandidate";
import type { ChecksumNote } from "./ChecksumNote";
import type { ColumnStats } from "./ColumnStats";

export type ChecksumDetectionResult = { candidates: Array<ChecksumCandidate>, bestCandidate: ChecksumCandidate | null, tailColumns: Array<ColumnStats>, 
/**
 * Result-level explanation, including why nothing was found.
 */
notes: Array<ChecksumNote>, };
