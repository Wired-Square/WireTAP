// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Why a profile was rejected. An enum rather than a string so adding a rule is
 * a compile error at every match, and so the frontend's translation map has a
 * closed set to cover.
 */
export type ValidationCode = "nameRequired" | "nameDuplicate" | "portRequired" | "hostRequired" | "fieldRequired" | "fieldInvalid";
