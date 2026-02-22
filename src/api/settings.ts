// ui/src/api/settings.ts
// Settings-related Tauri commands

import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../hooks/useSettings";

/**
 * Load application settings from the backend
 */
export async function loadSettings(): Promise<AppSettings> {
  return await invoke<AppSettings>("load_settings");
}

/**
 * Save application settings to the backend
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

/**
 * Validate that a directory exists and is writable
 */
export async function validateDirectory(path: string): Promise<{ exists: boolean; writable: boolean; error?: string }> {
  return await invoke("validate_directory", { path });
}

/**
 * Create a directory at the given path
 */
export async function createDirectory(path: string): Promise<void> {
  await invoke("create_directory", { path });
}

/**
 * Get the application version
 */
export async function getAppVersion(): Promise<string> {
  return await invoke<string>("get_app_version");
}

/**
 * Information about an available update
 */
export interface UpdateInfo {
  version: string;
  url: string;
}

/**
 * Check for available updates from GitHub releases
 * Returns update info if a newer version is available, null otherwise
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  return await invoke<UpdateInfo | null>("check_for_updates");
}

/**
 * Notify the backend that the Settings panel has been closed.
 * This clears the singleton tracking, allowing Settings to be opened in a different window.
 */
export async function settingsPanelClosed(): Promise<void> {
  await invoke("settings_panel_closed");
}

/**
 * Open the Settings panel with singleton behavior.
 * If Settings is already open in another window, focuses that window instead.
 */
export async function openSettingsPanel(): Promise<void> {
  await invoke("open_settings_panel");
}

/**
 * Update the wake lock settings in the backend.
 * This updates the cached settings that control whether the system is
 * prevented from sleeping during active sessions.
 */
export async function setWakeSettings(
  preventIdleSleep: boolean,
  keepDisplayAwake: boolean
): Promise<void> {
  await invoke("set_wake_settings", {
    prevent_idle_sleep: preventIdleSleep,
    keep_display_awake: keepDisplayAwake,
  });
}

/**
 * Set the log level and start/stop file logging accordingly.
 * Levels: "off" | "info" | "debug" | "verbose"
 */
export async function setLogLevel(level: string): Promise<void> {
  await invoke("set_log_level", { level });
}

/**
 * Levelled frontend logging — sends messages to the backend log file (and stderr).
 * Messages are filtered by the current log level threshold set in Settings.
 * Fire-and-forget — errors are silently ignored.
 */
export const tlog = {
  info: (message: string): void => {
    invoke("log_from_frontend", { level: "info", message }).catch(() => {});
  },
  debug: (message: string): void => {
    invoke("log_from_frontend", { level: "debug", message }).catch(() => {});
  },
  verbose: (message: string): void => {
    invoke("log_from_frontend", { level: "verbose", message }).catch(() => {});
  },
};
