// src/utils/platform.ts
//
// Platform detection utilities using Tauri's os plugin.

import { platform, type Platform } from "@tauri-apps/plugin-os";

let cachedPlatform: Platform | null = null;

/**
 * Get the current platform.
 * Returns: "linux", "macos", "ios", "freebsd", "dragonfly", "netbsd",
 *          "openbsd", "solaris", "android", "windows"
 */
export async function getPlatform(): Promise<Platform> {
  if (!cachedPlatform) {
    cachedPlatform = await platform();
  }
  return cachedPlatform;
}

/**
 * Check if running on Windows.
 */
export async function isWindows(): Promise<boolean> {
  return (await getPlatform()) === "windows";
}

/**
 * Check if running on Linux.
 */
export async function isLinux(): Promise<boolean> {
  return (await getPlatform()) === "linux";
}

/**
 * Check if running on macOS.
 */
export async function isMacOS(): Promise<boolean> {
  return (await getPlatform()) === "macos";
}

/**
 * Check if running on iOS.
 */
export async function isIOS(): Promise<boolean> {
  return (await getPlatform()) === "ios";
}

/**
 * Set iOS screen wake state.
 * Only has effect on iOS - no-op on other platforms.
 * Uses dynamic import to avoid loading the plugin on non-iOS platforms.
 */
export async function setIOSScreenWake(enabled: boolean): Promise<void> {
  if (!(await isIOS())) return;

  try {
    const { keepScreenOn } = await import("tauri-plugin-keep-screen-on-api");
    await keepScreenOn(enabled);
  } catch (err) {
    console.warn("Failed to set iOS screen wake:", err);
  }
}
