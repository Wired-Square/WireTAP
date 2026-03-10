// src/apps/query/hooks/handlers/useQuerySessionHandlers.ts
//
// Session-related handlers for Query: ingest around event, ingest all, stop.
// Delegates session orchestration to useIOSessionManager methods.

import { useCallback } from "react";
import type { LoadOptions } from "../../../../hooks/useIOSessionManager";
import { useQueryStore } from "../../stores/queryStore";

export interface UseQuerySessionHandlersParams {
  // Session manager actions
  watchSource: (
    profileIds: string[],
    options: LoadOptions
  ) => Promise<void>;
  stopWatch: () => Promise<void>;

  // Source profile ID (the actual IO profile, not the session ID)
  sourceProfileId: string | null;
}

export function useQuerySessionHandlers({
  watchSource,
  stopWatch,
  sourceProfileId,
}: UseQuerySessionHandlersParams) {
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

      if (sourceProfileId) {
        await watchSource([sourceProfileId], { startTime, endTime });
      }
    },
    [sourceProfileId, watchSource]
  );

  // Handle ingest all results (from selected query)
  const handleIngestAllResults = useCallback(
    async (minTimestampUs: number, maxTimestampUs: number) => {
      if (sourceProfileId) {
        const startTime = new Date(minTimestampUs / 1000).toISOString();
        const endTime = new Date(maxTimestampUs / 1000).toISOString();
        await watchSource([sourceProfileId], { startTime, endTime });
      }
    },
    [sourceProfileId, watchSource]
  );

  // Stop watch handler
  const handleStopWatch = useCallback(async () => {
    await stopWatch();
  }, [stopWatch]);

  return {
    handleIngestAroundEvent,
    handleIngestAllResults,
    handleStopWatch,
  };
}

export type QuerySessionHandlers = ReturnType<typeof useQuerySessionHandlers>;
