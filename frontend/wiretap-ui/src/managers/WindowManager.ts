// Window lifecycle manager for multi-window support

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { openWindow as openWindowUtil, type WindowLabel } from '../utils/windows';
import {
  saveWindowState,
  loadWindowState,
  saveOpenWindowsSession,
  type WindowGeometry,
} from '../utils/persistence';

interface WindowState {
  label: WindowLabel;
  instance: WebviewWindow | null;
}

class WindowManager {
  private registry: Map<WindowLabel, WindowState>;

  constructor() {
    this.registry = new Map();
  }

  /**
   * Open a window or focus if already open (single instance enforcement)
   */
  async openOrFocus(
    label: WindowLabel,
    options?: { catalogPath?: string }
  ): Promise<WebviewWindow> {
    console.log(`[WindowManager] Opening or focusing ${label}`);
    // Check if window already exists
    const existingWindow = await WebviewWindow.getByLabel(label);
    if (existingWindow) {
      console.log(`[WindowManager] Window ${label} already exists, focusing`);
      await existingWindow.setFocus();
      return existingWindow;
    }

    console.log(`[WindowManager] Creating new window ${label}`);
    // Create new window using utility function, skip auto-centering so we can restore geometry
    const window = await openWindowUtil(label, options?.catalogPath, true);

    // Register window
    this.registry.set(label, { label, instance: window });

    // Restore geometry if available, otherwise center the window
    await this.restoreGeometry(label);

    return window;
  }

  /**
   * Close a window by label
   */
  async closeWindow(label: WindowLabel): Promise<void> {
    const window = await WebviewWindow.getByLabel(label);
    if (window) {
      // Save geometry before closing
      await this.saveGeometry(label);
      await window.close();
      this.registry.delete(label);
    }
  }

  /**
   * Save current window geometry to persistent storage.
   *
   * Stores logical (point) coordinates — the native macOS coordinate system.
   * outerPosition()/outerSize() return physical pixels, so we divide by the
   * window's current scaleFactor to convert to points. On restore, LogicalPosition
   * and LogicalSize set the position/size in points directly, which is independent
   * of which monitor the window happens to start on.
   */
  async saveGeometry(label: string): Promise<void> {
    const window = await WebviewWindow.getByLabel(label);
    if (!window) return;

    try {
      const position = await window.outerPosition();
      const size = await window.outerSize();
      const scaleFactor = await window.scaleFactor();

      // Convert physical pixels → logical points
      const geometry = {
        x: Math.round(position.x / scaleFactor),
        y: Math.round(position.y / scaleFactor),
        width: Math.round(size.width / scaleFactor),
        height: Math.round(size.height / scaleFactor),
      };

      console.log(`[WindowManager] Saving ${label} geometry (logical):`, geometry);

      await saveWindowState(label, {
        geometry,
        wasOpen: true,
        lastFocused: Date.now(),
      });
    } catch (error) {
      console.error(`Failed to save geometry for ${label}:`, error);
    }
  }

  /**
   * Restore window geometry from persistent storage
   */
  async restoreGeometry(label: string): Promise<void> {
    const state = await loadWindowState(label);

    const window = await WebviewWindow.getByLabel(label);
    if (!window) {
      console.log(`[WindowManager] Window ${label} not found`);
      return;
    }

    if (!state?.geometry) {
      console.log(`[WindowManager] No saved geometry for ${label}, centering window`);
      await window.center();
      await window.show();
      await window.setFocus();
      return;
    }

    const { x, y, width, height } = state.geometry;
    console.log(`[WindowManager] Restoring ${label} geometry (logical):`, { x, y, width, height });

    // Validate geometry is within screen bounds (both in logical coords)
    const isOnScreen = await this.isGeometryOnScreen({ x, y, width, height });

    if (isOnScreen) {
      try {
        // Apply as logical (point) coordinates — works correctly across mixed-DPI monitors
        // because macOS positions windows in a global point coordinate space.
        await window.setSize(new LogicalSize(width, height));
        await window.setPosition(new LogicalPosition(x, y));

        await window.show();
        await window.setFocus();
        console.log(`[WindowManager] Successfully restored geometry for ${label}`);
      } catch (error) {
        console.error(`Failed to restore geometry for ${label}:`, error);
        await window.center();
        await window.show();
        await window.setFocus();
      }
    } else {
      console.log(`[WindowManager] Geometry off-screen, centering ${label}`);
      await window.center();
      await window.show();
      await window.setFocus();
    }
  }

  /**
   * Check if geometry is within current monitor bounds.
   * Saved geometry is in logical (point) coordinates, so we convert
   * monitor bounds from physical to logical for comparison.
   */
  private async isGeometryOnScreen(geometry: WindowGeometry): Promise<boolean> {
    try {
      const monitors = await availableMonitors();
      const { x, y, width, height } = geometry;

      return monitors.some((monitor) => {
        // Convert monitor physical bounds → logical (points)
        const scale = monitor.scaleFactor;
        const mx = monitor.position.x / scale;
        const my = monitor.position.y / scale;
        const mw = monitor.size.width / scale;
        const mh = monitor.size.height / scale;

        const monitorRight = mx + mw;
        const monitorBottom = my + mh;
        const windowRight = x + width;
        const windowBottom = y + height;

        // Check if window is at least partially visible on this monitor
        return (
          x < monitorRight &&
          windowRight > mx &&
          y < monitorBottom &&
          windowBottom > my
        );
      });
    } catch (error) {
      console.error('Failed to check monitor bounds:', error);
      return false;
    }
  }

  /**
   * Get all currently open window labels
   */
  async getAllOpenWindows(): Promise<WindowLabel[]> {
    const labels: WindowLabel[] = [
      'catalog-editor',
      'decoder',
      'discovery',
      'settings',
      'frame-calculator',
    ];

    const openWindows: WindowLabel[] = [];

    for (const label of labels) {
      const window = await WebviewWindow.getByLabel(label);
      if (window) {
        openWindows.push(label);
      }
    }

    return openWindows;
  }

  /**
   * Save current session (which windows are open)
   */
  async saveSession(): Promise<void> {
    const openWindows = await this.getAllOpenWindows();
    await saveOpenWindowsSession(openWindows);

    // Also save geometry for all open windows
    for (const label of openWindows) {
      await this.saveGeometry(label);
    }
  }
}

// Export singleton instance
export const windowManager = new WindowManager();
