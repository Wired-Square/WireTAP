// ui/src/styles/buttonStyles.ts
// Centralized button styles for consistent appearance across the app
// Uses CSS variables for cross-platform dark mode support (Windows WebView).

/**
 * Base button with text - grey background, used for most toolbar buttons
 * Use for buttons that contain text and/or icons
 */
export const buttonBase =
  "flex items-center gap-1 px-2 py-1.5 text-sm rounded transition-all bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0";

/**
 * Icon-only button - grey background, centered icon
 * Use for buttons that contain only an icon (no text)
 */
export const iconButtonBase =
  "flex items-center justify-center px-2 py-1.5 rounded transition-all bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0";

/**
 * Danger/Stop button - red background, icon only
 * Use for stop/cancel actions
 */
export const dangerButtonBase =
  "flex items-center justify-center px-2 py-1.5 rounded transition-colors bg-red-600 hover:bg-red-700 text-white shrink-0";

/**
 * Warning/Detach button - amber background, icon only
 * Use for detach/disconnect actions
 */
export const warningButtonBase =
  "flex items-center justify-center px-2 py-1.5 rounded transition-colors bg-amber-600 hover:bg-amber-700 text-white shrink-0";

/**
 * Success icon button - green background, icon only (matches dangerButtonBase sizing)
 * Use for resume/play actions in toolbars
 */
export const successIconButton =
  "flex items-center justify-center px-2 py-1.5 rounded transition-colors bg-green-600 hover:bg-green-700 text-white shrink-0";

/**
 * Toggle button helper - returns appropriate classes based on active state
 * @param isActive - Whether the toggle is currently active
 * @param activeColor - The color when active (default: purple)
 */
export function toggleButtonClass(isActive: boolean, activeColor: "purple" | "yellow" | "blue" = "purple"): string {
  const baseClasses = "flex items-center justify-center px-2 py-1.5 rounded transition-all shrink-0";

  if (isActive) {
    const colorMap = {
      purple: "bg-purple-600 hover:bg-purple-700 text-white",
      yellow: "bg-yellow-600 hover:bg-yellow-500 text-white",
      blue: "bg-blue-600 hover:bg-blue-700 text-white",
    };
    return `${baseClasses} ${colorMap[activeColor]}`;
  }

  return `${baseClasses} bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:brightness-95`;
}

/**
 * Play/Resume button - green background
 * Use for: Start/Resume playback actions
 */
export const playButtonBase =
  "flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors bg-green-600 text-white hover:bg-green-700 disabled:bg-[var(--bg-surface)] disabled:text-[color:var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Pause button - yellow/amber background
 * Use for: Pause playback actions
 */
export const pauseButtonBase =
  "flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors bg-yellow-500 text-white hover:bg-yellow-600";

/**
 * Stop button - red background
 * Use for: Stop/Cancel playback actions
 */
export const stopButtonBase =
  "flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors bg-red-600 text-white hover:bg-red-700 disabled:bg-[var(--bg-surface)] disabled:text-[color:var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Compact play button - smaller padding for compact layouts
 */
export const playButtonCompact =
  "flex items-center gap-2 px-2 py-1 rounded-lg transition-colors bg-green-600 text-white hover:bg-green-700 disabled:bg-[var(--bg-surface)] disabled:text-[color:var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Compact pause button - smaller padding for compact layouts
 */
export const pauseButtonCompact =
  "flex items-center gap-2 px-2 py-1 rounded-lg transition-colors bg-yellow-500 text-white hover:bg-yellow-600";

/**
 * Compact stop button - smaller padding for compact layouts
 */
export const stopButtonCompact =
  "flex items-center gap-2 px-2 py-1 rounded-lg transition-colors bg-red-600 text-white hover:bg-red-700 disabled:bg-[var(--bg-surface)] disabled:text-[color:var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Primary action button - blue background
 * Use for: Primary actions in dialogs (Import, Watch, OK)
 */
export const primaryButtonBase =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-colors bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed";

/**
 * Success action button - green background
 * Use for: Positive actions (Ingest, Confirm)
 */
export const successButtonBase =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-lg transition-colors bg-green-600 text-white hover:bg-green-700";

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
 * Toggle chip button for light/dark mode panels
 * @param isActive - Whether the toggle is currently active
 */
export function toggleChipClass(isActive: boolean): string {
  const base = "px-3 py-1.5 text-xs rounded border transition-all";
  return isActive
    ? `${base} bg-blue-600/20 border-blue-500 text-blue-600`
    : `${base} bg-[var(--bg-primary)] border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95`;
}

/**
 * Selection button for dialog options (teal-themed)
 * @param isActive - Whether the option is currently selected
 */
