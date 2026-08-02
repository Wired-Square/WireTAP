// ui/src/dialogs/io-source-picker/types.ts
//
// Shared vocabulary for the Data Source dialog.

/**
 * Which section of the source list is showing.
 *
 * Owned here rather than by a component: `IoSourcePickerDialog` holds the state and
 * `SourceList` only receives it, so neither of them is the type's home.
 */
export type SourceTab = "sessions" | "captures" | "devices";
