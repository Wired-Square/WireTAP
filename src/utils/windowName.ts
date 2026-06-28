// Human-facing window names. Internally the primary Tauri window is labelled
// "dashboard" (tauri.conf.json) and dynamic windows are "main-1", "main-2", … —
// this maps those identifiers to what the user sees: the primary is "main" and
// each subsequent window is its number ("1", "2", …).

export function formatWindowName(label: string): string {
  if (label === "dashboard" || label === "main") return "main";
  const m = label.match(/^main-(\d+)$/);
  return m ? m[1] : label;
}
