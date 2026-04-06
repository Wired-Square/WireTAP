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

  // Window lifecycle events
  WINDOW_OPENED: 'window:opened',
  WINDOW_CLOSING: 'window:closing',
  WINDOW_FOCUSED: 'window:focused',
  WINDOW_READY: 'window:ready',

  // Session events
  RESTORE_SESSION: 'restore-session',

  // Frame calculator events
  LOAD_HEX_DATA: 'calculator:load-hex',
} as const;

export interface CatalogSavedPayload {
  catalogPath: string;
  timestamp: number;
}

export interface SettingsChangedPayload {
  settings: Record<string, unknown>;
}

export interface WindowLifecyclePayload {
  label: string;
  timestamp: number;
}

export interface WindowReadyPayload {
  label: string;
  timestamp: number;
}

export interface LoadHexDataPayload {
  hexData: string;
  timestamp: number;
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
