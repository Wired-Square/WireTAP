// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CatalogProtocol } from "./CatalogProtocol";
import type { Draft } from "./Draft";
import type { DraftSignal } from "./DraftSignal";

export type DraftPreview = { draft: Draft, defaultFrame: CatalogProtocol | null, 
/**
 * Each of `draft`'s frames' signals, as it would be written.
 */
signals: Array<Array<DraftSignal>>, };
