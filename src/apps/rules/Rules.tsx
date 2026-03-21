// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useCallback } from "react";
import { Workflow, Save, RefreshCw, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import AppLayout from "../../components/AppLayout";
import AppTopBar from "../../components/AppTopBar";
import { useSettingsStore } from "../settings/stores/settingsStore";
import { useRulesStore, type RulesTab } from "./stores/rulesStore";
import { textPrimary, textSecondary, textTertiary, bgSurface, borderDefault } from "../../styles";
import { iconMd } from "../../styles/spacing";
import FrameDefsView from "./views/FrameDefsView";
import BridgesView from "./views/BridgesView";
import TransformersView from "./views/TransformersView";
import GeneratorsView from "./views/GeneratorsView";
import UserSignalsView from "./views/UserSignalsView";
import IndicatorsView from "./views/IndicatorsView";
import DeviceOverview from "./views/DeviceOverview";
import type { IOProfile } from "../../hooks/useSettings";

const TABS: { id: RulesTab; label: string }[] = [
  { id: "frame-defs", label: "Frame Defs" },
  { id: "bridges", label: "Bridges" },
  { id: "transformers", label: "Transformers" },
  { id: "generators", label: "Generators" },
  { id: "indicators", label: "Indicators" },
  { id: "user-signals", label: "User Signals" },
  { id: "overview", label: "Overview" },
];

interface FramelinkDevice {
  /** device_id from capabilities, or fallback to host:port */
  deviceId: string;
  host: string;
  port: number;
  /** Device-level label (profile name with interface suffix stripped) */
  label: string;
}

/** Deduplicate framelink profiles by device_id to get unique devices. */
function deriveDevices(profiles: IOProfile[]): FramelinkDevice[] {
  const seen = new Map<string, FramelinkDevice>();
  for (const p of profiles) {
    if (p.kind !== "framelink") continue;
    const host = p.connection?.host as string | undefined;
    if (!host) continue;
    const port = Number(p.connection?.port) || 120;
    const did = (p.connection?.device_id as string) ?? `${host}:${port}`;
    if (!seen.has(did)) {
      const ifaceName = (p.connection?.interface_name as string) ?? "";
      const label = ifaceName && p.name.endsWith(ifaceName)
        ? p.name.slice(0, -ifaceName.length).trim()
        : p.name;
      seen.set(did, { deviceId: did, host, port, label: label || did });
    }
  }
  return Array.from(seen.values());
}

export default function Rules() {
  const ioProfiles = useSettingsStore((s) => s.ioProfiles.profiles);

  const framelinkDevices = useMemo(
    () => deriveDevices(ioProfiles),
    [ioProfiles],
  );

  const hasFramelinkProfiles = useMemo(
    () => ioProfiles.some((p: IOProfile) => p.kind === "framelink"),
    [ioProfiles],
  );

  const {
    device,
    activeTab,
    error,
    statusBar,
    loading,
    setActiveTab,
    connectDevice,
    disconnectDevice,
    refreshTab,
    persistSave,
    clearError,
  } = useRulesStore(
    useShallow((s) => ({
      device: s.device,
      activeTab: s.activeTab,
      error: s.error,
      statusBar: s.statusBar,
      loading: s.loading,
      setActiveTab: s.setActiveTab,
      connectDevice: s.connectDevice,
      disconnectDevice: s.disconnectDevice,
      refreshTab: s.refreshTab,
      persistSave: s.persistSave,
      clearError: s.clearError,
    })),
  );

  // Auto-connect when exactly one framelink device exists.
  // Check latest store state (not closure) to avoid double-connect from
  // React strict mode or effect re-fires.
  useEffect(() => {
    if (framelinkDevices.length !== 1) return;
    const current = useRulesStore.getState().device;
    if (current) return; // already connecting or connected
    const d = framelinkDevices[0];
    connectDevice(d.host, d.port, d.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framelinkDevices]);

  const handleDeviceChange = useCallback(
    (selectedDeviceId: string) => {
      const target = framelinkDevices.find((d) => d.deviceId === selectedDeviceId);
      if (!target) return;
      disconnectDevice();
      connectDevice(target.host, target.port, target.label);
    },
    [framelinkDevices, connectDevice, disconnectDevice],
  );

  const handlePersist = useCallback(async () => {
    try {
      await persistSave();
    } catch (e) {
      // Error is set in store
    }
  }, [persistSave]);

  const isAnyLoading = Object.values(loading).some(Boolean);

  const topBar = (
    <AppTopBar
      icon={Workflow}
      iconColour="text-indigo-400"
      title="Rules"
      actions={
        <div className="flex items-center gap-2">
          {/* Device selector */}
          {framelinkDevices.length > 1 && (
            <select
              className={`text-xs px-2 py-1 rounded ${bgSurface} ${borderDefault} ${textPrimary}`}
              onChange={(e) => handleDeviceChange(e.target.value)}
              value={device?.deviceId ?? ""}
            >
              <option value="">Select device...</option>
              {framelinkDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          )}

          {/* Connection status */}
          {device && (
            <span
              className={`text-xs ${device.connected ? "text-green-400" : device.connecting ? "text-yellow-400" : "text-red-400"}`}
            >
              {device.connected
                ? device.label
                : device.connecting
                  ? "Connecting..."
                  : "Disconnected"}
            </span>
          )}

          {/* Refresh */}
          {device?.connected && (
            <button
              onClick={() => refreshTab()}
              className={`p-1 rounded hover:bg-white/10 ${textSecondary}`}
              title="Refresh"
              disabled={isAnyLoading}
            >
              <RefreshCw className={`${iconMd} ${isAnyLoading ? "animate-spin" : ""}`} />
            </button>
          )}

          {/* Make Permanent */}
          {device?.connected && (
            <button
              onClick={handlePersist}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-green-600 hover:bg-green-500 text-white"
              title="Persist all rules to device NVS"
            >
              <Save className={iconMd} />
              Make Permanent
            </button>
          )}
        </div>
      }
    />
  );

  return (
    <AppLayout topBar={topBar}>
      {/* Error banner */}
      {error && (
        <div className="mx-2 mt-1 px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg flex justify-between items-center">
          <span>{error}</span>
          <button onClick={clearError} className="text-red-300 hover:text-red-100 ml-2">
            Dismiss
          </button>
        </div>
      )}

      {/* No devices configured */}
      {!hasFramelinkProfiles && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <div className="text-center">
            <Workflow className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No FrameLink devices configured</p>
            <p className="text-xs mt-1 opacity-60">
              Add a FrameLink profile in the Devices app
            </p>
          </div>
        </div>
      )}

      {/* Connecting */}
      {device?.connecting && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="ml-2 text-sm">Connecting to {device.label}...</span>
        </div>
      )}

      {/* Devices exist but not connected — prompt to select */}
      {hasFramelinkProfiles && !device && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <div className="text-center">
            <Workflow className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Select a FrameLink device to manage rules</p>
            {framelinkDevices.length > 0 && (
              <div className="mt-4 flex flex-col items-center gap-2">
                {framelinkDevices.map((d) => (
                  <button
                    key={d.deviceId}
                    onClick={() => connectDevice(d.host, d.port, d.label)}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connection failed — show retry */}
      {device && !device.connecting && !device.connected && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <div className="text-center">
            <p className="text-sm text-red-400">Failed to connect to {device.label}</p>
            <button
              onClick={() => connectDevice(device.host, device.port, device.label)}
              className="mt-3 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Connected — main content */}
      {device?.connected && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Tab bar */}
          <div className={`flex items-center gap-1 px-2 py-1 border-b ${borderDefault}`}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === tab.id
                    ? "bg-indigo-500/20 text-indigo-300"
                    : `${textSecondary} hover:bg-white/5`
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto p-2">
            {activeTab === "frame-defs" && <FrameDefsView />}
            {activeTab === "bridges" && <BridgesView />}
            {activeTab === "transformers" && <TransformersView />}
            {activeTab === "generators" && <GeneratorsView />}
            {activeTab === "indicators" && <IndicatorsView />}
            {activeTab === "user-signals" && <UserSignalsView />}
            {activeTab === "overview" && <DeviceOverview />}
          </div>

          {/* Status bar */}
          <div className={`flex items-center justify-between px-3 py-1 border-t ${borderDefault} bg-[var(--bg-surface)] text-xs`}>
            {statusBar ? (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    statusBar.type === "success" ? "bg-green-400" :
                    statusBar.type === "error" ? "bg-red-400" :
                    "bg-blue-400 animate-pulse"
                  }`} />
                  <span className={`truncate ${
                    statusBar.type === "error" ? "text-red-400" : textSecondary
                  }`}>
                    {statusBar.text}
                  </span>
                </div>
                <span className={`${textTertiary} shrink-0 ml-3`}>
                  {new Date(statusBar.timestamp).toLocaleTimeString()}
                </span>
              </>
            ) : (
              <span className={textTertiary}>Ready</span>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
