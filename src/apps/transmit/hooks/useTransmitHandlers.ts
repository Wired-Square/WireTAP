// ui/src/apps/transmit/hooks/useTransmitHandlers.ts
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
  resumeFresh: () => Promise<void>;
  leave: () => Promise<void>;
  rejoin: (sessionId: string) => Promise<void>;
  startMultiBusSession: (profileIds: string[], options: IngestOptions) => Promise<void>;

  // Dialog state setter
  setShowIoPickerDialog: (show: boolean) => void;
}

export type TransmitHandlers = TransmitSessionHandlers & TransmitUIHandlers;

export function useTransmitHandlers(params: UseTransmitHandlersParams): TransmitHandlers {
  // Session handlers (start, stop, resume, join, multi-bus)
  const sessionHandlers = useTransmitSessionHandlers({
    multiBusMode: params.multiBusMode,
    isStreaming: params.isStreaming,
    sessionReady: params.sessionReady,
    setMultiBusMode: params.setMultiBusMode,
    setMultiBusProfiles: params.setMultiBusProfiles,
    setIoProfile: params.setIoProfile,
    reinitialize: params.reinitialize,
    start: params.start,
    stop: params.stop,
    resumeFresh: params.resumeFresh,
    leave: params.leave,
    rejoin: params.rejoin,
    startMultiBusSession: params.startMultiBusSession,
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
