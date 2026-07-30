// ui/src/utils/windowCommunication.ts
// Cross-panel communication utilities

import { useCalculatorStore } from "../stores/calculatorStore";
import {
  useCatalogEditorStore,
  type PendingCatalogUpdate,
} from "../stores/catalogEditorStore";

// Reference to open panel function - will be set by MainLayout
let openPanelFn: ((panelId: string) => void) | null = null;

/**
 * Register the panel open function from MainLayout.
 * This allows other parts of the app to open panels programmatically.
 */
export function registerOpenPanelFn(fn: (panelId: string) => void): void {
  openPanelFn = fn;
}

/**
 * Unregister the panel open function.
 */
export function unregisterOpenPanelFn(): void {
  openPanelFn = null;
}

/**
 * Open a panel by ID.
 * @param panelId - The panel ID to open (e.g., "discovery", "decoder")
 */
export function openPanel(panelId: string): void {
  if (openPanelFn) {
    openPanelFn(panelId);
  }
}

/**
 * Send hex data to the frame calculator panel.
 * Opens the panel if not already open, then sets the pending hex data.
 *
 * @param hexData - Hex string to send (e.g., "0a1b2c3d")
 */
export function sendHexDataToCalculator(hexData: string): void {
  // Set the pending hex data in the store
  useCalculatorStore.getState().setPendingHexData(hexData);

  // Open/focus the calculator panel
  if (openPanelFn) {
    openPanelFn("frame-calculator");
  }
}

/**
 * Hand an upstream catalogue update to the Catalog editor for review.
 *
 * Only the editor can show it — the update loads as the working buffer with the
 * on-disk copy as the diff baseline, so it reads as a saveable diff. Routed through
 * the panel registry rather than a prop so it works from anywhere (Settings has no
 * editor to pass a callback to), following `sendHexDataToCalculator`.
 */
export function sendUpdateToCatalogEditor(update: PendingCatalogUpdate): void {
  useCatalogEditorStore.getState().setPendingRemoteUpdate(update);
  if (openPanelFn) {
    openPanelFn("catalog-editor");
  }
}

