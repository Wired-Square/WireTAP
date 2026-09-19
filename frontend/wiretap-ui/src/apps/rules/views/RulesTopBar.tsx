// src/apps/rules/views/RulesTopBar.tsx
//
// Top bar for the Rules app. Mirrors the DiscoveryTopBar / DecoderTopBar
// pattern (single AppTopBar row, custom identity picker, action buttons on
// the right).

import { Workflow, RefreshCw, Save, Trash2, Loader2, Check, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
// Title intentionally omitted to match the icon-only top-nav of Discovery /
// Decoder / Transmit.
import FrameLinkDevicePicker, {
  type FramelinkDevice,
} from "../../../components/FrameLinkDevicePicker";
import type { FrameLinkLiveness } from "../../../hooks/useFrameLinkDeviceLiveness";
import { iconMd } from "../../../styles/spacing";
import { Button, IconButton } from "../../../components/Button";

export type RulesActiveState = "connecting" | "connected" | "error" | null;

export type PersistState = "idle" | "saving" | "saved" | "error";

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
  persistState: PersistState;

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
  persistState,
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
            <IconButton
              onClick={onRefresh}
              disabled={isLoading}
              variant="surface"
              title={t("topBar.refresh")}
            >
              <RefreshCw className={`${iconMd} ${isLoading ? "animate-spin" : ""}`} />
            </IconButton>

            <Button
              onClick={onPersist}
              disabled={persistState === "saving"}
              variant="tonal"
              size="sm"
              title={t("topBar.persistTooltip")}
            >
              {persistState === "saving" ? (
                <Loader2 className={`${iconMd} animate-spin`} />
              ) : persistState === "saved" ? (
                <Check className={iconMd} />
              ) : persistState === "error" ? (
                <AlertCircle className={iconMd} />
              ) : (
                <Save className={iconMd} />
              )}
              {persistState === "saving"
                ? t("topBar.saving")
                : persistState === "saved"
                  ? t("topBar.saved")
                  : persistState === "error"
                    ? t("topBar.saveFailed")
                    : t("topBar.makePermanent")}
            </Button>

            <Button
              onClick={onClearConfig}
              variant={confirmClear ? "solid" : "tonal"}
              tone="danger"
              size="sm"
              title={t("topBar.clearConfigTooltip")}
            >
              <Trash2 className={iconMd} />
              {confirmClear ? t("topBar.confirmClear") : t("topBar.clearConfig")}
            </Button>
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
