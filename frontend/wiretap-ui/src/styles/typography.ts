// ui/src/styles/typography.ts
//
// Centralised typography styles for consistent text presentation.

// =============================================================================
// Headings
// =============================================================================

/** Page title (h1) */
export const h1 = "text-2xl font-bold text-primary";

/** Section title (h2) */
export const h2 = "text-xl font-semibold text-primary";

/** Subsection title (h3) */
export const h3 = "text-lg font-semibold text-primary";

/** Card/dialog title (h4) */
export const h4 = "text-base font-medium text-primary";

// =============================================================================
// Body Text
// =============================================================================

/** Default body text */
export const bodyDefault = "text-sm text-secondary";

/** Small body text */
export const bodySmall = "text-xs text-secondary";

// =============================================================================
// Utility Text
// =============================================================================

/** Monospace/code text */
export const mono = "font-mono text-sm";

/** Caption text */
export const caption = "text-xs text-secondary";

/** Emphasized text */
export const emphasis = "font-medium text-primary";

// =============================================================================
// Truncation Helpers
// =============================================================================

/** Single line truncation */
export const truncate = "truncate";

// =============================================================================
// Extended Utility Text
// =============================================================================

/** Monospace body text with full colours */
export const monoBody = "font-mono text-sm text-primary";

/** Small label base - muted colour, no margin */
export const labelSmall = "text-xs font-medium text-secondary";

/** Small label with muted colour and bottom margin (for form field labels) */
export const labelSmallMuted = `${labelSmall} mb-1`;

/** Section header - uppercase, tracking, with background */
export const sectionHeader = `${labelSmall} uppercase tracking-wide`;

/** Medium weight text - for list item titles, inline labels */
export const textMedium = "text-sm font-medium text-primary";

/** Muted caption - inverted muted colours for secondary info */
export const captionMuted = "text-xs text-secondary opacity-70";

/** Section header text - for panel/section headings */
export const sectionHeaderText = "text-sm font-medium text-secondary";

// =============================================================================
// Form labels and help text
// =============================================================================

/** Block label above a form control */
export const labelDefault = "block text-sm font-medium text-primary mb-2";

/** Inline label beside a control in a compact form */
export const labelSimple = "text-sm text-secondary";

/** Description under a control */
export const helpText = "text-xs text-secondary";

/** Label above a field in the Discovery tool option panels */
export const toolPanelLabel = "text-muted";

// =============================================================================
// Empty State Text (for "Not connected", "No data", etc.)
// =============================================================================
// These provide consistent styling for empty/placeholder states across apps.

/** Empty state container - centres content vertically and horizontally */
export const emptyStateContainer = "flex-1 flex flex-col items-center justify-center gap-4 p-8";

/** Empty state text wrapper - applies muted colour, centering, and resets font */
export const emptyStateText = "text-sm font-sans text-muted text-center";

/** Empty state heading - medium weight */
export const emptyStateHeading = "text-sm font-medium";

/** Empty state description - smaller, with top margin */
export const emptyStateDescription = "text-xs mt-2";

/** Empty state hint - extra small, for additional context (inherits colour from emptyStateText) */
export const emptyStateHint = "text-xs mt-1 opacity-60";
