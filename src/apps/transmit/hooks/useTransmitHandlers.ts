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

export interface UseTransmitHandlersParams {
  // Session manager actions (TopBar only)
  stopWatch: () => Promise<void>;
  resumeWithNewBuffer: () => Promise<void>;

  // Dialog control
  openIoPicker: () => void;
  closeIoPicker: () => void;
}

export type TransmitHandlers = TransmitSessionHandlers & TransmitUIHandlers;

export function useTransmitHandlers(
  params: UseTransmitHandlersParams
): TransmitHandlers {
  // Session handlers (stop, resume - for TopBar)
  const sessionHandlers = useTransmitSessionHandlers({
    stopWatch: params.stopWatch,
    resumeWithNewBuffer: params.resumeWithNewBuffer,
  });

  // UI handlers (tabs, dialogs)
  const uiHandlers = useTransmitUIHandlers({
    openIoPicker: params.openIoPicker,
    closeIoPicker: params.closeIoPicker,
  });

  // Spread all handlers into a flat object
  return {
    ...sessionHandlers,
    ...uiHandlers,
  };
}
