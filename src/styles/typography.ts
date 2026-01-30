// ui/src/styles/typography.ts
//
// Centralized typography styles for consistent text presentation.
// Uses CSS variables for cross-platform dark mode support (Windows WebView).

// =============================================================================
// Headings - use CSS variables for text colour
// =============================================================================

/** Page title (h1) */
export const h1 = "text-2xl font-bold text-[color:var(--text-primary)]";

/** Section title (h2) */
export const h2 = "text-xl font-semibold text-[color:var(--text-primary)]";

/** Subsection title (h3) */
export const h3 = "text-lg font-semibold text-[color:var(--text-primary)]";

/** Card/dialog title (h4) */
export const h4 = "text-base font-medium text-[color:var(--text-primary)]";

// =============================================================================
// Body Text - use CSS variables for text colour
// =============================================================================

/** Default body text */
export const bodyDefault = "text-sm text-[color:var(--text-secondary)]";

/** Large body text */
export const bodyLarge = "text-base text-[color:var(--text-secondary)]";

/** Small body text */
export const bodySmall = "text-xs text-[color:var(--text-secondary)]";

// =============================================================================
// Utility Text
// =============================================================================

/** Monospace/code text */
export const mono = "font-mono text-sm";

/** Caption text */
export const caption = "text-xs text-[color:var(--text-secondary)]";

/** Emphasized text */
export const emphasis = "font-medium text-[color:var(--text-primary)]";

// =============================================================================
// Truncation Helpers
// =============================================================================

/** Single line truncation */
export const truncate = "truncate";

/** Multi-line clamp (2 lines) */
export const lineClamp2 = "line-clamp-2";

/** Multi-line clamp (3 lines) */
export const lineClamp3 = "line-clamp-3";

// =============================================================================
// Extended Utility Text - use CSS variables for text colour
// =============================================================================

/** Monospace body text with full colours */
export const monoBody = "font-mono text-sm text-[color:var(--text-primary)]";

/** Small label base - muted colour, no margin */
export const labelSmall = "text-xs font-medium text-[color:var(--text-secondary)]";

/** Small label with muted colour and bottom margin (for form field labels) */
export const labelSmallMuted = `${labelSmall} mb-1`;

/** Section header - uppercase, tracking, with background */
export const sectionHeader = `${labelSmall} uppercase tracking-wide`;

/** Medium weight text - for list item titles, inline labels */
export const textMedium = "text-sm font-medium text-[color:var(--text-primary)]";

/** Muted caption - inverted muted colours for secondary info */
export const captionMuted = "text-xs text-[color:var(--text-secondary)] opacity-70";

/** Section header text - for panel/section headings */
export const sectionHeaderText = "text-sm font-medium text-[color:var(--text-secondary)]";

// =============================================================================
// Empty State Text (for "Not connected", "No data", etc.)
// =============================================================================
// These provide consistent styling for empty/placeholder states across apps.

/** Empty state container - centres content vertically and horizontally */
export const emptyStateContainer = "flex-1 flex flex-col items-center justify-center gap-4 p-8";

/** Empty state text wrapper - applies muted colour and centering */
export const emptyStateText = "text-[color:var(--text-secondary)] text-center";

/** Empty state heading - larger, medium weight */
export const emptyStateHeading = "text-lg font-medium";

/** Empty state description - smaller, with top margin */
export const emptyStateDescription = "text-sm mt-2";

/** Empty state hint - extra small, for additional context */
export const emptyStateHint = "text-xs mt-1 text-[color:var(--text-secondary)] opacity-60";
