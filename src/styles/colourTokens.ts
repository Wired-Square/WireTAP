// ui/src/styles/colourTokens.ts
//
// Centralised colour tokens for consistent palette across the app.
// Core colours use CSS variables (set by useTheme) for user customisation.
// Status and accent colours use Tailwind classes for simplicity.

// =============================================================================
// CSS Variable-based Colours (User Customisable)
// =============================================================================
// These use Tailwind arbitrary value syntax to reference CSS variables.
// The variables are set by useTheme based on user settings.

/** Primary surface (main app background) - uses CSS variable */
export const bgPrimary = "bg-[var(--bg-primary)]";

/** Surface background (dialogs, panels, elevated cards) - uses CSS variable */
export const bgSurface = "bg-[var(--bg-surface)]";

/** Primary text (headings, main content) - uses CSS variable */
export const textPrimary = "text-[color:var(--text-primary)]";

/** Secondary text (descriptions, labels) - uses CSS variable */
export const textSecondary = "text-[color:var(--text-secondary)]";

/** Default border - uses CSS variable */
export const borderDefault = "border-[color:var(--border-default)]";

/** Data view background - uses CSS variable */
export const bgDataView = "bg-[var(--data-bg)]";

/** Data view primary text - uses CSS variable */
export const textDataPrimary = "text-[color:var(--data-text-primary)]";

// =============================================================================
// Secondary Semantic Colours (CSS variable-based for Windows compatibility)
// =============================================================================

/** Secondary surface (cards, panels) - uses CSS variable */
export const bgSecondary = "bg-[var(--bg-surface)]";

/** Tertiary surface (inputs, nested elements) - uses CSS variable with opacity */
export const bgTertiary = "bg-[var(--bg-surface)]";

/** Muted background (disabled, inactive) - uses CSS variable */
export const bgMuted = "bg-[var(--bg-surface)]";

/** Tertiary text (hints, help text) - uses secondary with reduced opacity */
export const textTertiary = "text-[color:var(--text-secondary)]";

/** Muted text (disabled, placeholder) - uses CSS variable */
export const textMuted = "text-[color:var(--text-muted)]";

/** Strong border (focus, emphasis) - uses CSS variable */
export const borderStrong = "border-[color:var(--border-default)]";

/** Subtle border (dividers) - uses CSS variable with opacity */
export const borderSubtle = "border-[color:var(--border-default)] opacity-50";

/** Bottom border divider (for section separators) - uses CSS variable */
export const borderDivider = "border-b border-[color:var(--border-default)]";

// =============================================================================
// Status Colors (backgrounds) - CSS variable based for Windows compatibility
// =============================================================================

/** Success background */
export const bgSuccess = "bg-[var(--status-success-bg)]";

/** Danger/error background */
export const bgDanger = "bg-[var(--status-danger-bg)]";

/** Warning background */
export const bgWarning = "bg-[var(--status-warning-bg)]";

/** Info background */
export const bgInfo = "bg-[var(--status-info-bg)]";

// =============================================================================
// Status Colors (text) - CSS variable based for Windows compatibility
// =============================================================================

/** Success text */
export const textSuccess = "text-[color:var(--status-success-text)]";

/** Danger/error text */
export const textDanger = "text-[color:var(--status-danger-text)]";

/** Warning text */
export const textWarning = "text-[color:var(--status-warning-text)]";

/** Info text */
export const textInfo = "text-[color:var(--status-info-text)]";

// =============================================================================
// Status Colors (borders) - CSS variable based for Windows compatibility
// =============================================================================

/** Success border */
export const borderSuccess = "border-[color:var(--status-success-border)]";

/** Danger/error border */
export const borderDanger = "border-[color:var(--status-danger-border)]";

/** Warning border */
export const borderWarning = "border-[color:var(--status-warning-border)]";

/** Info border */
export const borderInfo = "border-[color:var(--status-info-border)]";

// =============================================================================
// Interactive Colors - Use CSS variables for accent
// =============================================================================

/** Primary action background (buttons) - uses CSS variable */
export const bgInteractive = "bg-[var(--accent-primary)] hover:brightness-110";

