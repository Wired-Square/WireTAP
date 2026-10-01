// Event registry for inter-window communication

import type { CaptureMetadata } from "../api/capture";

export const WINDOW_EVENTS = {
  // Catalog events
  CATALOG_SAVED: 'catalog:saved',

  // Settings events
  SETTINGS_CHANGED: 'settings:changed',

  // Capture events
  CAPTURE_CHANGED: 'capture:changed',
  CAPTURE_METADATA_UPDATED: 'capture:metadata-updated',
} as const;

export interface CatalogSavedPayload {
  catalogPath: string;
  timestamp: number;
}

export interface SettingsChangedPayload {
  settings: Record<string, unknown>;
}

export interface CaptureMetadataUpdatedPayload {
  /** Capture ID that was updated */
  captureId: string;
  /** New name (if renamed) */
  name?: string;
  /** New persistent flag (if changed) */
  persistent?: boolean;
}

export interface CaptureChangedPayload {
  /** Null if capture was cleared */
  metadata: CaptureMetadata | null;
  /** What triggered this change: "ingested", "streamed", "imported", "cleared" */
  action?: "ingested" | "streamed" | "imported" | "cleared";
  /** Capture IDs that were deleted (for cross-window cleanup) */
  deletedCaptureIds?: string[];
  timestamp?: number;
}
