// ui/src/apps/catalog/dialogs/publish/publishSteps.ts
//
// Which progress steps a given push will run.

import type { PublishStep } from "../../../../api/catalogShare";

/**
 * The steps a given push will actually run. Rendering the full six would leave
 * `fork`, `branch` and `pr` permanently un-ticked on the default direct push, which
 * reads as a stall rather than as "not applicable".
 */
export function stepsFor({
  forkNeeded,
  creatingBranch,
  openPr,
}: {
  forkNeeded: boolean;
  creatingBranch: boolean;
  openPr: boolean;
}): PublishStep[] {
  return [
    "validate",
    "auth",
    ...(forkNeeded ? (["fork"] as const) : []),
    ...(creatingBranch ? (["branch"] as const) : []),
    "commit",
    ...(openPr ? (["pr"] as const) : []),
  ];
}
