// ui/src/constants.ts
// Global constants for the WireTAP application
// Add new constants here for maintainability and single source of truth

// =============================================================================
// CAN Protocol Constants
// =============================================================================

/** Maximum data bytes for standard CAN frames */
export const CAN_MAX_BYTES = 8;

/** Maximum data bytes for CAN FD frames */
export const CAN_FD_MAX_BYTES = 64;

/** Valid DLC values for CAN FD frames (standard CAN uses 0-8) */
export const CAN_FD_DLC_VALUES = [8, 12, 16, 20, 24, 32, 48, 64] as const;

// =============================================================================
// UI Timing Constants
// =============================================================================

/** Interval (ms) for batching UI updates in frame-consuming apps (Decoder, Graph) */
export const UI_UPDATE_INTERVAL_MS = 100;

/** Feedback duration (ms) after a copy-to-clipboard action */
export const COPY_FEEDBACK_TIMEOUT_MS = 2000;

/** Interval (ms) for updating the realtime clock display */
export const REALTIME_CLOCK_INTERVAL_MS = 1000;

/** Poll interval (ms) for buffer tail/frame view updates */
export const BUFFER_POLL_INTERVAL_MS = 200;

/** Debounce (ms) for device probe actions (slcan, gs_usb) */
export const PROBE_DEBOUNCE_MS = 500;

/** Debounce (ms) after data mutation before refreshing activity state */
export const REFRESH_ACTIVITY_DELAY_MS = 500;

/** Yield delay (ms) for async analysis tasks to allow React rendering */
export const ANALYSIS_YIELD_MS = 50;

// =============================================================================
// Locale Constants
// =============================================================================

/** Locale for 24-hour time formatting (HH:mm:ss) */
export const LOCALE_TIME_24H = 'en-GB';

/** Locale for ISO-like date/time formatting (yyyy-MM-dd HH:mm:ss) */
export const LOCALE_ISO_LIKE = 'sv-SE';
