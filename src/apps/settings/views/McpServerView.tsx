// ui/src/apps/settings/views/McpServerView.tsx
//
// Settings view for the MCP server — lets an external MCP client (e.g. Claude
// Code) query live WireTAP runtime state. The server is off by default and
// read-only unless control gates are granted. Enabling/disabling the server
// applies immediately; permission, port and token changes are staged and take
// effect only when "Apply & restart server" is pressed (one restart, rather
// than bouncing the server — and disconnecting any client — on every tick).

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, RefreshCw, Check } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  labelDefault,
  helpText,
  inputSimple,
  buttonBase,
  primaryButtonBase,
  secondaryButton,
  disabledState,
  h2,
  textPrimary,
  textSuccess,
  textSecondary,
} from "../../../styles";
import { SETTINGS_BOUNDS } from "../../../settings/bounds";
import { SettingRow, SettingToggleRow } from "../components/rows";

interface McpStatus {
  running: boolean;
  port: number | null;
  // Whether applying the saved settings would change the running server. Rust
  // computes this (it owns both the running config and the saved settings), so
  // the UI never reconstructs it.
  restartPending: boolean;
}

const STOPPED_STATUS: McpStatus = { running: false, port: null, restartPending: false };

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

  const [status, setStatus] = useState<McpStatus>(STOPPED_STATUS);
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
  // without an app restart. Re-entrant calls are ignored so an in-flight apply
  // can't be interrupted and leave the panel wedged.
  const apply = useCallback(
    async (enabled: boolean) => {
      if (busy) return;
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
    [busy, refreshStatus],
  );

  const copy = useCallback((key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }, []);

  // Permission/port/token edits are staged, not applied: persist them (debounced
  // to coalesce keystrokes), then re-read status so Rust's restart-pending flag —
  // and the Apply button's emphasis — updates without restarting the server.
  const stageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stageChange = useCallback(() => {
    if (stageTimer.current) clearTimeout(stageTimer.current);
    stageTimer.current = setTimeout(async () => {
      await useSettingsStore.getState().saveSettings();
      await refreshStatus();
    }, 250);
  }, [refreshStatus]);

  // Wrap a permission setter so ticking it stages the change (see stageChange).
  const staged = useCallback(
    (setter: (v: boolean) => void) => (v: boolean) => {
      setter(v);
      stageChange();
    },
    [stageChange],
  );

  const authHeader = serverToken ? ` --header "Authorization: Bearer ${serverToken}"` : "";
  const addCommand = `claude mcp add --transport http wiretap http://127.0.0.1:${serverPort}/mcp${authHeader}`;

  // Rust reports whether applying the saved settings would change the running
  // server; the button is always clickable, this only drives its emphasis.
  const pendingRestart = status.restartPending;

  let applyMessage: string;
  if (pendingRestart && status.running) {
    applyMessage = "Unapplied changes — press Apply & restart server for them to take effect.";
  } else if (pendingRestart) {
    applyMessage = "Server is enabled but not running — press Apply to start it.";
  } else if (status.running) {
    applyMessage = "The running server matches these settings.";
  } else {
    applyMessage = "The MCP server is off — enable it above to start.";
  }

  // Permission gates — each adds a group of write/control tools. Staged (applied
  // on "Apply & restart server"), so each toggles via `staged(setter)`.
  const permissionGates: {
    label: string;
    checked: boolean;
    setter: (v: boolean) => void;
    help: ReactNode;
  }[] = [
    {
      label: "Allow control tools",
      checked: allowControl,
      setter: setAllowControl,
      help: (
        <>
          Lets the client <strong>drive the app</strong> — transmit frames on the bus, write
          Modbus registers and replay captures. Leave off for read-only introspection.
        </>
      ),
    },
    {
      label: "Allow session open/stop",
      checked: allowSessionControl,
      setter: setAllowSessionControl,
      help: (
        <>
          Lets the client <strong>open and stop sessions</strong> — e.g. start a Modbus session
          polling from a profile's catalogue. Separate from the control gate above.
        </>
      ),
    },
    {
      label: "Allow catalogue create (new files)",
      checked: allowCatalogWrite,
      setter: setAllowCatalogWrite,
      help: (
        <>
          Lets the client <strong>create new decoder catalogues</strong> in the decoder
          directory. Validated before writing; existing files are never overwritten.
        </>
      ),
    },
    {
      label: "Allow catalogue modify (overwrite existing)",
      checked: allowCatalogModify,
      setter: setAllowCatalogModify,
      help: (
        <>
          Lets the client <strong>overwrite existing decoder catalogues</strong>. Validated
          before writing. Separate from the create gate above.
        </>
      ),
    },
    {
      label: "Allow dashboard write",
      checked: allowDashboardWrite,
      setter: setAllowDashboardWrite,
      help: (
        <>
          Lets the client <strong>create or overwrite dashboard files</strong> in the
          dashboards directory. The JSON shape is validated; any embedded custom-widget code
          is stored opaque and only ever runs later inside the sandboxed worker.
        </>
      ),
    },
    {
      label: "Allow UI control (open panels)",
      checked: allowUiControl,
      setter: setAllowUiControl,
      help: (
        <>
          Lets the client <strong>open or focus a panel</strong> in the running window — e.g.
          show a dashboard it just authored. Requires the WireTAP window to be open.
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h2 className={h2}>MCP Server</h2>
      <p className={helpText}>
        Exposes live WireTAP runtime state — sessions, captures, frame data, payload
        analysis and decoded signals — to an external MCP client such as Claude Code,
        over a localhost-only HTTP transport. Everything is off by default; the server
        binds to 127.0.0.1 and stays read-only unless you grant control below.
      </p>

      <SettingToggleRow
        label="Enable MCP server"
        checked={serverEnabled}
        disabled={busy}
        onChange={(v) => {
          setServerEnabled(v);
          apply(v);
        }}
        help={
          <>
            Starts the server listening on the port below.{" "}
            <span className={status.running ? textSuccess : textSecondary}>
              {status.running ? `Running on 127.0.0.1:${status.port}` : "Stopped"}
            </span>
          </>
        }
      />

      {/* Permissions — staged; applied on "Apply & restart server" */}
      <div className="space-y-1 pt-1">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>Permissions</h3>
        <p className={helpText}>
          Grant only what the client needs. Read-only tools are always available; each
          gate below adds a group of write/control tools. Permission, port and token
          changes take effect when you press <strong>Apply &amp; restart server</strong>.
        </p>
      </div>

      {permissionGates.map((gate) => (
        <SettingToggleRow
          key={gate.label}
          label={gate.label}
          checked={gate.checked}
          disabled={busy}
          warn
          onChange={staged(gate.setter)}
          help={gate.help}
        />
      ))}

      {/* Port */}
      <SettingRow label="Port" htmlFor="mcp-port" className="max-w-xs">
        <input
          id="mcp-port"
          type="number"
          min={SETTINGS_BOUNDS.mcpServerPort.min}
          max={SETTINGS_BOUNDS.mcpServerPort.max}
          value={serverPort}
          onChange={(e) => {
            setServerPort(Number(e.target.value) || 8787);
            stageChange();
          }}
          className={inputSimple}
        />
      </SettingRow>

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
            onChange={(e) => {
              setServerToken(e.target.value);
              stageChange();
            }}
            className={`${inputSimple} font-mono text-xs`}
          />
          <button
            type="button"
            className={buttonBase}
            title="Generate a new token"
            onClick={() => {
              setServerToken(generateToken());
              stageChange();
            }}
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
          Clients must send this as a bearer token. Leave blank for no auth — the
          localhost-only bind is then the sole protection.
        </p>
      </div>

      {/* Apply */}
      <div>
        <button
          type="button"
          className={`${pendingRestart ? primaryButtonBase : secondaryButton} ${disabledState}`}
          disabled={busy || !pendingRestart}
          onClick={() => apply(serverEnabled)}
        >
          {busy ? "Applying…" : serverEnabled ? "Apply & restart server" : "Apply"}
        </button>
        <p className={`${helpText} mt-2`}>{applyMessage}</p>
      </div>

      {/* Connection snippet */}
      <div className="space-y-2 max-w-2xl">
        <label className={labelDefault}>Connect a client</label>
        <p className={helpText}>For Claude Code, run:</p>
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
          Tier 2 tools (discovery analysis, decoded signals, live frame map) need the
          WireTAP window open on the relevant view.
        </p>
      </div>
    </div>
  );
}
