// ui/src/hooks/useSettings.ts

import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { loadSettings as loadSettingsApi, tlog } from '../api/settings';
import { getOrCreateDefaultDirs } from '../utils/defaultPaths';
import { WINDOW_EVENTS } from '../events/registry';
import { normalizeSettings, type AppSettings } from '../settings/appSettings';

// The settings type, IO-profile union, connection types/guards, defaults and
// normalisation now live in the neutral `settings/appSettings` module. Re-export
// them here so existing `../hooks/useSettings` consumers keep working unchanged.
export * from '../settings/appSettings';

export interface UseSettingsReturn {
  settings: AppSettings | null;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

/**
 * Hook to load and manage application settings (read-only projection of the
 * persisted settings; the settings store is the sole writer).
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
          tlog.info(`[useSettings] Could not get/create default directories: ${err}`);
        }
      }

      const normalized = normalizeSettings(rawSettings, defaultDirs);
      setSettings(normalized);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      tlog.info(`[useSettings] Failed to load settings: ${error}`);
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
