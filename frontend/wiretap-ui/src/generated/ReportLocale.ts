// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * The reports' words and number style in the user's language, supplied by the frontend.
 */
export type ReportLocale = { 
/**
 * Templates by `namespace:dotted.key`; a key left out reads in English.
 */
messages: { [key in string]: string }, groupSeparator: string, decimalSeparator: string, };
