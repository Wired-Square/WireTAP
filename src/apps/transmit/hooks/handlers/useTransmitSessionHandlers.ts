// ui/src/apps/transmit/hooks/handlers/useTransmitSessionHandlers.ts
//
// Session-related handlers for Transmit: start, stop, resume, detach, rejoin, join, multi-bus.

import { useCallback } from "react";
import type { IngestOptions } from "../../../../hooks/useIOSessionManager";
import { useTransmitStore } from "../../../../stores/transmitStore";

export interface UseTransmitSessionHandlersParams {
  // Session manager state
  multiBusMode: boolean;
  isStreaming: boolean;
  sessionReady: boolean;

  // Session manager actions
  setMultiBusMode: (mode: boolean) => void;
  setMultiBusProfiles: (profiles: string[]) => void;
  setIoProfile: (profileId: string | null) => void;
  reinitialize: (profileId: string) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  leave: () => Promise<void>;
  rejoin: (sessionId: string) => Promise<void>;
  managerDetach: () => Promise<void>;
  managerRejoin: () => Promise<void>;
  startMultiBusSession: (profileIds: string[], options: IngestOptions) => Promise<void>;

  // Dialog control
  setShowIoPickerDialog: (show: boolean) => void;
}

export function useTransmitSessionHandlers({
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
        // Exit multi-bus mode if switching to single profile
        if (multiBusMode) {
          setMultiBusMode(false);
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
        console.error("Failed to create session:", e);
      }
    },
    [multiBusMode, setMultiBusMode, setMultiBusProfiles, setIoProfile, reinitialize, isStreaming, start, setShowIoPickerDialog]
  );

  // Handle stop - also stop all queue repeats and leave session
  const handleStop = useCallback(async () => {
    // Stop all active repeats before stopping the session
    await stopAllRepeats();
    await stopAllGroupRepeats();
    await stop();
    // Leave the session to release single-handle devices (serial, slcan)
    await leave();
  }, [stop, leave, stopAllRepeats, stopAllGroupRepeats]);

  // Handle resume
  const handleResume = useCallback(async () => {
    await start();
  }, [start]);

  // Handle detach (leave session without stopping it)
  const handleDetach = useCallback(async () => {
    await managerDetach();
  }, [managerDetach]);

  // Handle rejoin after detaching
  const handleRejoin = useCallback(async () => {
    await managerRejoin();
  }, [managerRejoin]);

  // Handle joining an existing session from the IO picker dialog
  const handleJoinSession = useCallback(
    async (sessionId: string, sourceProfileIds?: string[]) => {
      try {
        // Check if this is a multi-source session
        if (sourceProfileIds && sourceProfileIds.length > 0) {
          // Multi-source session - join it
          setMultiBusMode(false); // We're joining, not creating
          setMultiBusProfiles(sourceProfileIds);
          setIoProfile(sessionId);
        } else {
          // Single profile session
          if (multiBusMode) {
            setMultiBusMode(false);
            setMultiBusProfiles([]);
          }
          setIoProfile(sessionId);
        }

        // Rejoin the session
        await rejoin(sessionId);

        // Close the dialog
        setShowIoPickerDialog(false);
      } catch (e) {
        console.error("Failed to join session:", e);
      }
    },
    [multiBusMode, setMultiBusMode, setMultiBusProfiles, setIoProfile, rejoin, setShowIoPickerDialog]
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
        console.error("Failed to create multi-source session:", e);
      }
    },
    [startMultiBusSession, setShowIoPickerDialog]
  );

  // Handle skip (continue without reader)
  const handleSkip = useCallback(async () => {
    // Clear multi-bus state if active
    if (multiBusMode) {
      setMultiBusMode(false);
      setMultiBusProfiles([]);
    }
    // Leave the session if connected
    if (sessionReady) {
      await leave();
    }
    setIoProfile(null);
    setShowIoPickerDialog(false);
  }, [multiBusMode, sessionReady, setMultiBusMode, setMultiBusProfiles, leave, setIoProfile, setShowIoPickerDialog]);

  return {
    handleStartSession,
    handleStop,
    handleResume,
    handleDetach,
    handleRejoin,
    handleJoinSession,
    handleStartMultiIngest,
    handleSkip,
  };
}

export type TransmitSessionHandlers = ReturnType<typeof useTransmitSessionHandlers>;
