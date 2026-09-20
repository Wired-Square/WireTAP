// ui/src/styles/spacing.ts
//
// Centralised spacing constants for consistent layout.

// =============================================================================
// App chrome
// =============================================================================

/** Horizontal padding for app-level bars (top bar, logo menu) */
export const paddingAppBarX = "px-4";

/** App content margin — bubble effect around panels and menu items */
export const marginAppContent = "m-2";

/** Default radius (cards, dialogs) */
export const roundedDefault = "rounded-lg";

/** Titled-section divider — top border + top padding separating settings sections */
export const sectionDivider = "pt-4 border-t border-default";

// =============================================================================
// Gaps and vertical spacing
// =============================================================================

/** Small gap (button groups, form rows) */
export const gapSmall = "gap-2";

/** Default gap (card content, lists) */
export const gapDefault = "gap-4";

/** Tight vertical spacing */
export const spaceYTight = "space-y-1";

/** Small vertical spacing */
export const spaceYSmall = "space-y-2";

/** Default vertical spacing */
export const spaceYDefault = "space-y-4";

/** Large vertical spacing */
export const spaceYLarge = "space-y-6";

// =============================================================================
// Icon Sizes
// =============================================================================

/** Extra small icon (inline compact indicators, checksum marks, tab close) */
export const iconXs = "w-3 h-3";

/** Small icon (toolbar buttons, session controls) */
export const iconSm = "w-3.5 h-3.5";

/** Medium/default icon (standard buttons, general purpose) */
export const iconMd = "w-4 h-4";

/** Large icon (app identity in top bars, dialog close buttons) */
export const iconLg = "w-5 h-5";

/** Extra large icon (alert dialogs, loading spinners) */
export const iconXl = "w-6 h-6";

/** Jumbo icon (launcher icons, large decorative elements) */
export const icon2xl = "w-8 h-8";

// =============================================================================
// Flex Row Layouts
// =============================================================================

/** Flex row with small gap (most common) */
export const flexRowGap2 = "flex items-center gap-2";

/** Flex row with default gap */
export const flexRowGap3 = "flex items-center gap-3";
