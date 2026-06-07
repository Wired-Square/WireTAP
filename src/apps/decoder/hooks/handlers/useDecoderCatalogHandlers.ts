// ui/src/apps/decoder/hooks/handlers/useDecoderCatalogHandlers.ts
//
// Catalog-related handlers for Decoder: clear data by active tab. (Catalogue
// loading/binding is driven by the load/attach effect in Decoder.tsx.)

import { useCallback } from "react";

export interface UseDecoderCatalogHandlersParams {
  // Store actions
  clearDecoded: () => void;
  clearUnmatchedFrames: () => void;
  clearFilteredFrames: () => void;

  // Active tab for per-tab clear functionality
  activeTab: string;
}

export function useDecoderCatalogHandlers({
  clearDecoded,
  clearUnmatchedFrames,
  clearFilteredFrames,
  activeTab,
}: UseDecoderCatalogHandlersParams) {
  // Clear handler based on active tab
  const handleClear = useCallback(() => {
    switch (activeTab) {
      case "signals":
        clearDecoded();
        break;
      case "unmatched":
        clearUnmatchedFrames();
        break;
      case "filtered":
        clearFilteredFrames();
        break;
    }
  }, [activeTab, clearDecoded, clearUnmatchedFrames, clearFilteredFrames]);

  return {
    handleClear,
  };
}

export type DecoderCatalogHandlers = ReturnType<typeof useDecoderCatalogHandlers>;
