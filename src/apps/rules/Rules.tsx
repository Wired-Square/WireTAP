// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useCallback, useState } from "react";
import { Workflow, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import AppLayout from "../../components/AppLayout";
import { useSettingsStore } from "../settings/stores/settingsStore";
import { useRulesStore, type RulesTab } from "./stores/rulesStore";
import {
  textTertiary,
  bgDanger,
  borderDanger,
  textDanger,
  bgDataView,
  bgDataToolbar,
  borderDataView,
  dataViewContainer,
} from "../../styles";
import { dataViewTabClass } from "../../styles/buttonStyles";
import RulesTopBar, { type RulesActiveState } from "./views/RulesTopBar";
import {
  useFrameLinkDeviceLiveness,
} from "../../hooks/useFrameLinkDeviceLiveness";
import type { FramelinkDevice } from "../../components/FrameLinkDevicePicker";
import FrameDefsView from "./views/FrameDefsView";
import BridgesView from "./views/BridgesView";
import TransformersView from "./views/TransformersView";
import GeneratorsView from "./views/GeneratorsView";
import UserSignalsView from "./views/UserSignalsView";
import IndicatorsView from "./views/IndicatorsView";
import DeviceOverview from "./views/DeviceOverview";
import LogView from "./views/LogView";
import type { IOProfile } from "../../hooks/useSettings";

const TAB_KEYS: { id: RulesTab; i18nKey: string }[] = [
  { id: "frame-defs", i18nKey: "frameDefs" },
  { id: "bridges", i18nKey: "bridges" },
  { id: "transformers", i18nKey: "transformers" },
  { id: "generators", i18nKey: "generators" },
  { id: "indicators", i18nKey: "indicators" },
  { id: "user-signals", i18nKey: "userSignals" },
  { id: "overview", i18nKey: "overview" },
  { id: "log", i18nKey: "log" },
];

/** Extract unique FrameLink devices from profiles. */
function deriveDevices(profiles: IOProfile[]): FramelinkDevice[] {
  const devices: FramelinkDevice[] = [];
  for (const p of profiles) {
    if (p.kind !== "framelink") continue;
    const host = p.connection?.host as string | undefined;
    if (!host) continue;
    const port = Number(p.connection?.port) || 120;
    const did = (p.connection?.device_id as string) ?? `${host}:${port}`;
    devices.push({ deviceId: did, host, port, label: p.name || did });
  }
  return devices;
}

export default function Rules() {
  const { t } = useTranslation("rules");
  const ioProfiles = useSettingsStore((s) => s.ioProfiles.profiles);

  const framelinkDevices = useMemo(
    () => deriveDevices(ioProfiles),
    [ioProfiles],
  );

  const hasFramelinkProfiles = framelinkDevices.length > 0;

  const {
    device,
    activeTab,
    error,
    loading,
    setActiveTab,
    connectDevice,
    disconnectDevice,
    refreshTab,
    persistSave,
    persistClear,
    clearError,
  } = useRulesStore(
    useShallow((s) => ({
      device: s.device,
      activeTab: s.activeTab,
      error: s.error,
      loading: s.loading,
      setActiveTab: s.setActiveTab,
      connectDevice: s.connectDevice,
      disconnectDevice: s.disconnectDevice,
      refreshTab: s.refreshTab,
      persistSave: s.persistSave,
      persistClear: s.persistClear,
      clearError: s.clearError,
    })),
  );

  const { livenessByDeviceId, livenessByHostPort, probe } =
    useFrameLinkDeviceLiveness();

  // Auto-connect when exactly one framelink device exists.
  // Check latest store state (not closure) to avoid double-connect from
  // React strict mode or effect re-fires.
  useEffect(() => {
    if (framelinkDevices.length !== 1) return;
    const current = useRulesStore.getState().device;
    if (current) return;
    const d = framelinkDevices[0];
    connectDevice(d.host, d.port, d.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framelinkDevices]);

  const handleSelectDevice = useCallback(
    (target: FramelinkDevice) => {
      if (device?.deviceId === target.deviceId) return;
      disconnectDevice();
      connectDevice(target.host, target.port, target.label);
    },
    [device, connectDevice, disconnectDevice],
  );

  const handleProbeDevice = useCallback(
    (target: FramelinkDevice) => {
      void probe(target.deviceId, target.host, target.port);
    },
    [probe],
  );

  const handlePersist = useCallback(async () => {
    try {
      await persistSave();
    } catch {
      // Inline statusBar / banner already reflect the failure.
    }
  }, [persistSave]);

  const [confirmClear, setConfirmClear] = useState(false);
  const handleClearConfig = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    try {
      await persistClear();
    } catch {
      // Inline statusBar / banner already reflect the failure.
    }
  }, [confirmClear, persistClear]);

  const isAnyLoading = Object.values(loading).some(Boolean);

  const activeState: RulesActiveState = device?.connecting
    ? "connecting"
    : device?.connected
      ? "connected"
      : device && device.error
        ? "error"
        : null;

  const topBar = (
    <RulesTopBar
      devices={framelinkDevices}
      activeDeviceId={device?.deviceId ?? null}
      activeState={activeState}
      livenessByDeviceId={livenessByDeviceId}
      livenessByHostPort={livenessByHostPort}
      onSelectDevice={handleSelectDevice}
      onProbeDevice={handleProbeDevice}
      isConnected={!!device?.connected}
      isLoading={isAnyLoading}
      onRefresh={() => refreshTab()}
      onPersist={handlePersist}
      confirmClear={confirmClear}
      onClearConfig={handleClearConfig}
    />
  );

  return (
    <AppLayout topBar={topBar}>
      {/* Inline recoverable error banner */}
      {error && (
        <div
          className={`mx-2 mt-1 px-3 py-2 text-xs rounded-lg flex justify-between items-center border ${bgDanger} ${borderDanger} ${textDanger}`}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="ml-2 underline hover:brightness-125"
          >
            {t("topBar.dismiss", "Dismiss")}
          </button>
        </div>
      )}

      {/* No devices configured */}
      {!hasFramelinkProfiles && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <div className="text-center">
            <Workflow className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t("states.noDevices")}</p>
            <p className="text-xs mt-1 opacity-60">
              {t("states.noDevicesHint", "Add a FrameLink profile in the Devices app")}
            </p>
          </div>
        </div>
      )}

      {/* Connecting */}
      {device?.connecting && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <Loader2 className="w-6 h-6 animate-spin" />
          <span className="ml-2 text-sm">
            {t("states.connectingTo", { label: device.label, defaultValue: "Connecting to {{label}}…" })}
          </span>
        </div>
      )}

      {/* Devices configured but none active — prompt to use the picker */}
      {hasFramelinkProfiles && !device && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <div className="text-center">
            <Workflow className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t("states.selectDevice")}</p>
            <p className="text-xs mt-1 opacity-60">
              {t("states.selectDeviceHint", "Use the device picker in the top bar.")}
            </p>
          </div>
        </div>
      )}

      {/* Connection failed — show retry */}
      {device && !device.connecting && !device.connected && (
        <div className={`flex-1 flex items-center justify-center ${textTertiary}`}>
          <div className="text-center">
            <p className={`text-sm ${textDanger}`}>
              {t("states.connectFailed", { label: device.label, defaultValue: "Failed to connect to {{label}}" })}
            </p>
            <button
              type="button"
              onClick={() => connectDevice(device.host, device.port, device.label)}
              className="mt-3 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              {t("states.retry", "Retry")}
            </button>
          </div>
        </div>
      )}

      {/* Connected — main content (data-view bubble) */}
      {device?.connected && (
        <div className={`flex flex-col flex-1 min-h-0 ${dataViewContainer}`}>
          {/* Tab bar — uses the shared dataViewTabClass styling */}
          <div
            className={`flex-shrink-0 flex items-center px-1 border-b ${borderDataView} ${bgDataToolbar}`}
          >
            {TAB_KEYS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={dataViewTabClass(activeTab === tab.id)}
              >
                {t(`tabs.${tab.i18nKey}`)}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div
            className={`flex-1 min-h-0 overflow-auto overscroll-none p-4 rounded-b-lg ${bgDataView}`}
          >
            {activeTab === "frame-defs" && <FrameDefsView />}
            {activeTab === "bridges" && <BridgesView />}
            {activeTab === "transformers" && <TransformersView />}
            {activeTab === "generators" && <GeneratorsView />}
            {activeTab === "indicators" && <IndicatorsView />}
            {activeTab === "user-signals" && <UserSignalsView />}
            {activeTab === "overview" && <DeviceOverview />}
            {activeTab === "log" && <LogView />}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
