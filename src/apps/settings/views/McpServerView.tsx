// ui/src/apps/settings/views/McpServerView.tsx
//
// Settings view for the MCP server — lets an external MCP client query live
// WireTAP runtime state. Three independent, off-by-default gates: enable the
// server, allow control tools, and allow session open/stop.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, RefreshCw, AlertTriangle, Check } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { labelDefault, helpText, inputSimple, buttonBase } from "../../../styles";

interface McpStatus {
  running: boolean;
  port: number | null;
}

/** A checkbox row with a label and help/warning text. */
function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
  warn,
  children,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1"
        />
        <div>
          <span className={labelDefault}>{label}</span>
          <p className={warn ? `${helpText} flex items-start gap-1` : helpText}>
            {warn && <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />}
            {warn ? <span>{children}</span> : children}
          </p>
        </div>
      </label>
    </div>
  );
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function McpServerView() {
  const serverEnabled = useSettingsStore((s) => s.mcp.serverEnabled);
  const allowControl = useSettingsStore((s) => s.mcp.allowControl);
  const allowSessionControl = useSettingsStore((s) => s.mcp.allowSessionControl);
  const serverPort = useSettingsStore((s) => s.mcp.serverPort);
  const serverToken = useSettingsStore((s) => s.mcp.serverToken);
  const setServerEnabled = useSettingsStore((s) => s.setMcpServerEnabled);
  const setAllowControl = useSettingsStore((s) => s.setMcpAllowControl);
  const setAllowSessionControl = useSettingsStore((s) => s.setMcpAllowSessionControl);
  const allowCatalogWrite = useSettingsStore((s) => s.mcp.allowCatalogWrite);
  const allowCatalogModify = useSettingsStore((s) => s.mcp.allowCatalogModify);
  const setAllowCatalogWrite = useSettingsStore((s) => s.setMcpAllowCatalogWrite);
  const setAllowCatalogModify = useSettingsStore((s) => s.setMcpAllowCatalogModify);
  const allowDashboardWrite = useSettingsStore((s) => s.mcp.allowDashboardWrite);
  const allowUiControl = useSettingsStore((s) => s.mcp.allowUiControl);
  const setAllowDashboardWrite = useSettingsStore((s) => s.setMcpAllowDashboardWrite);
  const setAllowUiControl = useSettingsStore((s) => s.setMcpAllowUiControl);
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
        analysis and decoded signals) to an external MCP client over a localhost
        HTTP transport. Off by default. The server binds to 127.0.0.1 only.
      </p>

      <ToggleRow
        label="Enable MCP server"
        checked={serverEnabled}
        disabled={busy}
        onChange={(v) => {
          setServerEnabled(v);
          apply(v);
        }}
      >
        When on, the server listens on the port below.{" "}
        <span className={status.running ? "text-green-500" : "text-[color:var(--text-secondary)]"}>
          {status.running ? `Running on 127.0.0.1:${status.port}` : "Stopped"}
        </span>
      </ToggleRow>

      <ToggleRow
        label="Allow control tools"
        checked={allowControl}
        disabled={busy}
        warn
        onChange={(v) => {
          setAllowControl(v);
          if (serverEnabled) apply(true);
        }}
      >
        Lets a connected MCP client <strong>drive</strong> the app — transmit frames on
        the bus, write Modbus registers, and replay captures. Leave off for read-only
        introspection.
      </ToggleRow>

      <ToggleRow
        label="Allow session open/stop"
        checked={allowSessionControl}
        disabled={busy}
        warn
        onChange={(v) => {
          setAllowSessionControl(v);
          if (serverEnabled) apply(true);
        }}
      >
        Lets a connected MCP client <strong>open and stop sessions</strong> — e.g. start a
        Modbus session polling from a profile's catalog. Separate from the control gate above.
      </ToggleRow>

      <ToggleRow
        label="Allow catalog create (new files)"
        checked={allowCatalogWrite}
        disabled={busy}
        warn
        onChange={(v) => {
          setAllowCatalogWrite(v);
          if (serverEnabled) apply(true);
        }}
      >
        Lets a connected MCP client <strong>create new decoder catalogues</strong> in the
        decoder directory. Validated before writing; cannot overwrite an existing file.
      </ToggleRow>

      <ToggleRow
        label="Allow catalog modify (overwrite existing)"
        checked={allowCatalogModify}
        disabled={busy}
        warn
        onChange={(v) => {
          setAllowCatalogModify(v);
          if (serverEnabled) apply(true);
        }}
      >
        Lets a connected MCP client <strong>overwrite existing decoder catalogues</strong>.
        Validated before writing. Separate from the create gate above.
      </ToggleRow>

      <ToggleRow
        label="Allow dashboard write"
        checked={allowDashboardWrite}
        disabled={busy}
        warn
        onChange={(v) => {
          setAllowDashboardWrite(v);
          if (serverEnabled) apply(true);
        }}
      >
        Lets a connected MCP client <strong>create or overwrite dashboard files</strong>
        (visualisers) in the dashboards directory. The JSON shape is validated; any embedded
        custom-widget code is stored opaque and only ever runs later inside the sandboxed worker.
      </ToggleRow>

      <ToggleRow
        label="Allow UI control (open panels)"
        checked={allowUiControl}
        disabled={busy}
        warn
        onChange={(v) => {
          setAllowUiControl(v);
          if (serverEnabled) apply(true);
        }}
      >
        Lets a connected MCP client <strong>open or focus an app/panel</strong> in the running
        window — e.g. open a dashboard it just authored. Requires the WireTAP window to be open.
      </ToggleRow>

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
        <label className={labelDefault}>Connect an MCP client</label>
        <p className={helpText}>Example for Claude Code:</p>
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
