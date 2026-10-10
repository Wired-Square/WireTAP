// ui/src/api/adhoc.ts
//
// The Dashboard's ad-hoc signals, decoded and ranked in Rust (`adhoc.rs`). Names
// are parsed there; this side sends what the panels chart and renders the results.

import { invoke } from "@tauri-apps/api/core";
import { wsTransport } from "../services/wsTransport";
import type { HypothesisParams } from "../stores/dashboardStore";

/** A charted signal; `params` is a `hyp_*` name's saved scaling. */
export interface AdhocSignalRef {
  frameId: number;
  name: string;
  params?: HypothesisParams;
}

/** Decode these for this window, and count bit toggles on the `heatmaps` frames. */
export async function setAdhocSignals(sessionId: string, signals: AdhocSignalRef[], heatmaps: number[]): Promise<void> {
  await wsTransport.command("adhoc.set", { session_id: sessionId, signals, heatmaps });
}

export async function clearAdhocSignals(sessionId: string): Promise<void> {
  await wsTransport.command("adhoc.clear", { session_id: sessionId });
}

export type RoleKind = "static" | "counter" | "sensor" | "value" | "unknown";

export type CandidateReason =
  | { code: "role"; role: RoleKind }
  | { code: "pattern"; kind: "counter16" | "sensor16" | "sensor32" | "text"; exact: boolean }
  | { code: "endiannessAgrees" }
  | { code: "endiannessMixed" }
  | { code: "highVariance" }
  | { code: "strongTrend" }
  | { code: "noProfile" };

export interface RankedCandidate {
  frameId: number;
  name: string;
  params: HypothesisParams;
  /** 0–100 */
  score: number;
  reasons: CandidateReason[];
}

/** `endBit` absent sweeps each frame's whole payload. */
export interface RankRequest {
  frameIds: number[];
  startBit: number;
  endBit?: number;
  bitStep: number;
  bitLengths: number[];
  endiannesses: ("little" | "big")[];
  signed: boolean;
  factor: number;
  offset: number;
  useProfile: boolean;
}

/** Best first and capped; `total` counts them before the cap. */
export async function rankHypotheses(
  sessionId: string,
  request: RankRequest,
): Promise<{ candidates: RankedCandidate[]; total: number }> {
  return invoke("rank_hypotheses", { sessionId, request });
}
