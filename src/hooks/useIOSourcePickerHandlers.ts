// ui/src/hooks/useIOSourcePickerHandlers.ts
//
// Centralised hook for IO source picker dialog handling.
// Provides consistent behavior across Decoder, Discovery, and other apps
// that use IoSourcePickerDialog.

import { useCallback } from "react";
import type { UseIOSessionManagerResult, LoadOptions as ManagerLoadOptions } from "./useIOSessionManager";
import { withAppError } from "../utils/appError";

/** Options passed from IoSourcePickerDialog */
export interface DialogLoadOptions {
  speed: number;
  startTime?: string;
  endTime?: string;
  maxFrames?: number;
  frameIdStartByte?: number;
  frameIdBytes?: number;
  sourceAddressStartByte?: number;
  sourceAddressBytes?: number;
  sourceAddressEndianness?: "big" | "little";
  minFrameLength?: number;
  framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
  delimiter?: number[];
  maxFrameLength?: number;
  emitRawBytes?: boolean;
  busOverride?: number;
  busMappings?: Map<string, import("../api/io").BusMapping[]>;
  perInterfaceFraming?: Map<string, import("../dialogs/io-source-picker").InterfaceFramingConfig>;
}

/** Configuration for the IO picker handlers hook */
export interface UseIOSourcePickerHandlersOptions {
  /** The IO session manager result */
  manager: UseIOSessionManagerResult;
  /** Close the IO picker dialog */
  closeDialog: () => void;
  /** Optional callback to merge app-specific options (e.g., catalog serial config) */
  mergeOptions?: (options: DialogLoadOptions) => ManagerLoadOptions;
  /** Optional callback when multi-bus mode is set */
  onMultiBusSet?: (profileIds: string[]) => void;
  /** Optional callback when joining a session */
  onJoinSession?: (sessionId: string, sourceProfileIds?: string[]) => void;
  /** Callback before starting single-source connect or load (for app-specific setup like serial/framing config) */
  onBeforeStart?: (profileId: string, options: DialogLoadOptions, mode: "connect" | "load") => void;
  /** Callback before starting multi-source connect or load */
  onBeforeMultiStart?: (profileIds: string[], options: DialogLoadOptions, mode: "connect" | "load") => void;
}

/** Props to pass to IoSourcePickerDialog */
export interface IOSourcePickerDialogProps {
  isLoading: boolean;
  loadProfileId: string | null;
  loadFrameCount: number;
  loadError: string | null;
  onStartLoad: (profileId: string, closeDialog: boolean, options: DialogLoadOptions) => Promise<void>;
  onStartMultiLoad: (profileIds: string[], closeDialog: boolean, options: DialogLoadOptions) => Promise<void>;
  onStopLoad: () => Promise<void>;
  onJoinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  onSkip: () => Promise<void>;
  onSelectMultiple: (profileIds: string[]) => void;
  onConnect: (profileId: string) => Promise<void>;
}

/**
 * Centralised hook for IO source picker dialog handling.
 * Returns handlers and props that can be spread onto IoSourcePickerDialog.
 */
