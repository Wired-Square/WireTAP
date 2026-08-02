// ui/src/apps/catalog/dialogs/publish/types.ts
//
// Shared vocabulary for the push dialog's tabs.

import type { useTranslation } from "react-i18next";

/** The namespace-bound `t` every file in this folder passes around. */
export type T = ReturnType<typeof useTranslation>["t"];

/** The three tabs, in strip order. */
export type PublishTab = "push" | "branch" | "diff";

/**
 * One reason the Push button is off.
 *
 * A list rather than a first-match, because more than one can hold at once and the
 * old dialog showed only the pull-request conflict when it did, hiding the validation
 * errors underneath it.
 *
 * `tab` names the tab whose controls resolve it, which is what makes a blocker
 * actionable from anywhere: the strip renders in the persistent chrome, so a blocker
 * whose controls live elsewhere carries a button that switches to them. It is
 * **optional** because not every blocker has a control to offer — "nothing to push"
 * is resolved by editing the catalogue, not by anything in this dialog, and sending
 * someone to a tab that cannot help is worse than sending them nowhere.
 */
export type Blocker = {
  id: "validation" | "secrets" | "prBranch" | "identical";
  tab?: PublishTab;
  tone: "warning" | "danger";
  message: string;
};

/**
 * The fields the tabs edit — mostly the Branch tab's, plus `bumpVersion` from the Push
 * tab.
 *
 * One object rather than seven `useState` atoms: the shell owns them because it builds
 * the publish request, but every one of them was costing a state, a prop pair and a
 * destructure to add.
 */
export type PublishForm = {
  targetPath: string;
  branch: string;
  openPr: boolean;
  prTitle: string;
  prBody: string;
  draft: boolean;
  /**
   * Increment `[meta].version` in what is committed. **On by default here and off on
   * the wire** — the backend must not bump for a caller that says nothing, but the
   * moment a decoder goes to a repository other people pull from is exactly the moment
   * its revision number is easiest to forget.
   */
  bumpVersion: boolean;
};

export const EMPTY_PUBLISH_FORM: PublishForm = {
  targetPath: "",
  branch: "",
  openPr: false,
  prTitle: "",
  prBody: "",
  draft: false,
  bumpVersion: true,
};
