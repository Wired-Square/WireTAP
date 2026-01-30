// Window state persistence using centralised store manager
//
// Uses the Rust-side store manager via IPC for multi-window support.
// No file locking issues since all windows share the same backend store.

import { storeGet, storeSet } from '../api/store';
import type { WindowLabel } from './windows';

// Track all open main windows (dashboard + any additional windows)
const MAIN_WINDOWS_KEY = 'windows.mainWindows';

/**
 * Get list of main window labels that were open in last session
 */
export async function getOpenMainWindows(): Promise<string[]> {
  const windows = await storeGet<string[]>(MAIN_WINDOWS_KEY);
  return windows || ['dashboard']; // Always include dashboard
}

/**
 * Save list of currently open main window labels
 */
export async function saveOpenMainWindows(labels: string[]): Promise<void> {
  // Always ensure dashboard is included
  const uniqueLabels = [...new Set(['dashboard', ...labels])];
  await storeSet(MAIN_WINDOWS_KEY, uniqueLabels);
}

/**
 * Add a window to the open windows list
 */
export async function addOpenMainWindow(label: string): Promise<void> {
  const current = await getOpenMainWindows();
  if (!current.includes(label)) {
    await saveOpenMainWindows([...current, label]);
  }
}

/**
 * Remove a window from the open windows list
 */
export async function removeOpenMainWindow(label: string): Promise<void> {
  if (label === 'dashboard') return; // Never remove dashboard
  const current = await getOpenMainWindows();
  await saveOpenMainWindows(current.filter(l => l !== label));
}

/**
 * Get the next available main window number
 */
export async function getNextMainWindowNumber(): Promise<number> {
  const current = await getOpenMainWindows();
  let maxNum = 0;
  for (const label of current) {
    const match = label.match(/^main-(\d+)$/);
    if (match) {
      maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
  }
  return maxNum + 1;
}

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPersistence {
  geometry: WindowGeometry;
  wasOpen: boolean;
  lastFocused?: number; // timestamp
}

/**
 * Save window state to persistent storage
 */
export async function saveWindowState(
  label: WindowLabel,
  state: WindowPersistence
): Promise<void> {
  await storeSet(`windows.state.${label}`, state);
}

/**
 * Load window state from persistent storage
 */
export async function loadWindowState(
  label: WindowLabel
): Promise<WindowPersistence | null> {
  const state = await storeGet<WindowPersistence>(`windows.state.${label}`);
  return state || null;
}

/**
 * Save list of currently open windows for session restore
 */
export async function saveOpenWindowsSession(labels: WindowLabel[]): Promise<void> {
  await storeSet('windows.openSession', labels);
}
