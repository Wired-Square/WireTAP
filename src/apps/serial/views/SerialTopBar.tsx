// ui/src/apps/serial/views/SerialTopBar.tsx
//
// Top nav for the Serial app. Mirrors the Decoder layout: icon (no text)
// followed by a vertical separator (via AppTopBar's built-in FlexSeparator),
// then the shared SerialPortPicker as the identity control. Right-side
// actions: Local Echo toggle + Reset.

import {
  Terminal as TerminalIcon,
  RotateCcw,
  EyeOff,
  Eye,
  Plug,
  Unplug,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
import SerialPortPicker, {
  type AnnotatedSerialPort,
  type SerialPortSettings,
} from "../../../components/SerialPortPicker";
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

  onRefresh: () => void;
  onSelectPort: (port: string, matchedProfileName: string | null) => void;
  onSettingsChange: (patch: Partial<SerialPortSettings>) => void;
  onConnect: (existingProfileId?: string) => void;
  onDisconnect: () => void;
  onReset: () => void;
  onToggleLocalEcho: () => void;
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
  onRefresh,
  onSelectPort,
  onSettingsChange,
  onConnect,
  onDisconnect,
  onReset,
  onToggleLocalEcho,
}: Props) {
  const { t } = useTranslation("serial");

  return (
    <AppTopBar
      icon={TerminalIcon}
      iconColour="text-sky-400"
      actions={
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
      }
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
      />
    </AppTopBar>
  );
}