/** Primary action text - uses CSS variable */
export const textInteractive = "text-[color:var(--accent-primary)] hover:brightness-110";

/** Focus ring */
export const focusRing = "focus:ring-2 focus:ring-blue-500 focus:outline-none";

// =============================================================================
// Data View Colors (CSS variable-based for Windows compatibility)
// =============================================================================

/** Data view toolbar background - uses CSS variable */
export const bgDataToolbar = "bg-[var(--bg-surface)]";

/** Data view border - uses CSS variable */
export const borderDataView = "border-[color:var(--border-default)]";

/** Data view input background - uses CSS variable */
export const bgDataInput = "bg-[var(--bg-primary)]";

/** Data view secondary text - uses CSS variable */
export const textDataSecondary = "text-[color:var(--text-secondary)]";

/** Data view tertiary text - uses CSS variable with opacity */
export const textDataTertiary = "text-[color:var(--text-secondary)] opacity-80";

/** Data view muted/decorative text - uses CSS variable with opacity */
export const textDataMuted = "text-[color:var(--text-secondary)] opacity-60";

/** Data view placeholder text - uses CSS variable with opacity */
export const textDataPlaceholder = "text-[color:var(--text-secondary)] opacity-60 italic";

// =============================================================================
// Hover States - use brightness filter for cross-platform support
// =============================================================================

/** Light hover (for light backgrounds) */
export const hoverLight = "hover:brightness-95";

/** Subtle hover (for secondary surfaces) */
export const hoverSubtle = "hover:brightness-90";

/** Data view item hover */
export const hoverDataItem = "hover:brightness-95";

/** Data view row hover */
export const hoverDataRow = "hover:brightness-95";

// =============================================================================
// Hover States - CSS variable based for Windows compatibility
// =============================================================================

/** Hover background - uses CSS variable */
export const hoverBg = "hover:bg-[var(--hover-bg)]";

// =============================================================================
// Data Accent Colors (for table cells, syntax highlighting)
// =============================================================================
// These use CSS variables for Windows WebView compatibility.

export const textDataGreen = "text-[color:var(--text-green)]";
export const textDataYellow = "text-[color:var(--text-yellow)]";
export const textDataOrange = "text-[color:var(--text-orange)]";
export const textDataPurple = "text-[color:var(--text-purple)]";
export const textDataAmber = "text-[color:var(--text-amber)]";
export const textDataCyan = "text-[color:var(--text-cyan)]";

// =============================================================================
// Legacy Aliases (for backward compatibility during migration)
// =============================================================================
// These will be removed once all components are migrated.

/** @deprecated Use bgDataView instead */
export const bgDarkView = bgDataView;

/** @deprecated Use bgDataToolbar instead */
export const bgDarkToolbar = bgDataToolbar;

/** @deprecated Use borderDataView instead */
export const borderDarkView = borderDataView;

/** @deprecated Use bgDataInput instead */
export const bgDarkInput = bgDataInput;

/** @deprecated Use textDataPrimary instead */
export const textDarkInput = textDataPrimary;

/** @deprecated Use textDataSecondary instead */
export const textDarkMuted = textDataSecondary;

/** @deprecated Use textDataTertiary instead */
export const textDarkSubtle = textDataTertiary;

/** @deprecated Use textDataMuted instead */
export const textDarkDecorative = textDataMuted;

/** @deprecated Use textDataPlaceholder instead */
export const textDarkPlaceholder = textDataPlaceholder;

/** @deprecated Use hoverDataItem instead */
export const hoverDark = hoverDataItem;

/** @deprecated Use hoverDataRow instead */
export const hoverDarkRow = hoverDataRow;

// Legacy toolbar tokens (consolidated)
/** @deprecated Use bgDataToolbar instead */
export const bgToolbar = bgDataToolbar;

/** @deprecated Use textSecondary instead */
export const textToolbar = textSecondary;

/** @deprecated Use borderStrong instead */
export const borderToolbar = borderStrong;

/** @deprecated Use bgTertiary instead */
export const bgToolbarInput = bgTertiary;
