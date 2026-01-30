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

// ============================================================================
// Dark Panel Badges - for use in permanently dark panels (e.g., decoder view)
// These use transparent backgrounds that work well on dark backgrounds
// ============================================================================

/**
 * Base for dark panel badges - monospace font, smaller padding
 */
export const badgeDarkPanelBase = "text-xs font-mono px-1.5 py-0.5 rounded flex items-center gap-1";

/**
 * Dark panel info badge - blue, for source addresses
 */
export const badgeDarkPanelInfo = `${badgeDarkPanelBase} bg-blue-600/30 text-blue-400`;

/**
 * Dark panel success badge - green, for valid checksums
 */
export const badgeDarkPanelSuccess = `${badgeDarkPanelBase} bg-green-600/30 text-green-400`;

/**
 * Dark panel danger badge - red, for invalid checksums
 */
export const badgeDarkPanelDanger = `${badgeDarkPanelBase} bg-red-600/30 text-red-400`;

/**
 * Dark panel purple badge - purple, for custom header fields
 */
export const badgeDarkPanelPurple = `${badgeDarkPanelBase} bg-purple-600/30 text-purple-400`;

// ============================================================================
// Metadata Badges - for filenames, types, and metadata display
// ============================================================================

/**
 * Metadata badge - muted gray, for displaying filenames/types - uses CSS variable
 */
export const badgeMetadata = "px-2 py-1 text-xs font-medium bg-[var(--bg-surface)] text-[color:var(--text-secondary)] rounded";
