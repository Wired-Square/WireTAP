// ui/src/hooks/useSettings.ts

import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { loadSettings as loadSettingsApi } from '../api/settings';
import { getOrCreateDefaultDirs } from '../utils/defaultPaths';
import { WINDOW_EVENTS } from '../events/registry';

export interface IOProfile {
  id: string;
  name: string;
  kind: 'mqtt' | 'postgres' | 'gvret_tcp' | 'gvret_usb' | 'csv_file' | 'serial' | 'slcan' | 'socketcan' | 'gs_usb';
  connection: Record<string, any>;
}

/** Protocol types that a reader can provide */
export type ReaderProtocol = 'can' | 'serial' | 'modbus';

/** Get the protocol(s) supported by a reader kind */
export function getReaderProtocols(kind: IOProfile['kind'], connection?: Record<string, any>): ReaderProtocol[] {
  switch (kind) {
    case 'gvret_tcp':
    case 'gvret_usb':
    case 'slcan':
    case 'socketcan':
    case 'gs_usb':
      return ['can'];
    case 'serial':
      return ['serial'];
    case 'postgres': {
      // PostgreSQL protocol depends on source_type configuration
      const sourceType = connection?.source_type || 'can_frame';
      switch (sourceType) {
        case 'can_frame':
          return ['can'];
        case 'modbus_frame':
          return ['modbus'];
        case 'serial_frame':
        case 'serial_raw':
          return ['serial'];
        default:
          return ['can'];
      }
    }
    case 'csv_file':
      return ['can']; // CSV files are CAN frames
    case 'mqtt':
      return ['can']; // MQTT typically carries CAN frames
    default:
      return ['can'];
  }
}

/** Check if a reader kind is realtime (hardware) vs historical (replay) */
export function isReaderRealtime(kind: IOProfile['kind']): boolean {
  switch (kind) {
    case 'gvret_tcp':
    case 'gvret_usb':
    case 'slcan':
    case 'socketcan':
    case 'gs_usb':
    case 'serial':
    case 'mqtt':
      return true;
    case 'postgres':
    case 'csv_file':
      return false;
    default:
      return true;
  }
}

export type FrameIdFormat = "hex" | "decimal";
export type TimeFormat = "delta-last" | "delta-start" | "timestamp" | "human";
export type DefaultFrameType = "can" | "modbus" | "serial";

export interface AppSettings {
  config_path: string;
  decoder_dir: string;
  dump_dir: string;
  report_dir: string;
  io_profiles: IOProfile[];
  default_read_profile?: string | null;
  default_write_profiles?: string[];
  default_catalog?: string | null;
  display_frame_id_format?: FrameIdFormat;
  save_frame_id_format?: FrameIdFormat;
  display_time_format?: TimeFormat;
  default_frame_type?: DefaultFrameType;
  signal_colour_none?: string;
  signal_colour_low?: string;
  signal_colour_medium?: string;
  signal_colour_high?: string;
  binary_one_colour?: string;
  binary_zero_colour?: string;
  binary_unused_colour?: string;
  discovery_history_buffer?: number;
}

/**
 * Normalizes settings from the backend, applying defaults for missing fields
 */
function normalizeSettings(
  settings: Partial<AppSettings>,
  defaultDirs?: { decoders: string; dumps: string; reports: string } | null
): AppSettings {
  return {
    config_path: settings.config_path || '',
    decoder_dir: settings.decoder_dir || defaultDirs?.decoders || '',
    dump_dir: settings.dump_dir || defaultDirs?.dumps || '',
    report_dir: settings.report_dir || defaultDirs?.reports || '',
    io_profiles: settings.io_profiles || [],
    default_read_profile: settings.default_read_profile ?? null,
    default_write_profiles: settings.default_write_profiles ?? [],
    default_catalog: settings.default_catalog ?? null,
    display_frame_id_format: settings.display_frame_id_format === "decimal" ? "decimal" : "hex",
    save_frame_id_format: settings.save_frame_id_format === "decimal" ? "decimal" : "hex",
    display_time_format: settings.display_time_format ?? "human",
    default_frame_type: settings.default_frame_type ?? "can",
    signal_colour_none: settings.signal_colour_none || "#94a3b8",
    signal_colour_low: settings.signal_colour_low || "#f59e0b",
    signal_colour_medium: settings.signal_colour_medium || "#3b82f6",
    signal_colour_high: settings.signal_colour_high || "#22c55e",
    binary_one_colour: settings.binary_one_colour || "#14b8a6",
    binary_zero_colour: settings.binary_zero_colour || "#94a3b8",
    binary_unused_colour: settings.binary_unused_colour || "#64748b",
    discovery_history_buffer: settings.discovery_history_buffer ?? 100000,
  };
}

export interface UseSettingsReturn {
  settings: AppSettings | null;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

/**
 * Hook to load and manage application settings
 *
 * @example
 * ```tsx
 * const { settings, loading, error, reload } = useSettings();
 *
 * if (loading) return <div>Loading...</div>;
 * if (error) return <div>Error: {error.message}</div>;
 * if (!settings) return null;
 *
 * return <div>Decoder dir: {settings.decoder_dir}</div>;
 * ```
 */
export function useSettings(): UseSettingsReturn {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rawSettings = await loadSettingsApi();

      // Get default directories for empty paths
      let defaultDirs: { decoders: string; dumps: string; reports: string } | null = null;
      if (!rawSettings.decoder_dir || !rawSettings.dump_dir || !rawSettings.report_dir) {
        try {
          defaultDirs = await getOrCreateDefaultDirs();
        } catch (err) {
          console.warn('Could not get/create default directories:', err);
        }
      }

      const normalized = normalizeSettings(rawSettings, defaultDirs);
      setSettings(normalized);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Listen for settings changes from other windows
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen(WINDOW_EVENTS.SETTINGS_CHANGED, () => {
      loadSettings();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [loadSettings]);

  return {
    settings,
    loading,
    error,
    reload: loadSettings,
  };
}

/**
 * Helper function to get display frame ID format from settings
 */
export const getDisplayFrameIdFormat = (settings?: AppSettings | null): FrameIdFormat =>
  settings?.display_frame_id_format === "decimal" ? "decimal" : "hex";

/**
 * Helper function to get save frame ID format from settings
 */
export const getSaveFrameIdFormat = (settings?: AppSettings | null): FrameIdFormat =>
  settings?.save_frame_id_format === "decimal" ? "decimal" : "hex";
