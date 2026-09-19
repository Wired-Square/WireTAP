// ui/src/styles/cardStyles.ts
// Cards and alerts are <Card> and <Alert> from src/components, which render
// the `.card` and `.alert` classes in styles/components.css. What remains here
// belongs to the dialogs family: the action footer and the collapsible
// config-section header.

/**
 * Panel footer - for action button containers
 * Use for: Bottom section of dialogs/panels with action buttons
 */
export const panelFooter = "p-3 bg-[var(--bg-primary)] border-t border-[color:var(--border-default)]";

/**
 * Expandable row container - for collapsible config sections
 * Use for: Config dialog expandable section headers
 */
export const expandableRowContainer =
  "w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-surface)] hover:bg-[var(--hover-bg)] transition-colors";
