// ui/src/styles/menuStyles.ts
// Centralised styles for click-to-open dropdown / kebab menus.
// Uses CSS variables for cross-platform dark mode support (Windows WebView).

/** Floating menu container — pair with portal rendering and fixed positioning. */
export const menuClasses =
  "fixed py-1 min-w-[160px] bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg shadow-xl z-[9999]";

/** Interactive menu row — icon + label, full-width, hover highlight. */
export const menuItem =
  "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[color:var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";

/** Horizontal divider between menu groups. */
export const menuDivider = "my-1 border-t border-[var(--border-default)]";
