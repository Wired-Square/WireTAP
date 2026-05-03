// src/apps/serial/Serial.tsx
//
// Serial app shell. Two tabs:
//   - Terminal: bidirectional ANSI terminal over the chosen serial port
//   - Flash: unified firmware flasher (ESP32 / STM32 UART / STM32 DFU),
//            driven by the active driver record from the flasher registry
//
// Talks to the port directly through the `serial_terminal_*` commands —
// no IO sessions / multi-source broker / ad-hoc profile machinery. The
// shared SerialPortPicker in the top nav drives connect/disconnect for
// the terminal and device selection for the Flash view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as TerminalIcon, Cpu, Plug } from "lucide-react";
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
import { flasherDfuListDevices } from "../../api/flashers";
import { useSerialStore, type SerialTab } from "./stores/serialStore";
import { useFlasherStore } from "./stores/flasherStore";
import { useSerialPortPicker } from "./hooks/useSerialPortPicker";
import { useSerialTerminal } from "./hooks/useSerialTerminal";
import SerialTopBar from "./views/SerialTopBar";
import SerialTerminalView, {
  type SerialTerminalHandle,
} from "./views/SerialTerminalView";
import FlashView from "./views/FlashView";

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
  const dfuDevices = useSerialStore((s) => s.dfuDevices);
  const setDfuDevices = useSerialStore((s) => s.setDfuDevices);
  const dfuSerial = useSerialStore((s) => s.dfuSerial);
  const setDfuSerial = useSerialStore((s) => s.setDfuSerial);
  const flashTarget = useSerialStore((s) => s.flashTarget);
  const setFlashTarget = useSerialStore((s) => s.setFlashTarget);

  // DFU enumeration: refreshed when the picker popover opens. Keep a busy
  // flag so the picker can render a spinner inline.
  const [dfuLoading, setDfuLoading] = useState(false);
  const refreshDfu = useCallback(async () => {
    setDfuLoading(true);
    try {
      const list = await flasherDfuListDevices();
      setDfuDevices(list);
      // Drop a stale selection if the device is no longer plugged in.
      if (dfuSerial && !list.some((d) => d.serial === dfuSerial)) {
        setDfuSerial(null);
      }
    } catch (err) {
      tlog.info(`[Serial/DFU] enumerate failed: ${err}`);
    } finally {
      setDfuLoading(false);
    }
  }, [dfuSerial, setDfuDevices, setDfuSerial]);

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
  // Picking a port also flips the Flash target back to serial.
  const handleSelectPort = useCallback(
    (portName: string, _matched: string | null) => {
      setPort(portName);
      setFlashTarget("serial");
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
    [portPicker.ports, setPort, setFlashTarget, setSerialSettings],
  );

  // Picking a DFU device flips the Flash target onto the USB device.
  const handleSelectDfu = useCallback(
    (serial: string) => {
      setDfuSerial(serial);
      setFlashTarget("dfu");
    },
    [setDfuSerial, setFlashTarget],
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

  // Port hand-off for any flash operation: when the unified Flash view
  // kicks off a flash, backup, erase, or chip detect, we need the port
  // exclusively. Remember whether the terminal was open at the time and
  // reopen it once the op settles — so swapping between Terminal and
  // Flash tabs feels seamless.
  const restoreTerminalAfterFlash = useRef(false);
  const handleBeforeFlash = useCallback(async () => {
    restoreTerminalAfterFlash.current = terminal.isOpen;
    if (terminal.isOpen) {
      await terminal.close();
    }
  }, [terminal]);

  const flashPhase = useFlasherStore((s) => s.flash.phase);
  const prevFlashPhaseRef = useRef(flashPhase);
  useEffect(() => {
    const prev = prevFlashPhaseRef.current;
    prevFlashPhaseRef.current = flashPhase;
    const wasBusy =
      prev === "connecting" ||
      prev === "erasing" ||
      prev === "writing" ||
      prev === "verifying";
    const isSettled =
      flashPhase === "done" ||
      flashPhase === "error" ||
      flashPhase === "cancelled" ||
      flashPhase === "idle";
    if (wasBusy && isSettled && restoreTerminalAfterFlash.current) {
      restoreTerminalAfterFlash.current = false;
      void handleConnect();
    }
  }, [flashPhase, handleConnect]);

  // Refresh the terminal binding (write callback) whenever the terminal id
  // changes — passes a stable function reference to xterm.
  const writeFn = useMemo(() => {
    if (!terminal.isOpen) return null;
    return (bytes: number[]) => terminal.write(bytes);
  }, [terminal.isOpen, terminal]);

  const tabs = useMemo<{ id: SerialTab; label: string; icon: typeof TerminalIcon }[]>(
    () => [
      { id: "terminal", label: t("tabs.terminal"), icon: TerminalIcon },
      { id: "flash", label: t("tabs.flash"), icon: Cpu },
    ],
    [t],
  );

  // The picker shows the active device based on the current tab and flash
  // target. Terminal tab is always serial; Flash tab follows whichever
  // kind of device the user last picked.
  const pickerMode = activeTab === "flash" && flashTarget === "dfu"
    ? "dfu"
    : "serial";

  // Which DFU device is "active" (flowing through to the Flash view).
  const activeDfuDevice = useMemo(
    () => dfuDevices.find((d) => d.serial === dfuSerial) ?? null,
    [dfuDevices, dfuSerial],
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
          pickerMode={pickerMode}
          dfuDevices={dfuDevices}
          activeDfu={dfuSerial}
          dfuLoading={dfuLoading}
          onRefreshDfu={refreshDfu}
          onSelectDfu={handleSelectDfu}
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
        {activeTab === "flash" && (
          <FlashView
            serialPort={flashTarget === "serial" ? settingsState.port : null}
            dfuDevice={flashTarget === "dfu" ? activeDfuDevice : null}
            isTerminalOpen={terminal.isOpen}
            onBeforeFlash={handleBeforeFlash}
          />
        )}
      </div>
    </AppLayout>
  );
}