export function useIOSourcePickerHandlers({
  manager,
  closeDialog,
  mergeOptions,
  onMultiBusSet,
  onJoinSession: onJoinSessionCallback,
  onBeforeStart,
  onBeforeMultiStart,
}: UseIOSourcePickerHandlersOptions): IOSourcePickerDialogProps {
  const {
    ioProfile,
    isStreaming,
    isCaptureMode,
    watchFrameCount,
    isLoading,
    loadProfileId,
    loadFrameCount,
    loadError,
    stopLoad,
    stopWatch,
    watchSource,
    loadSource,
    joinSession,
    skipReader,
    selectMultipleProfiles,
    connectOnly,
  } = manager;

  // Unified handler for Connect/Load from IoSourcePickerDialog
  const handleDialogStart = useCallback(
    async (profileIds: string[], closeDialogFlag: boolean, options: DialogLoadOptions) => {
      const mode = closeDialogFlag ? "connect" : "load";
      const mergedOptions = mergeOptions ? mergeOptions(options) : options;

      await withAppError(
        closeDialogFlag ? "Connect Error" : "Load Error",
        closeDialogFlag ? "Failed to start session" : "Failed to start load",
        async () => {
          if (profileIds.length === 1) {
            onBeforeStart?.(profileIds[0], options, mode);
          } else {
            onBeforeMultiStart?.(profileIds, options, mode);
          }

          if (closeDialogFlag) {
            await watchSource(profileIds, mergedOptions);
            closeDialog();
          } else {
            await loadSource(profileIds, mergedOptions);
          }
        }
      );
    },
    [watchSource, loadSource, closeDialog, mergeOptions, onBeforeStart, onBeforeMultiStart]
  );

  // Dialog props wrappers — single and multi share the same internal handler
  const handleDialogStartLoad = useCallback(
    async (profileId: string, closeDialogFlag: boolean, options: DialogLoadOptions) => {
      await handleDialogStart([profileId], closeDialogFlag, options);
    },
    [handleDialogStart]
  );

  const handleDialogStartMultiLoad = useCallback(
    async (profileIds: string[], closeDialogFlag: boolean, options: DialogLoadOptions) => {
      await handleDialogStart(profileIds, closeDialogFlag, options);
    },
    [handleDialogStart]
  );

  // Handle stopping from the dialog - routes to streaming or load stop
  // Note: Uses isStreaming (session is running) rather than isWatching (app initiated watch)
  // because the app may be joined to a session another app started
  const handleDialogStopLoad = useCallback(async () => {
    if (isStreaming && !isLoading) {
      await stopWatch();
      // The stream-ended event will handle buffer transition
    } else if (isLoading) {
      await stopLoad();
    }
  }, [isStreaming, isLoading, stopWatch, stopLoad]);

  // Handle joining an existing session
  const handleJoinSession = useCallback(
    async (sessionId: string, sourceProfileIds?: string[]) => {
      await joinSession(sessionId, sourceProfileIds);
      onJoinSessionCallback?.(sessionId, sourceProfileIds);
      closeDialog();
    },
    [joinSession, closeDialog, onJoinSessionCallback]
  );

  // Handle skipping IO picker
  const handleSkip = useCallback(async () => {
    await skipReader();
    closeDialog();
  }, [skipReader, closeDialog]);

  // Handle connect-only from IoSourcePickerDialog (connect mode)
  // Dialog handles closing itself after onConnect
  const handleConnect = useCallback(
    async (profileId: string) => {
      await connectOnly(profileId);
    },
    [connectOnly]
  );

  // Handle multi-select from dialog
  const handleSelectMultiple = useCallback(
    (profileIds: string[]) => {
      selectMultipleProfiles(profileIds);
      onMultiBusSet?.(profileIds);
    },
    [selectMultipleProfiles, onMultiBusSet]
  );

  return {
    // State props for the dialog
    // Note: Uses isStreaming (session is running) rather than isWatching (app initiated watch)
    // so the dialog correctly shows streaming state even when joined to another app's session.
    // Buffer sessions are excluded — buffer playback is not loading.
    isLoading: isLoading || (isStreaming && !isCaptureMode),
    loadProfileId: isLoading ? loadProfileId : (isStreaming && !isCaptureMode ? ioProfile : null),
    loadFrameCount: isLoading ? loadFrameCount : watchFrameCount,
    loadError: loadError ?? null,
    // Handlers
    onStartLoad: handleDialogStartLoad,
    onStartMultiLoad: handleDialogStartMultiLoad,
    onStopLoad: handleDialogStopLoad,
    onJoinSession: handleJoinSession,
    onSkip: handleSkip,
    onSelectMultiple: handleSelectMultiple,
    onConnect: handleConnect,
  };
}
