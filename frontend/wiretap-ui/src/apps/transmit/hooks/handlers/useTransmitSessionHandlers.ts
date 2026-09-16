// src/apps/transmit/hooks/handlers/useTransmitSessionHandlers.ts
//
// Session-related handlers for Transmit: stop and resume.
// IO picker dialog handlers are centralised in useIOSourcePickerHandlers.

import { useCallback } from "react";

export interface UseTransmitSessionHandlersParams {
  stopWatch: () => Promise<void>;
  resumeWithNewCapture: () => Promise<void>;
}

export function useTransmitSessionHandlers({
  stopWatch,
  resumeWithNewCapture,
}: UseTransmitSessionHandlersParams) {
  // Handle stop - stop watching (used by TopBar)
  const handleStop = useCallback(async () => {
    await stopWatch();
  }, [stopWatch]);

  // Handle resume - use resumeWithNewCapture to return to live mode (used by TopBar)
  const handleResume = useCallback(async () => {
    await resumeWithNewCapture();
  }, [resumeWithNewCapture]);

  return {
    handleStop,
    handleResume,
  };
}

export type TransmitSessionHandlers = ReturnType<
  typeof useTransmitSessionHandlers
>;
