// src/services/mcpBridge.ts
//
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Wired Square Pty Ltd
//
// Registers the MCP bridge methods — the frontend side of the reverse RPC the
// Rust MCP server uses to reach state only the frontend holds (payload
// analysis, decoded signals, the live discovery buffer). Imported once at
// startup by WireTAP.tsx.

import { wsTransport } from "./wsTransport";
import { getDiscoveryFrameBuffer, getLastFrameDataMap } from "../stores/discoveryFrameStore";
import type { LastFrameData } from "../stores/discoveryFrameStore";
import { getDecodedFrames } from "../stores/decoderStore";
import { analyzePayloadsWithMuxDetection } from "../utils/analysis/payloadAnalysis";
import type { FrameMessage } from "../types/frame";
import { openPanel } from "../utils/windowCommunication";
import { openDashboard } from "../api/dashboards";
import { parseDashboard } from "../utils/dashboards";
import { useGraphStore } from "../stores/graphStore";

// Bounds so a huge live buffer can't produce an enormous MCP response.
const MAX_FRAME_IDS = 64;
const MAX_SAMPLES_PER_ID = 1000;

interface DiscoveryParams {
  session_id?: string | null;
  frame_ids?: string[] | null;
}
interface DecoderParams {
  session_id?: string | null;
  frame_id?: string | null;
}

/** Composite frame key, matching the discovery store convention (e.g. "can:256"). */
function frameKey(f: FrameMessage): string {
  return `${f.protocol}:${f.frame_id}`;
}

/** Convert a value to a plain JSON-safe structure (Sets → arrays). */
function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (v instanceof Set ? Array.from(v) : v)),
  );
}

/** discovery.analysis — per-byte payload analysis for live discovery frames. */
function discoveryAnalysis(params: unknown) {
  const p = (params ?? {}) as DiscoveryParams;
  const wanted = p.frame_ids && p.frame_ids.length ? new Set(p.frame_ids) : null;
  const buffer = getDiscoveryFrameBuffer();

  const groups = new Map<
    string,
    { protocol: string; frameId: number; payloads: number[][] }
  >();
  for (const f of buffer) {
    const key = frameKey(f);
    if (wanted && !wanted.has(key)) continue;
    let g = groups.get(key);
    if (!g) {
      if (!wanted && groups.size >= MAX_FRAME_IDS) continue;
      g = { protocol: f.protocol, frameId: f.frame_id, payloads: [] };
      groups.set(key, g);
    }
    if (g.payloads.length < MAX_SAMPLES_PER_ID) g.payloads.push(f.bytes);
  }

  const frames: unknown[] = [];
  for (const [key, g] of groups) {
    if (g.payloads.length === 0) continue;
    const analysis = analyzePayloadsWithMuxDetection(g.payloads, g.frameId, false);
    frames.push({
      frameKey: key,
      protocol: g.protocol,
      frameId: g.frameId,
      sampleCount: g.payloads.length,
      analysis,
    });
  }
  return toJsonSafe({ frameCount: frames.length, frames });
}

/** decoder.signals — latest decoded signals from the loaded catalog. */
function decoderSignals(params: unknown) {
  const p = (params ?? {}) as DecoderParams;
  const decoded = getDecodedFrames();
  const frames: unknown[] = [];
  decoded.forEach((frame, frameId) => {
    if (
      p.frame_id &&
      p.frame_id !== String(frameId) &&
      p.frame_id !== `can:${frameId}`
    ) {
      return;
    }
    frames.push({
      frameId,
      signals: frame.signals,
      headerFields: frame.headerFields,
      muxSelectors: frame.muxSelectors,
    });
  });
  return { frameCount: frames.length, frames };
}

/** live.frameMap — last-seen payload bytes for every discovered frame id. */
function liveFrameMap(params: unknown) {
  const p = (params ?? {}) as DiscoveryParams;
  const wanted = p.frame_ids && p.frame_ids.length ? new Set(p.frame_ids) : null;
  const map = getLastFrameDataMap();
  const frames: Record<string, LastFrameData> = {};
  map.forEach((data, key) => {
    if (wanted && !wanted.has(key)) return;
    frames[key] = data;
  });
  return { frameCount: Object.keys(frames).length, frames };
}

/** ui.openPanel — open/focus an app/panel in the running window; optionally load
 *  a dashboard artifact first. The frontend side of the MCP `open_app` tool. */
async function uiOpenPanel(params: unknown) {
  const p = (params ?? {}) as { panelId?: string; args?: unknown };
  const panelId = p.panelId || "dashboard";
  // `args` may arrive as an object or (depending on the MCP client) a JSON string.
  let args = p.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  const dashboardPath = (args as { dashboardPath?: string } | undefined)?.dashboardPath;
  if (dashboardPath) {
    const json = await openDashboard(dashboardPath);
    useGraphStore.getState().loadDashboard(parseDashboard(json));
  }
  openPanel(panelId);
  return { opened: true, panelId, loadedDashboard: !!dashboardPath };
}

/** Register all MCP bridge methods. Call once at app startup. */
export function initMcpBridge(): void {
  wsTransport.registerBridgeMethod("discovery.analysis", discoveryAnalysis);
  wsTransport.registerBridgeMethod("decoder.signals", decoderSignals);
  wsTransport.registerBridgeMethod("live.frameMap", liveFrameMap);
  wsTransport.registerBridgeMethod("ui.openPanel", uiOpenPanel);
}
