// ui/src/apps/transmit/Transmit.tsx
//
// Main Transmit app component with tabbed interface for CAN/Serial transmission.
// Uses useIOSessionManager for session management and useTransmitHandlers for business logic.

import { useEffect, useCallback, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Send, AlertCircle } from "lucide-react";
import { useTransmitStore } from "../../stores/transmitStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useSettings, type IOProfile } from "../../hooks/useSettings";
import { useTransmitHandlers } from "./hooks/useTransmitHandlers";
import type { TransmitHistoryEvent, SerialTransmitHistoryEvent, RepeatStoppedEvent } from "../../api/transmit";
import {
  bgDarkView,
  bgDarkToolbar,
  borderDarkView,
  textDarkMuted,
} from "../../styles/colourTokens";
import { dataViewTabClass, tabCountColorClass } from "../../styles/buttonStyles";
import ProtocolBadge from "../../components/ProtocolBadge";
import TransmitTopBar from "./views/TransmitTopBar";
import CanTransmitView from "./views/CanTransmitView";
import SerialTransmitView from "./views/SerialTransmitView";
import TransmitQueueView from "./views/TransmitQueueView";
import TransmitHistoryView from "./views/TransmitHistoryView";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";

// ============================================================================
// Helper: Check if a profile can transmit
// ============================================================================

function getTransmitStatus(p: IOProfile): { canTransmit: boolean; reason?: string } {
  // slcan in normal mode can transmit
  if (p.kind === "slcan") {
    if (p.connection?.silent_mode) {
      return { canTransmit: false, reason: "Silent mode enabled" };
    }
    return { canTransmit: true };
  }
  // gvret_tcp and gvret_usb can transmit
  if (p.kind === "gvret_tcp" || p.kind === "gvret_usb") {
    return { canTransmit: true };
  }
  // gs_usb can transmit if not in listen-only mode
  if (p.kind === "gs_usb") {
    if (p.connection?.listen_only !== false) {
      return { canTransmit: false, reason: "Listen-only mode" };
    }
    return { canTransmit: true };
  }
  // socketcan can transmit
  if (p.kind === "socketcan") {
    return { canTransmit: true };
  }
  // serial ports can transmit serial data
  if (p.kind === "serial") {
    return { canTransmit: true };
  }
  return { canTransmit: false, reason: "Not a transmit interface" };
}

// ============================================================================
// Component
// ============================================================================

