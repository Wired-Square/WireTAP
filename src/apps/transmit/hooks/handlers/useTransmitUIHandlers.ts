// src/apps/transmit/hooks/handlers/useTransmitUIHandlers.ts
//
// UI-related handlers for Transmit: tab switching, dialog control.

import { useCallback } from "react";
import { useTransmitStore, type TransmitTab } from "../../../../stores/transmitStore";

export interface UseTransmitUIHandlersParams {
  openIoPicker: () => void;
  closeIoPicker: () => void;
}

export function useTransmitUIHandlers({
  openIoPicker,
  closeIoPicker,
}: UseTransmitUIHandlersParams) {
  const setActiveTab = useTransmitStore((s) => s.setActiveTab);

  // Tab click handler
  const handleTabClick = useCallback(
    (tab: TransmitTab) => {
      setActiveTab(tab);
    },
    [setActiveTab]
  );

  // Handle opening IO picker
  const handleOpenIoPicker = useCallback(() => {
    openIoPicker();
  }, [openIoPicker]);

  // Handle closing IO picker
  const handleCloseIoPicker = useCallback(() => {
    closeIoPicker();
  }, [closeIoPicker]);

  return {
    handleTabClick,
    handleOpenIoPicker,
    handleCloseIoPicker,
  };
}

export type TransmitUIHandlers = ReturnType<typeof useTransmitUIHandlers>;
