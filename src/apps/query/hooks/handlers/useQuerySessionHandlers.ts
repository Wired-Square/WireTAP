// src/apps/query/hooks/handlers/useQuerySessionHandlers.ts
//
// Session-related handlers for Query: connect, ingest, stop, skip.
// Delegates session orchestration to useIOSessionManager methods.

import { useCallback } from "react";
import type { IngestOptions } from "../../../../hooks/useIOSessionManager";
import { useQueryStore } from "../../stores/queryStore";

export interface UseQuerySessionHandlersParams {
  // Session manager actions
  connectOnly: (profileId: string, options?: IngestOptions) => Promise<void>;
  watchSingleSource: (
    profileId: string,
    options: IngestOptions
  ) => Promise<void>;
  stopWatch: () => Promise<void>;
  skipReader: () => Promise<void>;

  // Profile state
  ioProfile: string | null;
  setIoProfile: (profileId: string | null) => void;

  // Dialog control
  closeIoReaderPicker: () => void;
}

export function useQuerySessionHandlers({
  connectOnly,
  watchSingleSource,
  stopWatch,
  skipReader,
  ioProfile,
  setIoProfile,
  closeIoReaderPicker,
}: UseQuerySessionHandlersParams) {
  // Handle Connect from IoReaderPickerDialog (connect mode)
  // Creates session without streaming - queries run inside session but don't stream to other apps
  const handleConnect = useCallback(
    async (profileId: string) => {
      await connectOnly(profileId);
    },
    [connectOnly]
  );

  // Profile change handler (for onSelect callback)
  const handleIoProfileChange = useCallback(
    (profileId: string | null) => {
      setIoProfile(profileId);
    },
    [setIoProfile]
  );

  // Ingest around event handler - called when user clicks a result row
  const handleIngestAroundEvent = useCallback(
    async (timestampUs: number) => {
      const { contextWindow } = useQueryStore.getState();
      const eventTimeMs = timestampUs / 1000;

      const startTime = new Date(
        eventTimeMs - contextWindow.beforeMs
      ).toISOString();
      const endTime = new Date(
        eventTimeMs + contextWindow.afterMs
      ).toISOString();

      if (ioProfile) {
        await watchSingleSource(ioProfile, { startTime, endTime });
      }
    },
    [ioProfile, watchSingleSource]
  );

  // Handle ingest all results (from selected query)
  const handleIngestAllResults = useCallback(
    async (minTimestampUs: number, maxTimestampUs: number) => {
      if (ioProfile) {
        const startTime = new Date(minTimestampUs / 1000).toISOString();
        const endTime = new Date(maxTimestampUs / 1000).toISOString();
        await watchSingleSource(ioProfile, { startTime, endTime });
      }
    },
    [ioProfile, watchSingleSource]
  );

  // Skip handler for IO picker
  const handleSkip = useCallback(async () => {
    await skipReader();
    closeIoReaderPicker();
  }, [skipReader, closeIoReaderPicker]);

  // Stop watch handler
  const handleStopWatch = useCallback(async () => {
    await stopWatch();
  }, [stopWatch]);

  return {
    handleConnect,
    handleIoProfileChange,
    handleIngestAroundEvent,
    handleIngestAllResults,
    handleSkip,
    handleStopWatch,
  };
}

export type QuerySessionHandlers = ReturnType<typeof useQuerySessionHandlers>;