export default function Transmit() {
  // Settings for IO profiles
  const { settings } = useSettings();
  const ioProfiles = settings?.io_profiles ?? [];

  // Get all CAN/serial profiles that could potentially be used for transmit
  const transmitProfiles = useMemo(
    () =>
      ioProfiles.filter((p) => {
        if (p.kind === "slcan") return true;
        if (p.kind === "gvret_tcp" || p.kind === "gvret_usb") return true;
        if (p.kind === "gs_usb") return true;
        if (p.kind === "socketcan") return true;
        if (p.kind === "serial") return true;
        return false;
      }),
    [ioProfiles]
  );

  // Map of profile ID to transmit status (for passing to dialog)
  const transmitStatusMap = useMemo(
    () => new Map(transmitProfiles.map((p) => [p.id, getTransmitStatus(p)])),
    [transmitProfiles]
  );

  // Store selectors
  const profiles = useTransmitStore((s) => s.profiles);
  const activeTab = useTransmitStore((s) => s.activeTab);
  const queue = useTransmitStore((s) => s.queue);
  const history = useTransmitStore((s) => s.history);
  const transmitError = useTransmitStore((s) => s.error);
  const isLoading = useTransmitStore((s) => s.isLoading);

  // Store actions
  const loadProfiles = useTransmitStore((s) => s.loadProfiles);
  const cleanup = useTransmitStore((s) => s.cleanup);
  const clearError = useTransmitStore((s) => s.clearError);

  // Dialog state
  const [showIoPickerDialog, setShowIoPickerDialog] = useState(false);

  // Error handler for session errors
  const handleError = useCallback((error: string) => {
    console.error("[Transmit] Session error:", error);
  }, []);

  // Use centralized IO session manager
  const manager = useIOSessionManager({
    appName: "transmit",
    ioProfiles: transmitProfiles,
    onError: handleError,
  });

  // Destructure manager state
  const {
    ioProfile,
    setIoProfile,
    ioProfileName,
    multiBusMode,
    multiBusProfiles,
    setMultiBusMode,
    setMultiBusProfiles,
    effectiveSessionId,
    session,
    isStreaming,
    isPaused,
    isStopped,
    sessionReady,
    capabilities,
    joinerCount,
    isDetached,
    handleDetach: managerDetach,
    handleRejoin: managerRejoin,
    startMultiBusSession,
  } = manager;

  // Session controls
  const { start, stop, leave, rejoin, reinitialize } = session;

  // Derive connected state
  const isConnected = sessionReady && (isStreaming || isPaused || isStopped);

  // Compose all handlers using the orchestrator hook
  const handlers = useTransmitHandlers({
    multiBusMode,
    isStreaming,
    sessionReady,
    setMultiBusMode,
    setMultiBusProfiles,
    setIoProfile,
    reinitialize,
    start,
    stop,
    leave,
    rejoin,
    managerDetach,
    managerRejoin,
    startMultiBusSession,
    setShowIoPickerDialog,
  });

  // Load profiles on mount
  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Listen for transmit history events from repeat transmissions
  const addHistoryItem = useTransmitStore((s) => s.addHistoryItem);
  const markRepeatStopped = useTransmitStore((s) => s.markRepeatStopped);
  useEffect(() => {
    // CAN transmit history events
    const unlistenCan = listen<TransmitHistoryEvent>("transmit-history", (event) => {
      const data = event.payload;
      const profileName = ioProfileName ?? data.session_id;
      addHistoryItem({
        timestamp_us: data.timestamp_us,
        profileId: data.session_id,
        profileName,
        type: "can",
        frame: data.frame,
        success: data.success,
        error: data.error,
      });
    });

    // Serial transmit history events
    const unlistenSerial = listen<SerialTransmitHistoryEvent>("serial-transmit-history", (event) => {
      const data = event.payload;
      const profileName = ioProfileName ?? data.session_id;
      addHistoryItem({
        timestamp_us: data.timestamp_us,
        profileId: data.session_id,
        profileName,
        type: "serial",
        bytes: data.bytes,
        success: data.success,
        error: data.error,
      });
    });

    // Repeat stopped events (due to permanent error)
    const unlistenStopped = listen<RepeatStoppedEvent>("repeat-stopped", (event) => {
      const data = event.payload;
      console.warn(`[Transmit] Repeat stopped for ${data.queue_id}: ${data.reason}`);
      markRepeatStopped(data.queue_id);
    });

    return () => {
      unlistenCan.then((fn) => fn());
      unlistenSerial.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
    };
  }, [addHistoryItem, markRepeatStopped, ioProfileName]);

  // Set active session for child components (CanTransmitView, etc.)
  useEffect(() => {
    const store = useSessionStore.getState();
    if (isConnected && effectiveSessionId) {
      store.setActiveSession(effectiveSessionId);
    } else if (!isConnected && store.activeSessionId === effectiveSessionId) {
      store.setActiveSession(null);
    }
    return () => {
      const currentStore = useSessionStore.getState();
      if (currentStore.activeSessionId === effectiveSessionId) {
        currentStore.setActiveSession(null);
      }
    };
  }, [isConnected, effectiveSessionId]);

  // Count active repeats in queue
  const activeRepeats = queue.filter((q) => q.isRepeating).length;

  // Render active tab content
  const renderTabContent = () => {
    switch (activeTab) {
      case "frame":
        // Show Serial view if device supports serial but not CAN, otherwise CAN
        return capabilities?.can_transmit_serial && !capabilities?.can_transmit ? (
          <SerialTransmitView />
        ) : (
          <CanTransmitView />
        );
      case "queue":
        return <TransmitQueueView />;
      case "history":
        return <TransmitHistoryView />;
      default:
        return null;
    }
  };

  return (
    <div className={`flex flex-col h-full ${bgDarkView}`}>
      {/* Top Bar */}
      <TransmitTopBar
        ioProfiles={transmitProfiles}
        ioProfile={ioProfile}
        defaultReadProfileId={settings?.default_read_profile}
        multiBusMode={multiBusMode}
        multiBusProfiles={multiBusProfiles}
        isStreaming={isStreaming}
        isStopped={isStopped}
        isDetached={isDetached}
        joinerCount={joinerCount}
        capabilities={capabilities}
        onOpenIoPicker={handlers.handleOpenIoPicker}
        onStop={handlers.handleStop}
        onResume={handlers.handleResume}
        onDetach={handlers.handleDetach}
        onRejoin={handlers.handleRejoin}
        isLoading={isLoading}
        error={transmitError}
      />

      {/* Error Banner */}
      {transmitError && (
        <div
          className={`flex items-center gap-2 px-4 py-2 bg-red-900/50 border-b ${borderDarkView}`}
        >
          <AlertCircle size={16} className="text-red-400 shrink-0" />
          <span className="text-red-300 text-sm flex-1">{transmitError}</span>
          <button
            onClick={clearError}
            className="text-red-400 hover:text-red-300 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading / No Profiles State */}
      {isLoading && profiles.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className={`${textDarkMuted} text-sm`}>Loading profiles...</div>
        </div>
      )}

      {!isLoading && transmitProfiles.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <Send size={48} className={textDarkMuted} />
          <div className={`${textDarkMuted} text-center`}>
            <p className="text-lg font-medium">No Transmit-Capable Profiles</p>
            <p className="text-sm mt-2">
              Add an IO profile (slcan, GVRET TCP, SocketCAN, or Serial) in
              Settings to enable transmission.
            </p>
            <p className="text-sm mt-1 text-gray-500">
              Note: slcan profiles in silent mode (M1) cannot transmit.
            </p>
          </div>
        </div>
      )}

      {/* Main Content */}
      {transmitProfiles.length > 0 && (
        <>
          {/* Tab Bar */}
          <div
            className={`flex-shrink-0 flex items-center border-b ${borderDarkView} ${bgDarkToolbar}`}
          >
            {/* Protocol badge with status light */}
            <div className="ml-1">
              <ProtocolBadge
                canTransmit={capabilities?.can_transmit}
                canTransmitSerial={capabilities?.can_transmit_serial}
                isStreaming={isStreaming}
              />
            </div>

            {/* Tabs */}
            <button
              onClick={() => handlers.handleTabClick("frame")}
              className={dataViewTabClass(activeTab === "frame")}
            >
              Frame
            </button>
            <button
              onClick={() => handlers.handleTabClick("queue")}
              className={dataViewTabClass(activeTab === "queue", activeRepeats > 0)}
            >
              Queue
              {queue.length > 0 && (
                <span
                  className={`ml-1.5 text-xs ${
                    activeRepeats > 0
                      ? tabCountColorClass("green")
                      : tabCountColorClass("gray")
                  }`}
                >
                  ({queue.length})
                </span>
              )}
            </button>
            <button
              onClick={() => handlers.handleTabClick("history")}
              className={dataViewTabClass(activeTab === "history")}
            >
              History
              {history.length > 0 && (
                <span className={`ml-1.5 text-xs ${tabCountColorClass("gray")}`}>
                  ({history.length})
                </span>
              )}
            </button>

            {/* Spacer */}
            <div className="flex-1" />
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-hidden">{renderTabContent()}</div>
        </>
      )}

      {/* IO Picker Dialog */}
      <IoReaderPickerDialog
        isOpen={showIoPickerDialog}
        onClose={handlers.handleCloseIoPicker}
        ioProfiles={transmitProfiles}
        selectedId={ioProfile ?? null}
        defaultId={null}
        onSelect={() => {}}
        onStartIngest={handlers.handleStartSession}
        onStartMultiIngest={handlers.handleStartMultiIngest}
        onJoinSession={handlers.handleJoinSession}
        hideBuffers={true}
        allowMultiSelect={true}
        disabledProfiles={transmitStatusMap}
        onSkip={handlers.handleSkip}
      />
    </div>
  );
}
