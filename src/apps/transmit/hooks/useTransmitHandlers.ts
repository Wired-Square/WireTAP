// src/apps/transmit/hooks/useTransmitHandlers.ts
//
// Orchestrator hook that composes all Transmit domain handlers.

import {
  useTransmitSessionHandlers,
  type TransmitSessionHandlers,
} from "./handlers/useTransmitSessionHandlers";
import {
  useTransmitUIHandlers,
  type TransmitUIHandlers,
} from "./handlers/useTransmitUIHandlers";
import type { IngestOptions } from "../../../hooks/useIOSessionManager";

export interface UseTransmitHandlersParams {
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
  joinSession: (
    sessionId: string,
    sourceProfileIds?: string[]
  ) => Promise<void>;
  skipReader: () => Promise<void>;
  resumeWithNewBuffer: () => Promise<void>;

  // Dialog state setter
  setShowIoPickerDialog: (show: boolean) => void;
}

export type TransmitHandlers = TransmitSessionHandlers & TransmitUIHandlers;

export function useTransmitHandlers(
  params: UseTransmitHandlersParams
): TransmitHandlers {
  // Session handlers (start, stop, resume, join, multi-bus)
  const sessionHandlers = useTransmitSessionHandlers({
    watchSingleSource: params.watchSingleSource,
    watchMultiSource: params.watchMultiSource,
    stopWatch: params.stopWatch,
    joinSession: params.joinSession,
    skipReader: params.skipReader,
    resumeWithNewBuffer: params.resumeWithNewBuffer,
    setShowIoPickerDialog: params.setShowIoPickerDialog,
  });

  // UI handlers (tabs, dialogs)
  const uiHandlers = useTransmitUIHandlers({
    setShowIoPickerDialog: params.setShowIoPickerDialog,
  });

  // Spread all handlers into a flat object
  return {
    ...sessionHandlers,
    ...uiHandlers,
  };
}
