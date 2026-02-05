// src/apps/transmit/hooks/handlers/useTransmitSessionHandlers.ts
//
// Session-related handlers for Transmit: start, stop, resume, join, multi-bus.
// Delegates session orchestration to useIOSessionManager methods.

import { useCallback } from "react";
import type { IngestOptions } from "../../../../hooks/useIOSessionManager";
import { useSessionStore } from "../../../../stores/sessionStore";

export interface UseTransmitSessionHandlersParams {
  // Session manager actions
  watchSingleSource: (
    profileId: string,
    options: IngestOptions
  ) => Promise<void>;
  watchMultiSource: (
    profileIds: string[],
    options: IngestOptions
  ) => Promise<void>;
  stopWatch: () => Promise<void>;
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  skipReader: () => Promise<void>;
  resumeWithNewBuffer: () => Promise<void>;

  // Dialog control
  setShowIoPickerDialog: (show: boolean) => void;
}

export function useTransmitSessionHandlers({
  watchSingleSource,
  watchMultiSource,
  stopWatch,
  joinSession,
  skipReader,
  resumeWithNewBuffer,
  setShowIoPickerDialog,
}: UseTransmitSessionHandlersParams) {
  // Handle starting a session from IO picker (Watch mode)
  const handleStartSession = useCallback(
    async (
      profileId: string,
      closeDialog: boolean,
      options: IngestOptions
    ) => {
      try {
        // Manager handles: reinitialize, multi-bus clear, profile set, speed, watch state
        // onBeforeWatch callback handles stopping repeats
        await watchSingleSource(profileId, options);

        if (closeDialog) {
          setShowIoPickerDialog(false);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to create session:", e);
        useSessionStore
          .getState()
          .showAppError("Session Error", "Failed to create session.", msg);
      }
    },
    [watchSingleSource, setShowIoPickerDialog]
  );

  // Handle starting a multi-source session from IO picker (multi-bus mode)
  const handleStartMultiIngest = useCallback(
    async (
      profileIds: string[],
      closeDialog: boolean,
      options: IngestOptions
    ) => {
      try {
        // Manager handles: startMultiBusSession, speed, watch state
        // onBeforeMultiWatch callback handles stopping repeats
        await watchMultiSource(profileIds, options);

        if (closeDialog) {
          setShowIoPickerDialog(false);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to create multi-source session:", e);
        useSessionStore
          .getState()
          .showAppError(
            "Multi-Bus Error",
            "Failed to create multi-source session.",
            msg
          );
      }
    },
    [watchMultiSource, setShowIoPickerDialog]
  );

  // Handle stop - stop watching
  const handleStop = useCallback(async () => {
    // onBeforeWatch will stop repeats when the next session starts
    // For now, just stop the watch (repeats continue until user explicitly stops them)
    await stopWatch();
  }, [stopWatch]);

  // Handle resume - use resumeWithNewBuffer to return to live mode
  const handleResume = useCallback(async () => {
    await resumeWithNewBuffer();
  }, [resumeWithNewBuffer]);

  // Handle joining an existing session from the IO picker dialog
  const handleJoinSession = useCallback(
    async (sessionId: string, sourceProfileIds?: string[]) => {
      try {
        await joinSession(sessionId, sourceProfileIds);
        setShowIoPickerDialog(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Failed to join session:", e);
        useSessionStore
          .getState()
          .showAppError("Session Error", "Failed to join session.", msg);
      }
    },
    [joinSession, setShowIoPickerDialog]
  );

  // Handle skip (continue without reader)
  const handleSkip = useCallback(async () => {
    await skipReader();
    setShowIoPickerDialog(false);
  }, [skipReader, setShowIoPickerDialog]);

  return {
    handleStartSession,
    handleStartMultiIngest,
    handleStop,
    handleResume,
    handleJoinSession,
    handleSkip,
  };
}

export type TransmitSessionHandlers = ReturnType<
  typeof useTransmitSessionHandlers
>;
