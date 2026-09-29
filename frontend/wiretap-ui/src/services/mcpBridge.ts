// src/services/mcpBridge.ts
//
// Copyright 2026 Wired Square Pty Ltd
//
// Registers the MCP bridge methods — the frontend side of the reverse RPC the
// Rust MCP server uses to reach state only the frontend holds (decoded signals,
// the live frame map). Imported once at startup by WireTAP.tsx.

import { wsTransport } from "./wsTransport";
import { getLastFrameDataMap } from "../stores/discoveryFrameStore";
import type { LastFrameData } from "../stores/discoveryFrameStore";
import { getDecodedFrames } from "../stores/decoderStore";
import { openPanel } from "../utils/windowCommunication";
import { openDashboard } from "../api/dashboards";
import { parseDashboard } from "../utils/dashboards";
import { useDashboardStore } from "../stores/dashboardStore";
import { DOM_OPS, runDomOp } from "./domOps";
import { apps, isPanelId } from "../apps/registry";

interface DiscoveryParams {
  session_id?: string | null;
  frame_ids?: string[] | null;
}
interface DecoderParams {
  session_id?: string | null;
  frame_id?: string | null;
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
  if (!isPanelId(panelId)) {
    throw new Error(`Unknown app "${panelId}". Valid ids: ${apps.map((a) => a.id).join(", ")}`);
  }
  // `args` may arrive as an object or (depending on the MCP client) a JSON string.
  let args = p.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  const dashboardPath = (args as { dashboardPath?: string } | undefined)?.dashboardPath;
  if (dashboardPath) {
    const json = await openDashboard(dashboardPath);
    useDashboardStore.getState().loadDashboard(parseDashboard(json));
  }
  openPanel(panelId);
  return { opened: true, panelId, loadedDashboard: !!dashboardPath };
}

/** Register all MCP bridge methods. Call once at app startup. */
export function initMcpBridge(): void {
  wsTransport.registerBridgeMethod("decoder.signals", decoderSignals);
  wsTransport.registerBridgeMethod("live.frameMap", liveFrameMap);
  wsTransport.registerBridgeMethod("ui.openPanel", uiOpenPanel);
  for (const op of DOM_OPS) {
    wsTransport.registerBridgeMethod(`dom.${op}`, (args) => runDomOp(op, args));
  }
}
