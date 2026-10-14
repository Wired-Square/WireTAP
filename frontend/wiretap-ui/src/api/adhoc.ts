// ui/src/api/adhoc.ts
//
// The Dashboard's ad-hoc signals, decoded and ranked in Rust (`adhoc.rs`). Names
// are parsed there; this side sends what the panels chart and renders the results.

import { invoke } from "@tauri-apps/api/core";
import { wsTransport } from "../services/wsTransport";
import type { AdhocSignalRef } from "../generated/AdhocSignalRef";
import type { RankedHypotheses } from "../generated/RankedHypotheses";
import type { RankRequest } from "../generated/RankRequest";

export type { AdhocSignalRef };
export type { HypothesisReason } from "../generated/HypothesisReason";
export type { RankedCandidate } from "../generated/RankedCandidate";

/** Decode these for this window, and count bit toggles on the `heatmaps` frames. */
export async function setAdhocSignals(sessionId: string, signals: AdhocSignalRef[], heatmaps: number[]): Promise<void> {
  await wsTransport.command("adhoc.set", { session_id: sessionId, signals, heatmaps });
}

export async function clearAdhocSignals(sessionId: string): Promise<void> {
  await wsTransport.command("adhoc.clear", { session_id: sessionId });
}

/** Best first and capped; `total` counts them before the cap. */
export async function rankHypotheses(
  sessionId: string,
  request: RankRequest,
): Promise<RankedHypotheses> {
  return invoke("rank_hypotheses", { sessionId, request });
}
