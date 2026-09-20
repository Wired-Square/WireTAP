// ui/src/styles/colourTokens.ts
//
// Named colour utilities. Each class reads a theme variable from WireTAP.css —
// `text-muted` is `--text-muted`, `bg-info` is `--status-info-bg` — so one
// variable change re-themes every use; docs/style_guide.md § Theming model
// has the naming rule.

// =============================================================================
// Surfaces, text and borders
// =============================================================================

/** Primary surface (main app background) */
export const bgPrimary = "bg-primary";

/** Surface background (dialogs, panels, elevated cards) */
export const bgSurface = "bg-surface";

/** Data view background */
export const bgDataView = "bg-data";

/** Primary text (headings, main content) */
export const textPrimary = "text-primary";

/** Secondary text (descriptions, labels) */
export const textSecondary = "text-secondary";

/** Muted text (disabled, placeholder) */
export const textMuted = "text-muted";

/** Data view primary text */
export const textDataPrimary = "text-data-primary";

/** Default border */
export const borderDefault = "border-default";

/** Bottom border divider (for section separators) */
export const borderDivider = "border-b border-default";

/** Data view outer container - rounded with border (the standard "bubble" look) */
export const dataViewContainer = "rounded-lg border border-default overflow-hidden";

// =============================================================================
// Status tints
// =============================================================================

export const bgSuccess = "bg-success";
export const bgDanger = "bg-danger";
export const bgInfo = "bg-info";

export const textSuccess = "text-success";
export const textDanger = "text-danger";
export const textWarning = "text-warning";
export const textInfo = "text-info";

export const borderSuccess = "border-success";
export const borderDanger = "border-danger";

// =============================================================================
// Data view text at reduced emphasis
// =============================================================================

/** Data view tertiary text */
export const textDataTertiary = "text-secondary opacity-80";

/** Data view muted/decorative text */
export const textDataMuted = "text-secondary opacity-60";

/** Disabled/inactive data text — pair with a themed accent for active state */
export const textDataDisabled = "text-muted opacity-50";

// =============================================================================
// Hover states
// =============================================================================

/** Brightness hover, for a surface whose fill is not the hover colour */
export const hoverLight = "hover:brightness-95";

/** Hover background */
export const hoverBg = "hover:bg-hover";

// =============================================================================
// Data accents (for table cells, syntax highlighting)
// =============================================================================

export const textDataGreen = "text-green";
export const textDataYellow = "text-yellow";
export const textDataOrange = "text-orange";
export const textDataPurple = "text-purple";
export const textDataAmber = "text-amber";
export const textDataCyan = "text-cyan";
