// Hook for automatic window geometry persistence (save on resize/move, restore on mount)

import { useEffect, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { windowManager } from '../managers/WindowManager';
import { tlog } from '../api/settings';

/**
 * Hook to automatically save and restore window geometry.
 *
 * On mount: restores saved geometry (position + size) from persistent storage.
 * During use: debounced saves on resize/move events.
 *
 * IMPORTANT: We do NOT save geometry in onCloseRequested because:
 * 1. Async operations during window close race with WebView destruction
 * 2. This causes crashes in WebKit::WebPageProxy::dispatchSetObscuredContentInsets()
 *    on macOS 26.2 (Tahoe) and later
 * 3. The debounced saves on resize/move are sufficient for persistence
 *
 * @param label - Window label (any string, supports dashboard/main-N/secondary windows)
 */
export function useWindowPersistence(label: string) {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allowSavingRef = useRef(false);
  const isClosingRef = useRef(false);

  // Restore geometry on mount
  useEffect(() => {
    windowManager.restoreGeometry(label).catch((error) => {
      tlog.info(`[useWindowPersistence] Failed to restore geometry for ${label}: ${error}`);
    });
  }, [label]);

  // Save geometry on resize/move
  useEffect(() => {
    tlog.info(`[useWindowPersistence] Setting up persistence for ${label}`);
    const currentWindow = getCurrentWebviewWindow();

    // Reset refs on (re-)mount — required for React Strict Mode which unmounts/remounts
    // effects in development. The cleanup sets isClosingRef=true, so without this reset
    // all saves would be permanently blocked after the Strict Mode re-mount.
    isClosingRef.current = false;
    allowSavingRef.current = false;

    // Don't save geometry changes for the first 2 seconds after window creation
    // This prevents saving the intermediate sizes during initial rendering
    const initTimer = setTimeout(() => {
      tlog.info(`[useWindowPersistence] Enabling geometry saving for ${label}`);
      allowSavingRef.current = true;
    }, 2000);

    const debouncedSave = () => {
      // Don't save if window is closing or not yet initialized
      if (!allowSavingRef.current || isClosingRef.current) {
        return;
      }

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        // Double-check we're not closing before saving
        // Use sync check to avoid any async operations if closing
        if (isClosingRef.current) {
          return;
        }
        // Fire and forget - don't await to avoid holding references
        windowManager.saveGeometry(label).catch(() => {
          // Ignore errors - window may be closing
        });
      }, 500); // Debounce 500ms
    };

    // Listen for resize and move events
    const unlistenResize = currentWindow.onResized(debouncedSave);
    const unlistenMove = currentWindow.onMoved(debouncedSave);

    // On close: just cancel pending saves, don't try to save
    // The most recent debounced save will have captured the geometry
    const unlistenClose = currentWindow.onCloseRequested(() => {
      isClosingRef.current = true;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      // Don't await anything here - let the window close immediately
    });

    // Cleanup
    return () => {
      isClosingRef.current = true;
      clearTimeout(initTimer);
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      unlistenResize.then((fn) => fn());
      unlistenMove.then((fn) => fn());
      unlistenClose.then((fn) => fn());
    };
  }, [label]);
}
