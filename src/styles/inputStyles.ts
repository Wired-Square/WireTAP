// ui/src/styles/inputStyles.ts
// Centralized input and form field styles for consistent appearance across the app
// Uses CSS variables for cross-platform dark mode support (Windows WebView).

/**
 * Base input styles - common to all input variants
 */
export const inputBase = "w-full border transition-colors text-[color:var(--text-primary)]";

/**
 * Default input style - full styling with focus ring
 * Use for: Settings, IOProfile dialogs, main forms
 */
export const inputDefault = `${inputBase} px-4 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`;

/**
 * Simple input style - minimal styling
 * Use for: SaveFrames dialogs, compact forms
 */
export const inputSimple = `${inputBase} px-3 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:outline-none focus:ring-2 focus:ring-blue-500`;

/**
 * Toolbar select - dark theme for data view bars
 * Use for: Pagination toolbars, data view controls
 */
export const toolbarSelect = "text-xs px-2 py-1 rounded border border-[color:var(--border-default)] bg-[var(--bg-surface)] text-[color:var(--text-secondary)] focus:outline-none";

/**
 * Default label style - block layout with medium font
 * Use for: Settings forms, main dialogs
 */
export const labelDefault = "block text-sm font-medium text-[color:var(--text-primary)] mb-2";

/**
 * Simple label style - inline with smaller text
 * Use for: Compact forms, simple dialogs
 */
export const labelSimple = "text-sm text-[color:var(--text-secondary)]";

/**
 * Help text style - description text below inputs
 */
export const helpText = "text-xs text-[color:var(--text-secondary)]";

/**
 * Select base style - matches input default
 */
export const selectDefault = `${inputBase} px-4 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500`;

/**
 * Select simple style - matches input simple
 */
export const selectSimple = `${inputBase} px-3 py-2 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:outline-none focus:ring-2 focus:ring-blue-500`;
