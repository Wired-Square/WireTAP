// Event registry for inter-window communication

import type { BufferMetadata } from "../api/buffer";

export const WINDOW_EVENTS = {
  // Catalog events
  CATALOG_SAVED: 'catalog:saved',

  // Settings events
  SETTINGS_CHANGED: 'settings:changed',

  // Buffer events
  BUFFER_CHANGED: 'buffer:changed',

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

export interface BufferChangedPayload {
  /** Null if buffer was cleared */
  metadata: BufferMetadata | null;
  /** What triggered this change: "ingested", "streamed", "imported", "cleared" */
  action?: "ingested" | "streamed" | "imported" | "cleared";
  timestamp?: number;
}
