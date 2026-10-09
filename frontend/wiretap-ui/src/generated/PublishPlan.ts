// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SecretFinding } from "./SecretFinding";

/**
 * What publishing would do, computed without any writes.
 */
export type PublishPlan = { upstream: string, targetPath: string, 
/**
 * The branch that will actually be committed to. Equal to `base_branch` for the
 * default direct push.
 */
branch: string, 
/**
 * The ref this catalogue was pulled from, falling back to the repository default.
 */
baseBranch: string, 
/**
 * What a branch would be called if the user asks for a pull request without
 * naming one. A pure function of the filename, so it stays true no matter which
 * checkboxes move — which is why `will_open_pr` is deliberately *not* here.
 * Putting a request-dependent field on the plan would stale it on every click and
 * force a network round trip per toggle.
 */
suggestedBranch: string, 
/**
 * Every branch in the clone, for the dialog's branch picker. Free — the clone is
 * already open here — and it replaces a `matching-refs` request per keystroke.
 * Empty when the refs could not be read: a picker with no suggestions still lets
 * the user type a new branch name, which is the primary use.
 */
branches: Array<string>, 
/**
 * The path's blob SHA on `base_branch`. `None` — the path is not there yet, so
 * this push creates it.
 */
baseBlobSha: string | null, 
/**
 * The bytes that would be committed are already on `base_branch`, so the dialog
 * can say "nothing to push" without asking for the file text.
 *
 * Deliberately against `base_branch` rather than `branch`: the plan is not
 * re-fetched when the branch field moves, so a verdict about some other branch
 * would go stale the moment it was useful. The push dialog's `publish_diff`
 * answers for the branch actually chosen.
 */
identicalToBase: boolean, 
/**
 * True when the account cannot push to the upstream, so the commit lands on a
 * fork. `can_push_upstream` used to sit beside this as its literal negation; the
 * only thing that ever read it was the commit-to-base checkbox this replaced.
 */
forkNeeded: boolean, 
/**
 * The content becomes public and permanent; drives the exposure warning.
 */
targetIsPublic: boolean, contentBytes: number, 
/**
 * `[meta].version` as the parser sees it — 1 when the key is absent, matching
 * `Meta`'s own default. A fact about the local file, like `content_bytes` beside
 * it, so it cannot go stale as checkboxes move; it is what lets the bump checkbox
 * name the numbers ("3 → 4") before it is ticked, which is what makes a
 * default-on checkbox defensible.
 */
metaVersion: number, 
/**
 * Empty when the catalogue is valid; publishing is blocked otherwise.
 */
validationErrors: Array<string>, secretFindings: Array<SecretFinding>, transmitFrameCount: number, 
/**
 * Set when this catalogue already has a pull request open.
 */
existingPrUrl?: string, };
