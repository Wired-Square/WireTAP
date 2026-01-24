// ui/src/apps/transmit/hooks/handlers/useTransmitUIHandlers.ts
//
// UI-related handlers for Transmit: tab switching, dialog control.

import { useCallback } from "react";
import { useTransmitStore, type TransmitTab } from "../../../../stores/transmitStore";

export interface UseTransmitUIHandlersParams {
  setShowIoPickerDialog: (show: boolean) => void;
}

export function useTransmitUIHandlers({
  setShowIoPickerDialog,
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
    setShowIoPickerDialog(true);
  }, [setShowIoPickerDialog]);

  // Handle closing IO picker
  const handleCloseIoPicker = useCallback(() => {
    setShowIoPickerDialog(false);
  }, [setShowIoPickerDialog]);

  return {
    handleTabClick,
    handleOpenIoPicker,
    handleCloseIoPicker,
  };
}

export type TransmitUIHandlers = ReturnType<typeof useTransmitUIHandlers>;
