// ui/src/styles/buttonStyles.ts
// Buttons are <Button> and <IconButton> from src/components/Button.tsx, which
// render the `.btn` classes in styles/components.css. What remains here belongs
// to families that have not moved yet: the framing-option card, the data view
// tab, and the launcher tiles.

/**
 * Toggle card button for dark panels (e.g., framing options in dark dialogs)
 * @param isActive - Whether the toggle is currently active
 */
export function toggleCardClass(isActive: boolean): string {
  const base = "w-full text-left px-4 py-3 rounded border transition-colors";
  return isActive
    ? `${base} bg-blue-900/30 border-blue-600 text-white`
    : `${base} bg-[var(--bg-surface)] border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95`;
}

/**
 * Tab button for data views
 * @param isActive - Whether the tab is currently active
 * @param hasIndicator - Whether to show purple indicator (for tabs with new data)
 */
export function dataViewTabClass(isActive: boolean, hasIndicator = false): string {
  const base = "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors";
  if (isActive) {
    return `${base} text-blue-400 border-blue-400`;
  }
  if (hasIndicator) {
    return `${base} text-purple-400 border-transparent hover:text-purple-300`;
  }
  return `${base} text-[color:var(--text-secondary)] border-transparent hover:brightness-110`;
}

// =============================================================================
// Launcher Button Styles (for dashboard watermark)
// =============================================================================

/**
 * Launcher button - responsive square button for app launcher grid
 * Use for: Dashboard/watermark app launcher buttons
 * Compose with colour classes: e.g., `${launcherButton} bg-purple-500/10 hover:bg-purple-500/20`
 */
export const launcherButton =
  "flex flex-col items-center justify-center gap-1.5 min-w-16 w-20 aspect-square rounded-xl transition-colors";

/**
 * Launcher button label - small text below icon
 */
export const launcherButtonLabel =
  "text-xs text-[color:var(--text-secondary)] font-ubuntu truncate max-w-full px-1";

/**
 * Launcher grid container - responsive flex grid for launcher buttons
 */
export const launcherGrid =
  "flex flex-wrap justify-center gap-2 px-4";

/**
 * Disabled state styling for non-button controls (a <Button> gets it from `.btn`)
 */
export const disabledState = "disabled:opacity-50 disabled:cursor-not-allowed";
