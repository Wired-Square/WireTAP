// ui/src/hooks/useIOPickerHandlers.ts
//
// Centralised hook for IO picker dialog handling.
// Provides consistent behavior across Decoder, Discovery, and other apps
// that use IoReaderPickerDialog.

import { useCallback } from "react";
import type { UseIOSessionManagerResult, IngestOptions as ManagerIngestOptions } from "./useIOSessionManager";

/** Options passed from IoReaderPickerDialog */
export interface DialogIngestOptions {
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
  perInterfaceFraming?: Map<string, import("../dialogs/io-reader-picker").InterfaceFramingConfig>;
}

/** Configuration for the IO picker handlers hook */
export interface UseIOPickerHandlersOptions {
  /** The IO session manager result */
  manager: UseIOSessionManagerResult;
  /** Close the IO picker dialog */
  closeDialog: () => void;
  /** Optional callback to merge app-specific options (e.g., catalog serial config) */
  mergeOptions?: (options: DialogIngestOptions) => ManagerIngestOptions;
  /** Optional callback when multi-bus mode is set */
  onMultiBusSet?: (profileIds: string[]) => void;
  /** Optional callback when joining a session */
  onJoinSession?: (sessionId: string, sourceProfileIds?: string[]) => void;
}

/** Props to pass to IoReaderPickerDialog */
export interface IOPickerDialogProps {
  isIngesting: boolean;
  ingestProfileId: string | null;
  ingestFrameCount: number;
  ingestError: string | null;
  onStartIngest: (profileId: string, closeDialog: boolean, options: DialogIngestOptions) => Promise<void>;
  onStartMultiIngest: (profileIds: string[], closeDialog: boolean, options: DialogIngestOptions) => Promise<void>;
  onStopIngest: () => Promise<void>;
  onJoinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  onSkip: () => Promise<void>;
  onSelectMultiple: (profileIds: string[]) => void;
}

/**
 * Centralised hook for IO picker dialog handling.
 * Returns handlers and props that can be spread onto IoReaderPickerDialog.
 */
export function useIOPickerHandlers({
  manager,
  closeDialog,
  mergeOptions,
  onMultiBusSet,
  onJoinSession: onJoinSessionCallback,
}: UseIOPickerHandlersOptions): IOPickerDialogProps {
  const {
    ioProfile,
    isStreaming,
    watchFrameCount,
    isIngesting,
    ingestProfileId,
    ingestFrameCount,
    ingestError,
    stopIngest,
    stopWatch,
    watchSingleSource,
    watchMultiSource,
    ingestSingleSource,
    ingestMultiSource,
    joinSession,
    skipReader,
    setMultiBusMode,
    setMultiBusProfiles,
  } = manager;

  // Handle Watch/Ingest from IoReaderPickerDialog
  const handleDialogStartIngest = useCallback(
    async (profileId: string, closeDialogFlag: boolean, options: DialogIngestOptions) => {
      // Merge with app-specific options if provided
      const mergedOptions = mergeOptions ? mergeOptions(options) : options;

      if (closeDialogFlag) {
        // Watch mode - close dialog and show real-time display
        await watchSingleSource(profileId, mergedOptions);
        closeDialog();
      } else {
        // Ingest mode - keep dialog open to show progress
        await ingestSingleSource(profileId, mergedOptions);
      }
    },
    [watchSingleSource, ingestSingleSource, closeDialog, mergeOptions]
  );

  // Handle multi-bus Watch/Ingest
  const handleDialogStartMultiIngest = useCallback(
    async (profileIds: string[], closeDialogFlag: boolean, options: DialogIngestOptions) => {
      // Merge with app-specific options if provided
      const mergedOptions = mergeOptions ? mergeOptions(options) : options;

      if (closeDialogFlag) {
        // Watch mode - close dialog and show real-time display
        await watchMultiSource(profileIds, mergedOptions);
        closeDialog();
      } else {
        // Ingest mode - keep dialog open to show progress
        await ingestMultiSource(profileIds, mergedOptions);
      }
    },
    [watchMultiSource, ingestMultiSource, closeDialog, mergeOptions]
  );

  // Handle stopping from the dialog - routes to streaming or ingest stop
  // Note: Uses isStreaming (session is running) rather than isWatching (app initiated watch)
  // because the app may be joined to a session another app started
  const handleDialogStopIngest = useCallback(async () => {
    if (isStreaming && !isIngesting) {
      await stopWatch();
      // The stream-ended event will handle buffer transition
    } else if (isIngesting) {
      await stopIngest();
    }
  }, [isStreaming, isIngesting, stopWatch, stopIngest]);

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

  // Handle multi-select from dialog
  const handleSelectMultiple = useCallback(
    (profileIds: string[]) => {
      const isMulti = profileIds.length > 1;
      setMultiBusMode(isMulti);
      setMultiBusProfiles(profileIds);
      onMultiBusSet?.(profileIds);
    },
    [setMultiBusMode, setMultiBusProfiles, onMultiBusSet]
  );

  return {
    // State props for the dialog
    // Note: Uses isStreaming (session is running) rather than isWatching (app initiated watch)
    // so the dialog correctly shows streaming state even when joined to another app's session
    isIngesting: isIngesting || isStreaming,
    ingestProfileId: isIngesting ? ingestProfileId : (isStreaming ? ioProfile : null),
    ingestFrameCount: isIngesting ? ingestFrameCount : watchFrameCount,
    ingestError: ingestError ?? null,
    // Handlers
    onStartIngest: handleDialogStartIngest,
    onStartMultiIngest: handleDialogStartMultiIngest,
    onStopIngest: handleDialogStopIngest,
    onJoinSession: handleJoinSession,
    onSkip: handleSkip,
    onSelectMultiple: handleSelectMultiple,
  };
}