export function selectionButtonClass(isActive: boolean): string {
  const base = "px-3 py-2 rounded border text-sm font-medium transition-all";
  return isActive
    ? `${base} border-teal-500 bg-teal-600/20 text-teal-600`
    : `${base} border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:border-teal-400`;
}

/**
 * Group selection button with ring indicator
 * @param isActive - Whether the option is currently selected
 */
export function groupButtonClass(isActive: boolean): string {
  const base = "flex items-center justify-center px-2 py-1.5 text-sm rounded transition-all shrink-0";
  return isActive
    ? `${base} bg-[var(--bg-surface)] text-[color:var(--text-primary)] ring-2 ring-blue-500 ring-offset-1`
    : `${base} bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:brightness-95`;
}

// =============================================================================
// Dark Data View Styles (for Discovery, Decoder data tables)
// =============================================================================

/**
 * Pagination button - themed for data views
 */
export const paginationButtonDark =
  "p-1 rounded text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-30 disabled:cursor-not-allowed";

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

/**
 * Get badge color classes for protocol badges (dark theme)
 * @param color - Badge color variant
 */
export function badgeColorClass(color: 'green' | 'blue' | 'purple' | 'gray' | 'amber' | 'cyan'): string {
  const colorMap = {
    green: 'bg-green-600/30 text-green-400',
    blue: 'bg-blue-600/30 text-blue-400',
    purple: 'bg-purple-600/30 text-purple-400',
    gray: 'bg-gray-600/30 text-gray-400',
    amber: 'bg-amber-600/30 text-amber-400',
    cyan: 'bg-cyan-600/30 text-cyan-400',
  };
  return colorMap[color];
}

/**
 * Get count color class for tab counts
 */
export function tabCountColorClass(color: 'green' | 'purple' | 'gray' | 'orange'): string {
  const colorMap = {
    green: 'text-green-500',
    purple: 'text-purple-500',
    gray: 'text-gray-500',
    orange: 'text-orange-500',
  };
  return colorMap[color];
}

/**
 * Small icon button for tables - bookmark, calculator buttons
 */
export const tableIconButtonDark =
  "p-0.5 rounded hover:bg-[var(--hover-bg)] transition-colors";

// =============================================================================
// Icon Button Hover Styles (for toolbar/card action buttons)
// =============================================================================

/**
 * Icon button with hover - light theme
 * Use for edit/action buttons in cards and dialogs
 */
export const iconButtonHover =
  "p-2 rounded-lg transition-all hover:brightness-90 hover:bg-[var(--bg-surface)]";

/**
 * Icon button with danger hover - for delete actions
 * Uses CSS variables for cross-platform dark mode support
 */
export const iconButtonHoverDanger =
  "p-2 hover:bg-[var(--status-danger-bg)] rounded-lg transition-colors";

/**
 * Icon button with persistent danger colour + danger hover — always-red delete icon
 */
export const iconButtonDanger =
  "p-2 text-[color:var(--status-danger-text)] hover:bg-[var(--status-danger-bg)] rounded-lg transition-colors";

/**
 * Compact icon button with persistent danger colour — for close/dismiss in headers
 */
export const iconButtonDangerCompact =
  "p-1 text-[color:var(--status-danger-text)] hover:bg-[var(--status-danger-bg)] rounded transition-colors";

/**
 * Compact icon button with hover - for tight layouts (star buttons, inline actions)
 */
export const iconButtonHoverCompact =
  "p-1 rounded transition-all hover:brightness-90 hover:bg-[var(--bg-surface)]";

/**
 * Small icon button with hover - p-1.5 variant for intermediate sizing
 */
export const iconButtonHoverSmall =
  "p-1.5 rounded transition-all hover:brightness-90 hover:bg-[var(--bg-surface)]";

/**
 * Secondary button - gray background for cancel/reset actions
 * Use for: Dialog cancel buttons, reset buttons, secondary actions
 */
export const secondaryButton =
  "px-6 py-2 bg-[var(--bg-surface)] text-[color:var(--text-secondary)] rounded-lg hover:brightness-95 transition-all";

/**
 * Folder picker button - for directory browse buttons
 * Use for: Directory/file picker buttons in settings
 */
export const folderPickerButton =
  "px-4 py-2 bg-[var(--bg-surface)] rounded-lg hover:brightness-95 transition-all";

/**
 * Dialog option button - for multi-choice dialog buttons
 * Use for: Option buttons in picker dialogs
 */
export const dialogOptionButton =
  "flex items-center justify-center gap-2 flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:brightness-95 transition-all";

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

// =============================================================================
// State Utilities
// =============================================================================

/**
 * Disabled state styling
 * Use as a composable utility with other button styles
 */
export const disabledState = "disabled:opacity-50 disabled:cursor-not-allowed";
