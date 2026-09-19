// ui/src/styles/buttonStyles.ts
// Buttons are <Button> and <IconButton> from src/components/Button.tsx, which
// render the `.btn` classes in styles/components.css. What remains here is the
// launcher tiles, which the app-hues family owns.

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
