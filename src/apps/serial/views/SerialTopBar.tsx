// ui/src/apps/serial/views/SerialTopBar.tsx
//
// Top nav for the Serial app. Mirrors the Decoder layout: icon (no text)
// followed by a vertical separator (via AppTopBar's built-in FlexSeparator),
// then the shared SerialPortPicker as the identity control. Right-side
// actions: Local Echo toggle + Reset.

import { useState } from "react";
import {
  Terminal as TerminalIcon,
  RotateCcw,
  EyeOff,
  Eye,
  Plug,
  Unplug,
  CopyPlus,
  Check,
  Minus,
  Plus,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
import SerialPortPicker, {
  type AnnotatedSerialPort,
  type SerialPortSettings,
} from "../../../components/SerialPortPicker";
import type { DfuDeviceInfo } from "../utils/flasherTypes";
import { MIN_TERMINAL_FONT, MAX_TERMINAL_FONT } from "../stores/serialStore";
import { COPY_FEEDBACK_TIMEOUT_MS } from "../../../constants";
import { iconSm } from "../../../styles/spacing";

interface Props {
  ports: AnnotatedSerialPort[];
  loading: boolean;
  error: string | null;
  activePort: string | null;
  isConnected: boolean;
  connecting: boolean;
  settings: SerialPortSettings;
  localEcho: boolean;

  /** When `"dfu"`, the picker button shows the selected DFU device and the
   *  Connect / Echo / Reset actions are hidden — DFU has no persistent
   *  connection. The DFU section in the popover is always visible. */
  pickerMode: "serial" | "dfu";
  dfuDevices: DfuDeviceInfo[];
  activeDfu: string | null;
  dfuLoading: boolean;
  onRefreshDfu: () => void;
  onSelectDfu: (serial: string) => void;

  onRefresh: () => void;
  onSelectPort: (port: string, matchedProfileName: string | null) => void;
  onSettingsChange: (patch: Partial<SerialPortSettings>) => void;
  onConnect: (existingProfileId?: string) => void;
  onDisconnect: () => void;
  onReset: () => void;
  onToggleLocalEcho: () => void;
  onCopyAll: () => Promise<boolean>;
  fontSize: number;
  onIncreaseFont: () => void;
  onDecreaseFont: () => void;
}

export default function SerialTopBar({
  ports,
  loading,
  error,
  activePort,
  isConnected,
  connecting,
  settings,
  localEcho,
  pickerMode,
  dfuDevices,
  activeDfu,
  dfuLoading,
  onRefreshDfu,
  onSelectDfu,
  onRefresh,
  onSelectPort,
  onSettingsChange,
  onConnect,
  onDisconnect,
  onReset,
  onToggleLocalEcho,
  onCopyAll,
  fontSize,
  onIncreaseFont,
  onDecreaseFont,
}: Props) {
  const { t } = useTranslation("serial");
  const [copiedAll, setCopiedAll] = useState(false);

  const handleCopyAll = async () => {
    if (await onCopyAll()) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), COPY_FEEDBACK_TIMEOUT_MS);
    }
  };

  // The Connect / Disconnect / Echo / Reset actions only apply in serial
  // mode. In DFU mode the picker is just a selector — flashing kicks off
  // from the DFU tab's Flash button, and there's no persistent connection.
  const showSerialActions = pickerMode === "serial";

  return (
    <AppTopBar
      icon={TerminalIcon}
      iconColour="text-sky-400"
      actions={showSerialActions ? (
        <div className="flex items-center gap-1">
          {isConnected ? (
            <button
              onClick={onDisconnect}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded text-red-300 hover:bg-red-500/20 transition-colors"
              title={t("topBar.disconnectTooltip")}
            >
              <Unplug className={iconSm} />
              {t("topBar.disconnect")}
            </button>
          ) : (
            <button
              onClick={() => onConnect()}
              disabled={!activePort || connecting}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                activePort
                  ? t("topBar.connectTooltip")
                  : t("topBar.connectNoPortTooltip")
              }
            >
              <Plug className={iconSm} />
              {connecting ? t("topBar.connecting") : t("topBar.connect")}
            </button>
          )}
          {isConnected && (
            <>
              <button
                onClick={onToggleLocalEcho}
                className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded transition-colors ${
                  localEcho
                    ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30"
                    : "text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)]"
                }`}
                title={
                  localEcho
                    ? t("topBar.echoTooltipOn")
                    : t("topBar.echoTooltipOff")
                }
              >
                {localEcho ? (
                  <Eye className={iconSm} />
                ) : (
                  <EyeOff className={iconSm} />
                )}
                {localEcho ? t("topBar.echoOn") : t("topBar.echoOff")}
              </button>
              <div className="flex items-center gap-0.5 rounded bg-[var(--bg-surface)] px-0.5">
                <button
                  onClick={onDecreaseFont}
                  disabled={fontSize <= MIN_TERMINAL_FONT}
                  className="flex items-center justify-center p-1 rounded text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t("topBar.fontDecrease")}
                >
                  <Minus className={iconSm} />
                </button>
                <span className="text-xs tabular-nums text-center w-5 text-[color:var(--text-secondary)]">
                  {fontSize}
                </span>
                <button
                  onClick={onIncreaseFont}
                  disabled={fontSize >= MAX_TERMINAL_FONT}
                  className="flex items-center justify-center p-1 rounded text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t("topBar.fontIncrease")}
                >
                  <Plus className={iconSm} />
                </button>
              </div>
              <button
                onClick={handleCopyAll}
                className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded transition-colors ${
                  copiedAll
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)]"
                }`}
                title={t("topBar.copyAllTooltip")}
              >
                {copiedAll ? (
                  <Check className={iconSm} />
                ) : (
                  <CopyPlus className={iconSm} />
                )}
                {copiedAll ? t("topBar.copiedAll") : t("topBar.copyAll")}
              </button>
              <button
                onClick={onReset}
                className="flex items-center gap-1 text-xs px-2 py-1.5 rounded text-amber-300 hover:bg-amber-500/20 transition-colors"
                title={t("topBar.resetTooltip")}
              >
                <RotateCcw className={iconSm} />
                {t("topBar.reset")}
              </button>
            </>
          )}
        </div>
      ) : null}
    >
      <SerialPortPicker
        ports={ports}
        loading={loading}
        error={error}
        activePort={activePort}
        isConnected={isConnected}
        connecting={connecting}
        settings={settings}
        onRefresh={onRefresh}
        onSelectPort={onSelectPort}
        onSettingsChange={onSettingsChange}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        mode={pickerMode}
        dfuDevices={dfuDevices}
        activeDfu={activeDfu}
        dfuLoading={dfuLoading}
        onRefreshDfu={onRefreshDfu}
        onSelectDfu={onSelectDfu}
      />
    </AppTopBar>
  );
}
