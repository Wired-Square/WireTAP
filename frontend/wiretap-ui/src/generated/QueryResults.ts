// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteChangeResult } from "./ByteChangeResult";
import type { DistributionResult } from "./DistributionResult";
import type { FirstLastResult } from "./FirstLastResult";
import type { FrameChangeResult } from "./FrameChangeResult";
import type { FrequencyBucket } from "./FrequencyBucket";
import type { GapResult } from "./GapResult";
import type { InventoryRow } from "./InventoryRow";
import type { MirrorValidationResult } from "./MirrorValidationResult";
import type { MuxStatisticsResult } from "./MuxStatisticsResult";
import type { PatternSearchResult } from "./PatternSearchResult";

/**
 * A query's results; which variant follows from the spec's type.
 */
export type QueryResults = Array<ByteChangeResult> | Array<FrameChangeResult> | Array<MirrorValidationResult> | MuxStatisticsResult | FirstLastResult | Array<FrequencyBucket> | Array<DistributionResult> | Array<GapResult> | Array<PatternSearchResult> | Array<InventoryRow>;
