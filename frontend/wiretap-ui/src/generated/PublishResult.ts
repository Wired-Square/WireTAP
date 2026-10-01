// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { PublishAction } from "./PublishAction";
import type { VersionBump } from "./VersionBump";

export type PublishResult = { action: PublishAction, prUrl?: string, prNumber?: number, commitUrl?: string, headOwner: string, branch: string, reusedBranch: boolean, 
/**
 * `None` means no bump was asked for. A bump that was asked for but *withheld*
 * because the push would have changed nothing never reaches a result at all —
 * `push_blocking` refuses the unchanged tree first.
 */
versionBump?: VersionBump, };
