// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QueryItem } from "./QueryItem";

/**
 * The whole queue; `revision` rises with every change.
 */
export type QueryQueue = { revision: number, items: Array<QueryItem>, };
