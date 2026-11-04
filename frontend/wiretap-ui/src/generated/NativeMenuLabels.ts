// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * The menu bar's words in the user's language, supplied by the frontend.
 */
export type NativeMenuLabels = { appsMenu: string, editMenu: string, sessionMenu: string, eventsMenu: string, jumpToEventMenu: string, viewMenu: string, helpMenu: string, about: string, settings: string, newWindow: string, find: string, noSource: string, 
/**
 * The source line, with `{{name}}` where the profile name goes.
 */
source: string, sessionPicker: string, sessionImportFile: string, sessionPlay: string, sessionPause: string, sessionStop: string, sessionDetach: string, sessionStopAll: string, sessionClear: string, eventAdd: string, eventShow: string, helpIssues: string, helpWiki: string, helpSource: string, 
/**
 * Apps menu labels by panel id; an app left out keeps its label.
 */
apps: { [key in string]: string }, };
