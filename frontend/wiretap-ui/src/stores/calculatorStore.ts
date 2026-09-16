// ui/src/stores/calculatorStore.ts
// Store for Frame Calculator state and cross-panel communication

import { create } from "zustand";

interface CalculatorState {
  // Pending hex data from other panels
  pendingHexData: string | null;

  // Actions
  setPendingHexData: (hexData: string) => void;
  clearPendingHexData: () => void;
}

export const useCalculatorStore = create<CalculatorState>((set) => ({
  pendingHexData: null,

  setPendingHexData: (hexData: string) => {
    set({ pendingHexData: hexData });
  },

  clearPendingHexData: () => {
    set({ pendingHexData: null });
  },
}));
