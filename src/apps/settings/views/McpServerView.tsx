// ui/src/apps/settings/views/McpServerView.tsx
//
// Settings view for the MCP server — lets an external Claude client query live
// WireTAP runtime state. Two independent, off-by-default gates: enable the
// server, and (separately) allow control tools.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, RefreshCw, AlertTriangle, Check } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { labelDefault, helpText, inputSimple, buttonBase } from "../../../styles";

interface McpStatus {
  running: boolean;
  port: number | null;
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function McpServerView() {
  const serverEnabled = useSettingsStore((s) => s.mcp.serverEnabled);
  const allowControl = useSettingsStore((s) => s.mcp.allowControl);
  const serverPort = useSettingsStore((s) => s.mcp.serverPort);
  const serverToken = useSettingsStore((s) => s.mcp.serverToken);
  const setServerEnabled = useSettingsStore((s) => s.setMcpServerEnabled);
  const setAllowControl = useSettingsStore((s) => s.setMcpAllowControl);
  const setServerPort = useSettingsStore((s) => s.setMcpServerPort);
  const setServerToken = useSettingsStore((s) => s.setMcpServerToken);

  const [status, setStatus] = useState<McpStatus>({ running: false, port: null });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await invoke<McpStatus>("get_mcp_status"));
    } catch {
      /* command unavailable — leave status as-is */
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Persist current settings then (re)start or stop the server so changes apply
  // without an app restart.
  const apply = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await useSettingsStore.getState().saveSettings();
        const next = await invoke<McpStatus>("toggle_mcp_server", { enabled });
        setStatus(next);
      } catch (e) {
        console.error("[mcp] toggle failed:", e);
        await refreshStatus();
      } finally {
        setBusy(false);
      }
    },
    [refreshStatus],
  );

  const copy = useCallback((key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }, []);

  const authHeader = serverToken ? ` --header "Authorization: Bearer ${serverToken}"` : "";
  const addCommand = `claude mcp add --transport http wiretap http://127.0.0.1:${serverPort}/mcp${authHeader}`;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">MCP Server</h2>
      <p className={helpText}>
        Exposes live WireTAP runtime state (sessions, captures, frame data, payload
        analysis and decoded signals) to an external Claude client over a localhost
        HTTP transport. Off by default. The server binds to 127.0.0.1 only.
      </p>

      {/* Enable */}
      <div className="space-y-2">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={serverEnabled}
            disabled={busy}
            onChange={(e) => {
              setServerEnabled(e.target.checked);
              apply(e.target.checked);
            }}
            className="mt-1"
          />
          <div>
            <span className={labelDefault}>Enable MCP server</span>
            <p className={helpText}>
              When on, the server listens on the port below.{" "}
              <span className={status.running ? "text-green-500" : "text-[color:var(--text-secondary)]"}>
                {status.running ? `Running on 127.0.0.1:${status.port}` : "Stopped"}
              </span>
            </p>
          </div>
        </label>
      </div>

      {/* Allow control */}
      <div className="space-y-2">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={allowControl}
            disabled={busy}
            onChange={(e) => {
              setAllowControl(e.target.checked);
              if (serverEnabled) apply(true);
            }}
            className="mt-1"
          />
          <div>
            <span className={labelDefault}>Allow control tools</span>
            <p className={`${helpText} flex items-start gap-1`}>
              <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
              <span>
                Lets a connected Claude client <strong>drive</strong> the app — transmit
                frames on the bus, stop sessions, and replay captures. Leave off for
                read-only introspection.
              </span>
            </p>
          </div>
        </label>
      </div>

      {/* Port */}
      <div className="space-y-2 max-w-xs">
        <label className={labelDefault} htmlFor="mcp-port">
          Port
        </label>
        <input
          id="mcp-port"
          type="number"
          min={1024}
          max={65535}
          value={serverPort}
          onChange={(e) => setServerPort(Number(e.target.value) || 8787)}
          className={inputSimple}
        />
      </div>

      {/* Token */}
      <div className="space-y-2 max-w-xl">
        <label className={labelDefault} htmlFor="mcp-token">
          Bearer token
        </label>
        <div className="flex items-center gap-2">
          <input
            id="mcp-token"
            type="text"
            value={serverToken}
            placeholder="(no auth — leave blank for local-only)"
            onChange={(e) => setServerToken(e.target.value)}
            className={`${inputSimple} font-mono text-xs`}
          />
          <button
            type="button"
            className={buttonBase}
            title="Generate a new token"
            onClick={() => setServerToken(generateToken())}
          >
            <RefreshCw size={14} /> Generate
          </button>
          <button
            type="button"
            className={buttonBase}
            disabled={!serverToken}
            title="Copy token"
            onClick={() => copy("token", serverToken)}
          >
            {copied === "token" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <p className={helpText}>
          Clients must send this as a bearer token. Empty means no auth (relies on the
          localhost-only bind).
        </p>
      </div>

      {/* Apply */}
      <div>
        <button
          type="button"
          className={buttonBase}
          disabled={busy}
          onClick={() => apply(serverEnabled)}
        >
          {serverEnabled ? "Apply & restart server" : "Apply"}
        </button>
        <p className={`${helpText} mt-1`}>
          Saves settings and restarts the server so the port, token and control changes
          take effect.
        </p>
      </div>

      {/* Connection snippet */}
      <div className="space-y-2 max-w-2xl">
        <label className={labelDefault}>Connect Claude Code</label>
        <div className="flex items-start gap-2">
          <pre className="flex-1 text-xs font-mono whitespace-pre-wrap break-all bg-[var(--bg-primary)] border border-[color:var(--border-default)] rounded p-3 text-[color:var(--text-primary)]">
            {addCommand}
          </pre>
          <button
            type="button"
            className={buttonBase}
            title="Copy command"
            onClick={() => copy("cmd", addCommand)}
          >
            {copied === "cmd" ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <p className={helpText}>
          Tier 2 tools (discovery analysis, decoded signals, live frame map) require the
          WireTAP window to be open on the relevant view.
        </p>
      </div>
    </div>
  );
}
