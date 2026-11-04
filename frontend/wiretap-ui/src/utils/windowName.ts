// Human-facing window names. Internally the primary Tauri window is labelled
// "dashboard" (tauri.conf.json) and dynamic windows are "main-1", "main-2", … —
// this maps those identifiers to what the user sees: the primary is "main" and
// each subsequent window is its number ("1", "2", …).

import i18n from "i18next";

export function formatWindowName(label: string): string {
  if (label === "dashboard" || label === "main") return i18n.t("common:mainWindow");
  const m = label.match(/^main-(\d+)$/);
  return m ? m[1] : label;
}
