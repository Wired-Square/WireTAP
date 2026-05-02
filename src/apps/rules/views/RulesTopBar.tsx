// src/apps/rules/views/RulesTopBar.tsx
//
// Top bar for the Rules app. Mirrors the DiscoveryTopBar / DecoderTopBar
// pattern (single AppTopBar row, custom identity picker, action buttons on
// the right).

import { Workflow, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
// Title intentionally omitted to match the icon-only top-nav of Discovery /
// Decoder / Transmit.
import FrameLinkDevicePicker, {
  type FramelinkDevice,
} from "../../../components/FrameLinkDevicePicker";
import type { FrameLinkLiveness } from "../../../hooks/useFrameLinkDeviceLiveness";
import {
  iconButtonBase,
  actionChip,
  dangerButtonBase,
} from "../../../styles/buttonStyles";
import { iconMd } from "../../../styles/spacing";

export type RulesActiveState = "connecting" | "connected" | "error" | null;

interface RulesTopBarProps {
  // Identity / picker
  devices: FramelinkDevice[];
  activeDeviceId: string | null;
  activeState: RulesActiveState;
  livenessByDeviceId: Map<string, FrameLinkLiveness>;
  livenessByHostPort: Map<string, FrameLinkLiveness>;
  onSelectDevice: (device: FramelinkDevice) => void;
  onProbeDevice: (device: FramelinkDevice) => void;

  // Action buttons (only meaningful when connected)
  isConnected: boolean;
  isLoading: boolean;
  onRefresh: () => void;
  onPersist: () => void;

  // Two-step clear
  confirmClear: boolean;
  onClearConfig: () => void;
}

export default function RulesTopBar({
  devices,
  activeDeviceId,
  activeState,
  livenessByDeviceId,
  livenessByHostPort,
  onSelectDevice,
  onProbeDevice,
  isConnected,
  isLoading,
  onRefresh,
  onPersist,
  confirmClear,
  onClearConfig,
}: RulesTopBarProps) {
  const { t } = useTranslation("rules");

  return (
    <AppTopBar
      icon={Workflow}
      iconColour="text-indigo-400"
      actions={
        isConnected ? (
          <>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className={iconButtonBase}
              title={t("topBar.refresh")}
            >
              <RefreshCw className={`${iconMd} ${isLoading ? "animate-spin" : ""}`} />
            </button>

            <button
              type="button"
              onClick={onPersist}
              className={actionChip("green")}
              title={t("topBar.persistTooltip")}
            >
              <Save className={iconMd} />
              {t("topBar.makePermanent")}
            </button>

            <button
              type="button"
              onClick={onClearConfig}
              className={
                confirmClear
                  ? `${dangerButtonBase} gap-1 px-2 py-0.5 text-xs rounded`
                  : actionChip("red")
              }
              title={t("topBar.clearConfigTooltip")}
            >
              <Trash2 className={iconMd} />
              {confirmClear ? t("topBar.confirmClear") : t("topBar.clearConfig")}
            </button>
          </>
        ) : null
      }
    >
      <FrameLinkDevicePicker
        devices={devices}
        activeDeviceId={activeDeviceId}
        activeState={activeState}
        livenessByDeviceId={livenessByDeviceId}
        livenessByHostPort={livenessByHostPort}
        onSelect={onSelectDevice}
        onProbe={onProbeDevice}
      />
    </AppTopBar>
  );
}
