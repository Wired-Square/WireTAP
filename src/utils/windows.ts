// Window management utilities for Tauri multi-window support

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export type WindowLabel = 'catalog-editor' | 'decoder' | 'discovery' | 'frame-calculator' | 'transmit' | 'settings';

export interface WindowConfig {
  label: WindowLabel;
  title: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  url?: string;
  center?: boolean;
  resizable?: boolean;
}

const WINDOW_CONFIGS: Record<WindowLabel, Omit<WindowConfig, 'label'>> = {
  'catalog-editor': {
    title: 'Catalog Editor',
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    url: '/catalog-editor',
    center: true,
    resizable: true,
  },
  decoder: {
    title: 'CAN Decoder',
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    url: '/decoder',
    center: true,
    resizable: true,
  },
  discovery: {
    title: 'CAN Discovery',
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    url: '/discovery',
    center: true,
    resizable: true,
  },
  settings: {
    title: 'Settings',
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    url: '/settings',
    center: true,
    resizable: true,
  },
  'frame-calculator': {
    title: 'Frame Calculator',
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    url: '/frame-calculator',
    center: true,
    resizable: true,
  },
  transmit: {
    title: 'Transmit',
    width: 900,
    height: 650,
    minWidth: 800,
    minHeight: 550,
    url: '/transmit',
    center: true,
    resizable: true,
  },
};

/**
 * Open a new window or focus if already open
 */
export async function openWindow(
  label: WindowLabel,
  catalogPath?: string,
  skipCenter?: boolean
): Promise<WebviewWindow> {
  // Check if window already exists
  const existingWindow = await WebviewWindow.getByLabel(label);
  if (existingWindow) {
    await existingWindow.setFocus();
    return existingWindow;
  }

  const config = WINDOW_CONFIGS[label];

  // Build URL with query params if needed
  let url = config.url || '/';
  if (catalogPath && label === 'catalog-editor') {
    url += `?file=${encodeURIComponent(catalogPath)}`;
  }

  const window = new WebviewWindow(label, {
    title: config.title,
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    center: skipCenter ? false : (config.center ?? true),
    resizable: config.resizable ?? true,
    url,
  });

  return window;
}
