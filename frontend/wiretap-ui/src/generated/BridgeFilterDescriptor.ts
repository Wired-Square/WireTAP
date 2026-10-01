// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export type BridgeFilterDescriptor = { kind: "mask" | "range", ide: "any" | "std" | "ext", 
/**
 * Mask: `can_id`. Range: inclusive `lo`.
 */
a: number, 
/**
 * Mask: `mask`. Range: inclusive `hi`.
 */
b: number, };
