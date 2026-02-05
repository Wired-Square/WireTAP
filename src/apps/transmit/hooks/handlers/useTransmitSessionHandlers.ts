// ui/src/apps/transmit/hooks/handlers/useTransmitSessionHandlers.ts
//
// Session-related handlers for Transmit: start, stop, resume, join, multi-bus.

import { useCallback } from "react";
import type { IngestOptions } from "../../../../hooks/useIOSessionManager";
import { useTransmitStore } from "../../../../stores/transmitStore";
import { useSessionStore } from "../../../../stores/sessionStore";

export interface UseTransmitSessionHandlersParams {
  // Session manager state
  multiBusProfiles: string[];
  isStreaming: boolean;
  sessionReady: boolean;

  // Session manager actions
  setMultiBusProfiles: (profiles: string[]) => void;
  setIoProfile: (profileId: string | null) => void;
  reinitialize: (profileId: string) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  resumeFresh: () => Promise<void>;
  leave: () => Promise<void>;
  rejoin: (sessionId: string) => Promise<void>;
  startMultiBusSession: (profileIds: string[], options: IngestOptions) => Promise<void>;

  // Dialog control
  setShowIoPickerDialog: (show: boolean) => void;
}

export function useTransmitSessionHandlers({
  multiBusProfiles,
  isStreaming,
  sessionReady,
  setMultiBusProfiles,
  setIoProfile,
  reinitialize,
  start,
  stop,
  resumeFresh,
  leave,
  rejoin,
  startMultiBusSession,
  setShowIoPickerDialog,
}: UseTransmitSessionHandlersParams) {
  // Store actions for stopping repeats
  const stopAllRepeats = useTransmitStore((s) => s.stopAllRepeats);
  const stopAllGroupRepeats = useTransmitStore((s) => s.stopAllGroupRepeats);

  // Handle starting a session from IO picker (Watch mode)
  const handleStartSession = useCallback(
    async (
      profileId: string,
      closeDialog: boolean,
      _options: IngestOptions
    ) => {
      try {
        // Clear multi-bus state if switching to single profile
        if (multiBusProfiles.length > 0) {
          setMultiBusProfiles([]);
        }

        // Set the profile - this triggers useIOSession to create/join the session
        setIoProfile(profileId);

        // Reinitialize to ensure session is started
        await reinitialize(profileId);

        // Start the session if not already running
        if (!isStreaming) {
          await start();
        }

        if (closeDialog) {
          setShowIoPickerDialog(false);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to create session:", e);
        useSessionStore.getState().showAppError("Session Error", "Failed to create session.", msg);
      }
    },
    [multiBusProfiles.length, setMultiBusProfiles, setIoProfile, reinitialize, isStreaming, start, setShowIoPickerDialog]
  );

  // Handle stop - stop streaming and all queue repeats (but stay connected for resume)
  const handleStop = useCallback(async () => {
    // Stop all active repeats before stopping the session
    await stopAllRepeats();
    await stopAllGroupRepeats();
    await stop();
  }, [stop, stopAllRepeats, stopAllGroupRepeats]);

  // Handle resume - use resumeFresh to handle returning to live mode from buffer
  const handleResume = useCallback(async () => {
    await resumeFresh();
  }, [resumeFresh]);

  // Handle joining an existing session from the IO picker dialog
  const handleJoinSession = useCallback(
    async (sessionId: string, sourceProfileIds?: string[]) => {
      try {
        // Check if this is a multi-source session
        if (sourceProfileIds && sourceProfileIds.length > 0) {
          // Multi-source session - join it
          setMultiBusProfiles(sourceProfileIds);
          setIoProfile(sessionId);
        } else {
          // Single profile session - clear multi-bus state
          if (multiBusProfiles.length > 0) {
            setMultiBusProfiles([]);
          }
          setIoProfile(sessionId);
        }

        // Rejoin the session
        await rejoin(sessionId);

        // Close the dialog
        setShowIoPickerDialog(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to join session:", e);
        useSessionStore.getState().showAppError("Session Error", "Failed to join session.", msg);
      }
    },
    [multiBusProfiles.length, setMultiBusProfiles, setIoProfile, rejoin, setShowIoPickerDialog]
  );

  // Handle starting a multi-source session from IO picker (multi-bus mode)
  const handleStartMultiIngest = useCallback(
    async (
      profileIds: string[],
      closeDialog: boolean,
      options: IngestOptions
    ) => {
      try {
        await startMultiBusSession(profileIds, options);

        if (closeDialog) {
          setShowIoPickerDialog(false);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to create multi-source session:", e);
        useSessionStore.getState().showAppError("Multi-Bus Error", "Failed to create multi-source session.", msg);
      }
    },
    [startMultiBusSession, setShowIoPickerDialog]
  );

  // Handle skip (continue without reader)
  const handleSkip = useCallback(async () => {
    // Clear multi-bus state if active
    if (multiBusProfiles.length > 0) {
      setMultiBusProfiles([]);
    }
    // Leave the session if connected
    if (sessionReady) {
      await leave();
    }
    setIoProfile(null);
    setShowIoPickerDialog(false);
  }, [multiBusProfiles.length, sessionReady, setMultiBusProfiles, leave, setIoProfile, setShowIoPickerDialog]);

  return {
    handleStartSession,
    handleStop,
    handleResume,
    handleJoinSession,
    handleStartMultiIngest,
    handleSkip,
  };
}

export type TransmitSessionHandlers = ReturnType<typeof useTransmitSessionHandlers>;
