// ui/src/apps/devices/components/DeviceView.tsx
//
// Shell for the per-device tabbed page. Renders the header, the tab strip,
// and the active tab's content (or an explainer if the tab's transport
// isn't available on the current device). All cross-tab plumbing lives
// here — tabs themselves never disconnect, navigate, or reach into other
// tabs' state.

import { Bluetooth, Cable, Globe, HardDriveDownload, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { useDevicesStore, type DeviceTabId } from "../stores/devicesStore";
import DeviceHeader from "./DeviceHeader";
import WifiTab from "../tabs/WifiTab";
import FirmwareTab from "../tabs/FirmwareTab";
import DataIoTab from "../tabs/DataIoTab";

// SMP-over-BLE is currently stubbed in the Rust backend (see
// src-tauri/src/smp_upgrade.rs:199 — pending mcumgr-smp upgrade to
// btleplug 0.12). Connecting via BLE for SMP still grabs the radio though,
// which fights any subsequent bleConnect() in the Wi-Fi tab and panics
// btleplug. Until the dependency is updated, mark Firmware (BLE) as
// unavailable and explain why.
const BLE_SMP_DISABLED = true;

interface TabSpec {
  id: DeviceTabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Whether the tab's transport is reachable for this device. */
  available: boolean;
  /** Reason shown in the explainer panel when unavailable. */
  unavailableReason: string;
}

export default function DeviceView() {
  const { t } = useTranslation("devices");
  const activeTab = useDevicesStore((s) => s.ui.activeTab);
  const setActiveTab = useDevicesStore((s) => s.setActiveTab);
  const capabilities = useDevicesStore((s) => s.data.selectedCapabilities);
  const selectedBleId = useDevicesStore((s) => s.data.selectedBleId);
  const selectedAddress = useDevicesStore((s) => s.data.selectedAddress);
  const selectedSmpPort = useDevicesStore((s) => s.data.selectedSmpPort);
  const selectedFrameLinkPort = useDevicesStore((s) => s.data.selectedFrameLinkPort);

  const hasBle = selectedBleId != null;
  const hasIp = selectedAddress != null;
  const hasWifiProv = capabilities.includes("wifi-provision");
  const hasSmp = capabilities.includes("smp");
  const hasFrameLink = capabilities.includes("framelink");

  const tabs: TabSpec[] = [
    {
      id: "wifi",
      label: t("device.tabs.wifi"),
      icon: Wifi,
      available: hasBle && hasWifiProv,
      unavailableReason: !hasBle
        ? t("device.unavailable.noBle")
        : t("device.unavailable.noWifiProv"),
    },
    {
      id: "firmware-ble",
      label: t("device.tabs.firmwareBle"),
      icon: Bluetooth,
      available: hasBle && hasSmp && !BLE_SMP_DISABLED,
      unavailableReason: BLE_SMP_DISABLED
        ? t("device.unavailable.bleSmpStubbed")
        : !hasBle
          ? t("device.unavailable.noBle")
          : t("device.unavailable.noBleSmp"),
    },
    {
      id: "firmware-ip",
      label: t("device.tabs.firmwareIp"),
      icon: Globe,
      available: hasIp && hasSmp && selectedSmpPort != null,
      unavailableReason: !hasIp
        ? t("device.unavailable.noIp")
        : !hasSmp
          ? t("device.unavailable.noSmpService")
          : t("device.unavailable.noSmpPort"),
    },
    {
      id: "dataio",
      label: t("device.tabs.dataio"),
      icon: Cable,
      available: hasIp && hasFrameLink && selectedFrameLinkPort != null,
      unavailableReason: !hasIp
        ? t("device.unavailable.noIp")
        : !hasFrameLink
          ? t("device.unavailable.noFrameLink")
          : t("device.unavailable.noFrameLinkPort"),
    },
  ];

  const activeSpec = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  return (
    <div className="flex flex-col h-full">
      <DeviceHeader />

      {/* Tab strip */}
      <div role="tablist" className="flex border-b border-[color:var(--border-default)] px-2">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          const baseClasses =
            "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer";
          const activeClasses = isActive
            ? `${textPrimary} border-[color:var(--accent-primary)]`
            : `${textSecondary} border-transparent hover:${textPrimary}`;
          const dimClasses = tab.available ? "" : "opacity-50";
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`${baseClasses} ${activeClasses} ${dimClasses}`}
              title={tab.available ? tab.label : tab.unavailableReason}
            >
              <Icon className={iconMd} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active tab content */}
      <div className="flex-1 overflow-y-auto">
        {!activeSpec.available ? (
          <UnavailableExplainer
            label={activeSpec.label}
            reason={activeSpec.unavailableReason}
            otherTabs={tabs.filter((t) => t.id !== activeSpec.id && t.available)}
            onSwitch={(id) => setActiveTab(id)}
          />
        ) : activeTab === "wifi" ? (
          <WifiTab />
        ) : activeTab === "firmware-ble" ? (
          <FirmwareTab transport="ble" />
        ) : activeTab === "firmware-ip" ? (
          <FirmwareTab transport="ip" />
        ) : (
          <DataIoTab />
        )}
      </div>
    </div>
  );
}

function UnavailableExplainer({
  label,
  reason,
  otherTabs,
  onSwitch,
}: {
  label: string;
  reason: string;
  otherTabs: TabSpec[];
  onSwitch: (id: DeviceTabId) => void;
}) {
  const { t } = useTranslation("devices");
  return (
    <div className="flex flex-col items-center gap-4 p-8 text-center">
      <HardDriveDownload className="w-12 h-12 opacity-40" />
      <div className={`text-base font-medium ${textPrimary}`}>{label}</div>
      <div className={`text-sm ${textSecondary} max-w-sm`}>{reason}</div>
      {otherTabs.length > 0 && (
        <div className="flex flex-col items-center gap-2 mt-2">
          <div className={`text-xs ${textSecondary}`}>{t("device.unavailable.try")}</div>
          <div className="flex flex-wrap justify-center gap-2">
            {otherTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => onSwitch(tab.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-[color:var(--border-default)] ${textPrimary} hover:bg-[var(--bg-surface)] transition-colors cursor-pointer`}
                >
                  <Icon className={iconMd} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
