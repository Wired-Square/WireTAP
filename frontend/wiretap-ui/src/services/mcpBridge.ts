// src/services/mcpBridge.ts
//
// Copyright 2026 Wired Square Pty Ltd
//
// Registers the MCP bridge methods — the frontend side of the reverse RPC the
// Rust MCP server uses for what only the page can do: open a panel, read or
// drive the DOM. Imported once at startup by WireTAP.tsx.

import { wsTransport } from "./wsTransport";
import { openPanel } from "../utils/windowCommunication";
import { openDashboard } from "../api/dashboards";
import { parseDashboard } from "../utils/dashboards";
import { useDashboardStore } from "../stores/dashboardStore";
import { DOM_OPS, runDomOp } from "./domOps";
import { apps, isPanelId } from "../apps/registry";

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
  wsTransport.registerBridgeMethod("ui.openPanel", uiOpenPanel);
  for (const op of DOM_OPS) {
    wsTransport.registerBridgeMethod(`dom.${op}`, (args) => runDomOp(op, args));
  }
}
