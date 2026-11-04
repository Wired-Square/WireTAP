// ui/src/apps/settings/views/McpServerView.tsx
//
// Settings view for the MCP server — lets an external MCP client (e.g. Claude
// Code) query live WireTAP runtime state. The server is off by default and
// read-only unless control gates are granted. Enabling/disabling the server
// applies immediately; permission, port and token changes are staged and take
// effect only when "Apply & restart server" is pressed (one restart, rather
// than bouncing the server — and disconnecting any client — on every tick).

import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Copy, RefreshCw, Check } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  labelDefault,
  helpText,
  h2,
  textPrimary,
  textSuccess,
  textSecondary,
} from "../../../styles";
import { SETTINGS_BOUNDS } from "../../../settings/bounds";
import { SettingRow, SettingToggleRow } from "../components/rows";
import { Button } from "../../../components/Button";
import { PrimaryButton, SecondaryButton, Input } from "../../../components/forms";

interface McpStatus {
  running: boolean;
  port: number | null;
  // Whether applying the saved settings would change the running server. Rust
  // computes this (it owns both the running config and the saved settings), so
  // the UI never reconstructs it.
  restartPending: boolean;
}

const STOPPED_STATUS: McpStatus = { running: false, port: null, restartPending: false };

export default function McpServerView() {
  const { t } = useTranslation("settings");
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

  const applyStatus = pendingRestart
    ? status.running ? "unappliedRunning" : "notRunning"
    : status.running ? "matches" : "off";

  // Permission gates — each adds a group of write/control tools. Staged (applied
  // on "Apply & restart server"), so each toggles via `staged(setter)`.
  const permissionGates: { key: string; checked: boolean; setter: (v: boolean) => void }[] = [
    { key: "control", checked: allowControl, setter: setAllowControl },
    { key: "sessionControl", checked: allowSessionControl, setter: setAllowSessionControl },
    { key: "catalogueCreate", checked: allowCatalogWrite, setter: setAllowCatalogWrite },
    { key: "catalogueModify", checked: allowCatalogModify, setter: setAllowCatalogModify },
    { key: "dashboardWrite", checked: allowDashboardWrite, setter: setAllowDashboardWrite },
    { key: "uiControl", checked: allowUiControl, setter: setAllowUiControl },
  ];

  const ApplyButton = pendingRestart ? PrimaryButton : SecondaryButton;

  return (
    <div className="space-y-6">
      <h2 className={h2}>{t("mcp.title")}</h2>
      <p className={helpText}>{t("mcp.intro")}</p>

      <SettingToggleRow
        label={t("mcp.enable.label")}
        checked={serverEnabled}
        disabled={busy}
        onChange={(v) => {
          setServerEnabled(v);
          apply(v);
        }}
        help={
          <>
            {t("mcp.enable.help")}{" "}
            <span className={status.running ? textSuccess : textSecondary}>
              {status.running ? t("mcp.enable.running", { port: status.port }) : t("mcp.enable.stopped")}
            </span>
          </>
        }
      />

      {/* Permissions — staged; applied on "Apply & restart server" */}
      <div className="space-y-1 pt-1">
        <h3 className={`text-sm font-semibold ${textPrimary}`}>{t("mcp.permissions.title")}</h3>
        <p className={helpText}>
          <Trans t={t} i18nKey="mcp.permissions.help" components={{ strong: <strong /> }} />
        </p>
      </div>

      {permissionGates.map((gate) => (
        <SettingToggleRow
          key={gate.key}
          label={t(`mcp.permissions.${gate.key}.label`)}
          checked={gate.checked}
          disabled={busy}
          warn
          onChange={staged(gate.setter)}
          help={
            <Trans
              t={t}
              i18nKey={`mcp.permissions.${gate.key}.help`}
              components={{ strong: <strong /> }}
            />
          }
        />
      ))}

      {/* Port */}
      <SettingRow label={t("mcp.port.label")} htmlFor="mcp-port" className="max-w-xs">
        <Input
          id="mcp-port"
          type="number"
          min={SETTINGS_BOUNDS.mcpServerPort.min}
          max={SETTINGS_BOUNDS.mcpServerPort.max}
          value={serverPort}
          onChange={(e) => {
            setServerPort(Number(e.target.value) || 8787);
            stageChange();
          }}
          size="lg"
        />
      </SettingRow>

      {/* Token */}
      <div className="space-y-2 max-w-xl">
        <label className={labelDefault} htmlFor="mcp-token">
          {t("mcp.token.label")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="mcp-token"
            type="text"
            value={serverToken}
            placeholder={t("mcp.token.placeholder")}
            onChange={(e) => {
              setServerToken(e.target.value);
              stageChange();
            }}
            mono
          />
          <Button
            title={t("mcp.token.generateTitle")}
            onClick={async () => {
              setServerToken(await invoke<string>("generate_mcp_token"));
              stageChange();
            }}
          >
            <RefreshCw size={14} /> {t("mcp.token.generate")}
          </Button>
          <Button
            disabled={!serverToken}
            title={t("mcp.token.copyTitle")}
            onClick={() => copy("token", serverToken)}
          >
            {copied === "token" ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </div>
        <p className={helpText}>{t("mcp.token.help")}</p>
      </div>

      {/* Apply */}
      <div>
        <ApplyButton disabled={busy || !pendingRestart} onClick={() => apply(serverEnabled)}>
          {t(busy ? "mcp.apply.applying" : serverEnabled ? "mcp.apply.applyRestart" : "mcp.apply.apply")}
        </ApplyButton>
        <p className={`${helpText} mt-2`}>{t(`mcp.apply.status.${applyStatus}`)}</p>
      </div>

      {/* Connection snippet */}
      <div className="space-y-2 max-w-2xl">
        <label className={labelDefault}>{t("mcp.connect.label")}</label>
        <p className={helpText}>{t("mcp.connect.claudeCode")}</p>
        <div className="flex items-start gap-2">
          <pre className="flex-1 text-xs font-mono whitespace-pre-wrap break-all bg-primary border border-default rounded p-3 text-primary">
            {addCommand}
          </pre>
          <Button title={t("mcp.connect.copyTitle")} onClick={() => copy("cmd", addCommand)}>
            {copied === "cmd" ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </div>
        <p className={helpText}>{t("mcp.connect.windowNote")}</p>
      </div>
    </div>
  );
}
