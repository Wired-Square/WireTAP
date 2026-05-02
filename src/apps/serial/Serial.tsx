// ui/src/apps/serial/Serial.tsx
//
// Serial terminal app. Three tabs:
//   - Terminal: bidirectional ANSI terminal over the chosen serial port
//   - ESP32 Flash: esptool-style flasher driven by the same UART
//   - STM32 DFU: dfu-util style flasher over raw USB
//
// Talks to the port directly through the `serial_terminal_*` commands —
// no IO sessions / multi-source broker / ad-hoc profile machinery. The
// shared SerialPortPicker in the top nav drives connect/disconnect.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Terminal as TerminalIcon, Cpu, Usb, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppLayout from "../../components/AppLayout";
import {
  bgSurface,
  borderDivider,
  dataViewContainer,
  textSecondary,
  textPrimary,
  textMuted,
} from "../../styles/colourTokens";
import { iconSm } from "../../styles/spacing";
import { useSettings } from "../../hooks/useSettings";
import { tlog } from "../../api/settings";
import { useSerialStore, type SerialTab } from "./stores/serialStore";
import { useSerialPortPicker } from "./hooks/useSerialPortPicker";
import { useSerialTerminal } from "./hooks/useSerialTerminal";
import SerialTopBar from "./views/SerialTopBar";
import SerialTerminalView, {
  type SerialTerminalHandle,
} from "./views/SerialTerminalView";
import EspFlashView from "./views/EspFlashView";
import DfuFlashView from "./views/DfuFlashView";

export default function Serial() {
  const { t } = useTranslation("serial");
  const { settings } = useSettings();
  const ioProfiles = settings?.io_profiles ?? [];

  const activeTab = useSerialStore((s) => s.activeTab);
  const setActiveTab = useSerialStore((s) => s.setActiveTab);
  const setPort = useSerialStore((s) => s.setPort);
  const settingsState = useSerialStore((s) => s.settings);
  const setSerialSettings = useSerialStore((s) => s.setSettings);
  const localEcho = useSerialStore((s) => s.localEcho);
  const setLocalEcho = useSerialStore((s) => s.setLocalEcho);

  const terminalRef = useRef<SerialTerminalHandle | null>(null);

  const handleData = useCallback((bytes: Uint8Array) => {
    terminalRef.current?.writeBytes(bytes);
  }, []);

  const terminal = useSerialTerminal({
    onData: handleData,
    onError: (msg) => tlog.info(`[Serial] terminal error: ${msg}`),
  });

  const portPicker = useSerialPortPicker(ioProfiles);

  // When the user picks a port that matches a saved profile, pull its
  // saved framing in as defaults so the picker shows the right values.
  const handleSelectPort = useCallback(
    (portName: string, _matched: string | null) => {
      setPort(portName);
      const profile = portPicker.ports.find(
        (p) => p.info.port_name === portName,
      )?.profile;
      if (profile) {
        const baud = Number(profile.connection.baud_rate ?? 115200);
        const dataBits = Number(profile.connection.data_bits ?? 8) as
          | 5
          | 6
          | 7
          | 8;
        const stopBits = Number(profile.connection.stop_bits ?? 1) as 1 | 2;
        const parity = (profile.connection.parity ?? "none") as
          | "none"
          | "odd"
          | "even";
        setSerialSettings({ baudRate: baud, dataBits, stopBits, parity });
      }
    },
    [portPicker.ports, setPort, setSerialSettings],
  );

  const handleConnect = useCallback(async () => {
    const s = useSerialStore.getState().settings;
    if (!s.port) return;
    try {
      await terminal.open({
        port: s.port,
        baudRate: s.baudRate,
        dataBits: s.dataBits,
        stopBits: s.stopBits,
        parity: s.parity,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial] open failed: ${msg}`);
    }
  }, [terminal]);

  const handleDisconnect = useCallback(async () => {
    await terminal.close();
    terminalRef.current?.clear();
  }, [terminal]);

  // Refresh the terminal binding (write callback) whenever the terminal id
  // changes — passes a stable function reference to xterm.
  const writeFn = useMemo(() => {
    if (!terminal.isOpen) return null;
    return (bytes: number[]) => terminal.write(bytes);
  }, [terminal.isOpen, terminal]);

  useEffect(() => {
    // Surface a console message if a flash tab is going to need the port.
    if (terminal.isOpen && (activeTab === "esp" || activeTab === "dfu")) {
      tlog.debug(
        `[Serial] tab=${activeTab} active while terminal open; flasher will close it`,
      );
    }
  }, [activeTab, terminal.isOpen]);

  const tabs = useMemo<{ id: SerialTab; label: string; icon: typeof TerminalIcon }[]>(
    () => [
      { id: "terminal", label: t("tabs.terminal"), icon: TerminalIcon },
      { id: "esp", label: t("tabs.espFlash"), icon: Cpu },
      { id: "dfu", label: t("tabs.dfuFlash"), icon: Usb },
    ],
    [t],
  );

  return (
    <AppLayout
      topBar={
        <SerialTopBar
          ports={portPicker.ports}
          loading={portPicker.loading}
          error={portPicker.error}
          activePort={settingsState.port}
          isConnected={terminal.isOpen}
          connecting={terminal.isOpening}
          settings={settingsState}
          localEcho={localEcho}
          onRefresh={portPicker.refresh}
          onSelectPort={handleSelectPort}
          onSettingsChange={setSerialSettings}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onReset={() => terminal.reset()}
          onToggleLocalEcho={() => setLocalEcho(!localEcho)}
        />
      }
    >
      <div className={`flex-1 flex flex-col min-h-0 ${dataViewContainer}`}>
        {/* Tab bar inside the viewport (mirrors Modbus / Decoder pattern) */}
        <div
          className={`flex items-center ${borderDivider} border-b ${bgSurface}`}
        >
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? `${textPrimary} border-b-2 border-sky-400`
                    : `${textSecondary} hover:text-[color:var(--text-primary)]`
                }`}
              >
                <TabIcon className={iconSm} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        {activeTab === "terminal" && (
          <div className="flex-1 flex flex-col min-h-0">
            {!terminal.isOpen ? (
              <div
                className={`flex-1 flex items-center justify-center text-xs ${textMuted} gap-2`}
              >
                <Plug className={iconSm} />
                {t("terminal.emptyState")}
              </div>
            ) : (
              <SerialTerminalView
                ref={terminalRef}
                write={writeFn}
                localEcho={localEcho}
              />
            )}
          </div>
        )}
        {activeTab === "esp" && (
          <EspFlashView onBeforeFlash={handleDisconnect} />
        )}
        {activeTab === "dfu" && <DfuFlashView />}
      </div>
    </AppLayout>
  );
}
