// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How a dashboard should show a signal: `display = "rotary"`, or a table such as
 * `{ widget = "level-bar", orientation = "vertical" }`. The widget names are the
 * consumer's, and the options keep their keys as authored.
 */
export type DisplayHint = { widget: string, [option: string]: unknown };
