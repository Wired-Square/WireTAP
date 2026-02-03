// ui/src/styles/badgeStyles.ts
// Centralized badge and status indicator styles
// Semantic badges use fixed colors; neutral badges use CSS variables.

/**
 * Badge base - common styles for all badge variants
 */
export const badgeBase = "inline-flex items-center px-2 py-1 rounded text-xs font-medium";

/**
 * Success badge - green, for completed/active states
 */
export const badgeSuccess = `${badgeBase} bg-green-600/20 text-green-600`;

/**
 * Danger badge - red, for errors/critical states
 */
export const badgeDanger = `${badgeBase} bg-red-600/20 text-red-600`;

/**
 * Warning badge - amber, for warnings/caution states
 */
export const badgeWarning = `${badgeBase} bg-amber-600/20 text-amber-600`;

/**
 * Info badge - blue, for informational states
 */
export const badgeInfo = `${badgeBase} bg-blue-600/20 text-blue-600`;

/**
 * Neutral badge - gray, for default/inactive states - uses CSS variable
 */
export const badgeNeutral = `${badgeBase} bg-[var(--bg-surface)] text-[color:var(--text-secondary)]`;

/**
 * Purple badge - purple, for special/highlighted states
 */
export const badgePurple = `${badgeBase} bg-purple-600/20 text-purple-600`;

// ============================================================================
// Small Badges - compact versions for tight UI spaces (e.g., reader lists)
// ============================================================================

/**
 * Small badge base - more compact padding
 */
export const badgeSmallBase = "px-1.5 py-0.5 rounded text-[10px] font-medium";

/**
 * Small neutral badge - gray - uses CSS variable
 */
export const badgeSmallNeutral = `${badgeSmallBase} bg-[var(--bg-surface)] text-[color:var(--text-secondary)]`;

/**
 * Small success badge - green
 */
export const badgeSmallSuccess = `${badgeSmallBase} bg-green-600/20 text-green-600`;

/**
 * Small warning badge - amber
 */
export const badgeSmallWarning = `${badgeSmallBase} bg-amber-600/20 text-amber-600`;

/**
 * Small purple badge - purple
 */
export const badgeSmallPurple = `${badgeSmallBase} bg-purple-600/20 text-purple-600`;

/**
 * Small info badge - blue, for active/override states
 */
export const badgeSmallInfo = `${badgeSmallBase} bg-blue-600/20 text-blue-600`;

/**
 * Small danger badge - red, for errors/critical states
 */
export const badgeSmallDanger = `${badgeSmallBase} bg-red-600/20 text-red-600`;

// ============================================================================
// Data Panel Badges - for use in data views (e.g., decoder view)
// These use CSS variables for proper light/dark theme support on Windows.
// Note: Named "DarkPanel" for historical reasons but now theme-aware.
// ============================================================================

/**
 * Base for data panel badges - monospace font, smaller padding
 */
export const badgeDarkPanelBase = "text-xs font-mono px-1.5 py-0.5 rounded flex items-center gap-1";

/**
 * Data panel info badge - blue, for source addresses
 */
export const badgeDarkPanelInfo = `${badgeDarkPanelBase} bg-[var(--status-info-bg)] text-[color:var(--status-info-text)]`;

/**
 * Data panel success badge - green, for valid checksums
 */
export const badgeDarkPanelSuccess = `${badgeDarkPanelBase} bg-[var(--status-success-bg)] text-[color:var(--status-success-text)]`;

/**
 * Data panel danger badge - red, for invalid checksums
 */
export const badgeDarkPanelDanger = `${badgeDarkPanelBase} bg-[var(--status-danger-bg)] text-[color:var(--status-danger-text)]`;

/**
 * Data panel purple badge - purple, for custom header fields
 */
export const badgeDarkPanelPurple = `${badgeDarkPanelBase} bg-[var(--status-purple-bg)] text-[color:var(--status-purple-text)]`;

/**
 * Data panel cyan badge - cyan, for mirror frame indicators
 */
export const badgeDarkPanelCyan = `${badgeDarkPanelBase} bg-[var(--status-cyan-bg)] text-[color:var(--status-cyan-text)]`;

// ============================================================================
// Metadata Badges - for filenames, types, and metadata display
// ============================================================================

/**
 * Metadata badge - muted gray, for displaying filenames/types - uses CSS variable
 */
export const badgeMetadata = "px-2 py-1 text-xs font-medium bg-[var(--bg-surface)] text-[color:var(--text-secondary)] rounded";
