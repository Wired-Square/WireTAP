// src/apps/transmit/hooks/handlers/useTransmitSessionHandlers.ts
//
// Session-related handlers for Transmit: stop and resume.
// IO picker dialog handlers are centralised in useIOPickerHandlers.

import { useCallback } from "react";

export interface UseTransmitSessionHandlersParams {
  stopWatch: () => Promise<void>;
  resumeWithNewBuffer: () => Promise<void>;
}

export function useTransmitSessionHandlers({
  stopWatch,
  resumeWithNewBuffer,
}: UseTransmitSessionHandlersParams) {
  // Handle stop - stop watching (used by TopBar)
  const handleStop = useCallback(async () => {
    await stopWatch();
  }, [stopWatch]);

  // Handle resume - use resumeWithNewBuffer to return to live mode (used by TopBar)
  const handleResume = useCallback(async () => {
    await resumeWithNewBuffer();
  }, [resumeWithNewBuffer]);

  return {
    handleStop,
    handleResume,
  };
}

export type TransmitSessionHandlers = ReturnType<
  typeof useTransmitSessionHandlers
>;
