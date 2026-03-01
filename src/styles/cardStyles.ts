// ui/src/styles/cardStyles.ts
// Centralized card, panel, and container styles
//
// NOTE: Cards use CSS variables for backgrounds to work correctly on Windows WebView
// where Tailwind dark: variants in string constants don't get generated.

/**
 * Card base - common border and rounding
 */
export const cardBase = "rounded-lg border";

/**
 * Default card - subtle background for content sections
 * Use for: Content panels, form sections
 * Uses CSS variables for cross-platform dark mode support
 */
export const cardDefault = `${cardBase} bg-[var(--bg-surface)] border-[color:var(--border-default)]`;

/**
 * Elevated card - white background with subtle shadow
 * Use for: Floating panels, prominent content
 * Uses CSS variables for cross-platform dark mode support
 */
export const cardElevated = `${cardBase} bg-[var(--bg-surface)] border-[color:var(--border-default)] shadow-sm`;

/**
 * Interactive card - hover state for clickable cards
 * Use for: List items, selectable cards
 * Uses CSS variables for cross-platform dark mode support
 */
export const cardInteractive = `${cardBase} bg-[var(--bg-surface)] border-[color:var(--border-default)] hover:brightness-95 transition-all`;

/**
 * Alert base - common alert box styles
 */
export const alertBase = "rounded-lg p-4 border";

/**
 * Info alert - blue, for informational messages
 * Uses CSS variables for cross-platform dark mode support
 */
export const alertInfo = `${alertBase} bg-[var(--status-info-bg)] border-[color:var(--status-info-border)]`;

/**
 * Warning alert - amber, for warning messages
 * Uses CSS variables for cross-platform dark mode support
 */
export const alertWarning = `${alertBase} bg-[var(--status-warning-bg)] border-[color:var(--status-warning-border)]`;

/**
 * Danger alert - red, for error messages
 * Uses CSS variables for cross-platform dark mode support
 */
export const alertDanger = `${alertBase} bg-[var(--status-danger-bg)] border-[color:var(--status-danger-border)]`;

/**
 * Success alert - green, for success messages
 * Uses CSS variables for cross-platform dark mode support
 */
export const alertSuccess = `${alertBase} bg-[var(--status-success-bg)] border-[color:var(--status-success-border)]`;

/**
 * Detail box - for technical details, code blocks
 * Use for: Error details, code previews
 * Uses CSS variables for cross-platform dark mode support
 */
export const detailBox = "bg-[var(--bg-surface)] rounded-lg p-4 border border-[color:var(--border-default)]";

/**
 * Padding sizes for cards
 */
export const cardPadding = {
  none: "",
  sm: "p-2",
  md: "p-4",
  lg: "p-6",
};

/**
 * Compact error box - red, small text
 * Use for: Inline error messages in forms/dialogs
 * Note: Uses fixed colours for semantic meaning (errors should always be red)
 */
export const errorBoxCompact = "p-2 text-xs text-red-600 bg-red-50 rounded";

/**
 * Panel footer - for action button containers
 * Use for: Bottom section of dialogs/panels with action buttons
 * Uses CSS variables for cross-platform dark mode support
 */
export const panelFooter = "p-3 bg-[var(--bg-primary)] border-t border-[color:var(--border-default)]";

/**
 * Expandable row container - for collapsible config sections
 * Use for: Config dialog expandable section headers
 * Uses CSS variables for cross-platform dark mode support
 */
export const expandableRowContainer =
  "w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-surface)] hover:brightness-95 transition-all";

/**
 * Selectable option box - for radio/checkbox option containers
 * Use for: Export dialogs with radio button options
 * Uses CSS variables for cross-platform dark mode support
 */
export const selectableOptionBox =
  "flex items-start gap-3 p-3 rounded-lg border border-[color:var(--border-default)] hover:brightness-95 transition-all";
