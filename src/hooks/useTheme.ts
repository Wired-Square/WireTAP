// ui/src/hooks/useTheme.ts
//
// Global theme management hook. Applies dark/light mode class and CSS variables
// based on user settings. Listens for settings changes and system preference changes.

import { useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { loadSettings, tlog } from '../api/settings';
import { WINDOW_EVENTS } from '../events/registry';
import {
  type ThemeMode,
  type ThemeColours,
  defaultThemeColours,
} from '../apps/settings/stores/settingsStore';

export type ResolvedTheme = 'dark' | 'light';

interface ThemeState {
  mode: ThemeMode;
  colours: ThemeColours;
  resolvedTheme: ResolvedTheme;
}

/**
 * Apply theme CSS variables to the document root
 */
function applyThemeColours(colours: ThemeColours, isDark: boolean): void {
  const root = document.documentElement;

  // Set current mode colours based on resolved theme
  root.style.setProperty('--bg-primary', isDark ? colours.bgPrimaryDark : colours.bgPrimaryLight);
  root.style.setProperty('--bg-surface', isDark ? colours.bgSurfaceDark : colours.bgSurfaceLight);
  root.style.setProperty('--text-primary', isDark ? colours.textPrimaryDark : colours.textPrimaryLight);
  root.style.setProperty('--text-secondary', isDark ? colours.textSecondaryDark : colours.textSecondaryLight);
  root.style.setProperty('--border-default', isDark ? colours.borderDefaultDark : colours.borderDefaultLight);
  root.style.setProperty('--data-bg', isDark ? colours.dataBgDark : colours.dataBgLight);
  root.style.setProperty('--data-text-primary', isDark ? colours.dataTextPrimaryDark : colours.dataTextPrimaryLight);

  // Accent colours (mode-independent)
  root.style.setProperty('--accent-primary', colours.accentPrimary);
  root.style.setProperty('--accent-success', colours.accentSuccess);
  root.style.setProperty('--accent-danger', colours.accentDanger);
  root.style.setProperty('--accent-warning', colours.accentWarning);
}

/**
 * Apply dark mode class to document root
 */
function applyDarkMode(isDark: boolean): void {
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

/**
 * Resolve theme mode to actual dark/light based on system preference
 */
function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  // Auto: check system preference
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Extract theme colours from raw settings object
 */
function extractThemeColours(settings: Record<string, unknown>): ThemeColours {
  return {
    bgPrimaryLight: (settings.theme_bg_primary_light as string) || defaultThemeColours.bgPrimaryLight,
    bgSurfaceLight: (settings.theme_bg_surface_light as string) || defaultThemeColours.bgSurfaceLight,
    textPrimaryLight: (settings.theme_text_primary_light as string) || defaultThemeColours.textPrimaryLight,
    textSecondaryLight: (settings.theme_text_secondary_light as string) || defaultThemeColours.textSecondaryLight,
    borderDefaultLight: (settings.theme_border_default_light as string) || defaultThemeColours.borderDefaultLight,
    dataBgLight: (settings.theme_data_bg_light as string) || defaultThemeColours.dataBgLight,
    dataTextPrimaryLight: (settings.theme_data_text_primary_light as string) || defaultThemeColours.dataTextPrimaryLight,
    bgPrimaryDark: (settings.theme_bg_primary_dark as string) || defaultThemeColours.bgPrimaryDark,
    bgSurfaceDark: (settings.theme_bg_surface_dark as string) || defaultThemeColours.bgSurfaceDark,
    textPrimaryDark: (settings.theme_text_primary_dark as string) || defaultThemeColours.textPrimaryDark,
    textSecondaryDark: (settings.theme_text_secondary_dark as string) || defaultThemeColours.textSecondaryDark,
    borderDefaultDark: (settings.theme_border_default_dark as string) || defaultThemeColours.borderDefaultDark,
    dataBgDark: (settings.theme_data_bg_dark as string) || defaultThemeColours.dataBgDark,
    dataTextPrimaryDark: (settings.theme_data_text_primary_dark as string) || defaultThemeColours.dataTextPrimaryDark,
    accentPrimary: (settings.theme_accent_primary as string) || defaultThemeColours.accentPrimary,
    accentSuccess: (settings.theme_accent_success as string) || defaultThemeColours.accentSuccess,
    accentDanger: (settings.theme_accent_danger as string) || defaultThemeColours.accentDanger,
    accentWarning: (settings.theme_accent_warning as string) || defaultThemeColours.accentWarning,
  };
}

/**
 * Global theme management hook.
 *
 * - Loads theme settings on mount
 * - Applies dark/light class to document.documentElement
 * - Applies CSS variables for colours
 * - Listens for settings changes from other windows
 * - Listens for system preference changes (in auto mode)
 *
 * @example
 * ```tsx
 * // In your root component (Candor.tsx)
 * export default function Candor() {
 *   useTheme(); // Apply global theme
 *   return <MainLayout />;
 * }
 * ```
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>({
    mode: 'auto',
    colours: { ...defaultThemeColours },
    resolvedTheme: 'dark', // Default to dark to match current app appearance
  });

  // Apply theme when state changes
  const applyTheme = useCallback((mode: ThemeMode, colours: ThemeColours) => {
    const resolved = resolveTheme(mode);
    applyDarkMode(resolved === 'dark');
    applyThemeColours(colours, resolved === 'dark');
    setState({ mode, colours, resolvedTheme: resolved });
  }, []);

  // Load initial settings
  useEffect(() => {
    loadSettings()
      .then((settings) => {
        const s = settings as unknown as Record<string, unknown>;
        const mode = (s.theme_mode as ThemeMode) || 'auto';
        const colours = extractThemeColours(s);
        applyTheme(mode, colours);
      })
      .catch((err) => {
        tlog.info(`[useTheme] Failed to load theme settings: ${err}`);
        // Apply defaults on error
        applyTheme('auto', defaultThemeColours);
      });
  }, [applyTheme]);

  // Listen for settings changes from other windows
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{ settings: Record<string, unknown> }>(WINDOW_EVENTS.SETTINGS_CHANGED, (event) => {
      const settings = event.payload?.settings;
      if (settings) {
        const mode = (settings.theme_mode as ThemeMode) || 'auto';
        const colours = extractThemeColours(settings);
        applyTheme(mode, colours);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [applyTheme]);

  // Listen for system preference changes (only matters in auto mode)
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handler = () => {
      // Re-apply theme if in auto mode
      if (state.mode === 'auto') {
        applyTheme(state.mode, state.colours);
      }
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [state.mode, state.colours, applyTheme]);

  return state;
}
