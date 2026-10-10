// src/api/query.ts
//
// The Query app's queue, run in Rust and pushed whole as `MsgType.QueryQueue`.

import { invoke } from "@tauri-apps/api/core";
import type { QueryOutcome } from "../generated/QueryOutcome";
import type { QueryQueue } from "../generated/QueryQueue";
import type { QueryRequest } from "../generated/QueryRequest";

export type { QueryOutcome, QueryQueue, QueryRequest };
export type { QueryItem } from "../generated/QueryItem";
export type { QueryResults } from "../generated/QueryResults";
export type { QuerySource } from "../generated/QuerySource";
export type { QuerySpec } from "../generated/QuerySpec";
export type { QueryStats } from "../generated/QueryStats";
export type { QueryStatus } from "../generated/QueryStatus";
export type { ByteChangeResult } from "../generated/ByteChangeResult";
export type { FrameChangeResult } from "../generated/FrameChangeResult";
export type { MirrorValidationResult } from "../generated/MirrorValidationResult";
export type { MuxStatisticsResult } from "../generated/MuxStatisticsResult";
export type { MuxCaseStats } from "../generated/MuxCaseStats";
export type { BytePositionStats } from "../generated/BytePositionStats";
export type { Word16Stats } from "../generated/Word16Stats";
export type { FirstLastResult } from "../generated/FirstLastResult";
export type { FrequencyBucket } from "../generated/FrequencyBucket";
export type { DistributionResult } from "../generated/DistributionResult";
export type { GapResult } from "../generated/GapResult";
export type { PatternSearchResult } from "../generated/PatternSearchResult";
export type { InventoryRow } from "../generated/InventoryRow";

export const enqueueQuery = (label: string, request: QueryRequest) => invoke<string>("query_enqueue", { label, request });

export const getQueryQueue = () => invoke<QueryQueue>("query_queue_get");

/** Remove a query, cancelling it if it is running. */
export const removeQuery = (id: string) => invoke<void>("query_remove", { id });

export const getQueryResult = (id: string) => invoke<QueryOutcome>("query_result", { id });

/** The statements a request would run, without running them. */
export const previewQuery = (request: QueryRequest) => invoke<string[]>("query_preview", { request });

export const exportQueryCsv = (id: string) => invoke<string>("query_export_csv", { id });
