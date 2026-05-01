// ui/src/hooks/useSettings.ts

import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { loadSettings as loadSettingsApi, tlog } from '../api/settings';
import { getOrCreateDefaultDirs } from '../utils/defaultPaths';
import { WINDOW_EVENTS } from '../events/registry';
import { getTraitsForKind, getProfileTraits, type Protocol } from '../utils/profileTraits';
import {
  DEFAULT_BUFFER_STORAGE,
  DEFAULT_CLEAR_BUFFERS_ON_START,
  DEFAULT_DISCOVERY_HISTORY_BUFFER,
  DEFAULT_QUERY_RESULT_LIMIT,
  DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
  DEFAULT_DECODER_MAX_FILTERED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
  DEFAULT_TRANSMIT_MAX_HISTORY,
  DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
} from '../apps/settings/stores/settingsStore';

// ============================================================================
// Profile Kind Type
// ============================================================================

export type ProfileKindId = 'mqtt' | 'postgres' | 'gvret_tcp' | 'gvret_usb' | 'serial' | 'slcan' | 'socketcan' | 'gs_usb' | 'modbus_tcp' | 'virtual' | 'framelink';

// ============================================================================
// Connection Interfaces (per profile kind)
// ============================================================================

export interface MqttConnection {
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  _password_stored?: boolean;
  formats?: {
    json?: { enabled: boolean; topic: string };
    savvycan?: { enabled: boolean; topic: string };
    decode?: { enabled: boolean; topic: string };
  };
}

export interface PostgresConnection {
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
  _password_stored?: boolean;
  sslmode?: string;
  source_type?: 'can_frame' | 'modbus_frame' | 'serial_frame' | 'serial_raw';
  default_speed?: string;
  framing_mode?: string;
}

/** Interface configuration for GVRET devices */
export interface GvretInterfaceConfig {
  device_bus: number;
  enabled: boolean;
  protocol: 'can' | 'canfd';
}

export interface GvretTcpConnection {
  host?: string;
  port?: string;
  timeout?: string;
  tcp_keepalive?: boolean;
  interfaces?: GvretInterfaceConfig[];
  _probed_bus_count?: number;
}

export interface GvretUsbConnection {
  port?: string;
  baud_rate?: string;
  interfaces?: GvretInterfaceConfig[];
  _probed_bus_count?: number;
}

export interface SerialConnection {
  port?: string;
  baud_rate?: string;
  data_bits?: string;
  stop_bits?: string;
  parity?: string;
  framing_mode?: string;
  framing_encoding?: string;
  delimiter?: string[] | string;
  max_frame_length?: number;
  min_frame_length?: number;
  emit_raw_bytes?: boolean;
  frame_id_config?: { start_byte: number; num_bytes: number; big_endian: boolean };
  source_address_config?: { start_byte: number; num_bytes: number; big_endian: boolean };
}

export interface SlcanConnection {
  port?: string;
  baud_rate?: string;
  data_bits?: string;
  stop_bits?: string;
  parity?: string;
  bitrate?: string;
  silent_mode?: boolean;
  enable_fd?: boolean;
  data_bitrate?: string;
}

export interface SocketcanConnection {
  interface?: string;
  bitrate?: string;
  enable_fd?: boolean;
  data_bitrate?: string;
}

export interface GsUsbConnection {
  device_id?: string;
  bus?: string;
  address?: string;
  serial?: string;
  interface?: string;
  bitrate?: string;
  sample_point?: string;
  listen_only?: boolean;
  channel?: string;
  enable_fd?: boolean;
  data_bitrate?: string;
  data_sample_point?: string;
}

export interface ModbusTcpConnection {
  host?: string;
  port?: string;
  unit_id?: string;
}

export interface FrameLinkInterfaceConfig {
  index: number;
  iface_type: number;
  name: string;
  type_name?: string;
}

export interface FrameLinkConnection {
  host?: string;
  port?: string;
  timeout?: string;
  device_id?: string;
  board_name?: string;
  board_revision?: string;
  interfaces?: FrameLinkInterfaceConfig[];
  // Legacy single-interface fields (pre-migration)
  interface_index?: number;
  interface_type?: number;
  interface_name?: string;
}

export interface VirtualInterfaceConfig {
  bus: number;
  signal_generator: boolean;
  frame_rate_hz: number | string;
}

export interface VirtualConnection {
  traffic_type?: 'can' | 'canfd' | 'modbus' | 'serial';
  loopback?: boolean;
  interfaces?: VirtualInterfaceConfig[];
  // Legacy fields
  bus_count?: string;
  frame_rate_hz?: number | string;
  signal_generator?: boolean;
}

// ============================================================================
// Connection type map (kind → connection interface)
// ============================================================================

export interface ConnectionTypeMap {
  mqtt: MqttConnection;
  postgres: PostgresConnection;
  gvret_tcp: GvretTcpConnection;
  gvret_usb: GvretUsbConnection;
  serial: SerialConnection;
  slcan: SlcanConnection;
  socketcan: SocketcanConnection;
  gs_usb: GsUsbConnection;
  modbus_tcp: ModbusTcpConnection;
  virtual: VirtualConnection;
  framelink: FrameLinkConnection;
}

// ============================================================================
// IOProfile — discriminated union
// ============================================================================

/** Base fields shared by all profile kinds */
interface IOProfileBase {
  id: string;
  name: string;
  preferred_catalog?: string;
}

/** IOProfile discriminated union — connection type depends on kind */
export type IOProfile = {
  [K in ProfileKindId]: IOProfileBase & {
    kind: K;
    connection: ConnectionTypeMap[K];
  };
}[ProfileKindId];

/**
 * Narrow an IOProfile to a specific kind.
 * Usage: `if (isProfileKind(profile, "framelink")) { profile.connection.interfaces }`
 */
export function isProfileKind<K extends ProfileKindId>(
  profile: IOProfile,
  kind: K,
): profile is Extract<IOProfile, { kind: K }> {
  return profile.kind === kind;
}

/** Union of all value types that can appear in connection fields */
export type ConnectionFieldValue =
  | string
  | boolean
  | number
  | GvretInterfaceConfig[]
  | FrameLinkInterfaceConfig[]
  | VirtualInterfaceConfig[]
  | string[]
  | { start_byte: number; num_bytes: number; big_endian: boolean }
  | MqttConnection['formats'];

/** @deprecated Use Protocol from profileTraits.ts instead */
export type ReaderProtocol = Protocol;

/**
 * Get display-friendly protocol(s) for a reader kind.
 * Delegates to getProfileTraits() for config-aware protocol detection,
 * then filters for display (e.g., shows only "CAN-FD" when FD is enabled,
 * since CAN is implied by CAN-FD).
 */
export function getReaderProtocols(kind: IOProfile['kind'], connection?: IOProfile['connection']): ReaderProtocol[] {
  const traits = getProfileTraits({ id: '', name: '', kind, connection: connection ?? {} } as IOProfile);
  if (!traits) return ['can'];

  const protocols = traits.protocols.filter(
    (p): p is ReaderProtocol => ['can', 'canfd', 'serial', 'modbus'].includes(p)
  );

  // For display: if CAN-FD is present, omit base "can" (CAN-FD implies CAN)
  if (protocols.includes('canfd') && protocols.includes('can')) {
    return protocols.filter((p) => p !== 'can');
  }

  return protocols.length > 0 ? protocols : ['can'];
}

/** Check if a reader kind is realtime (hardware) vs historical (replay) */
export function isReaderRealtime(kind: IOProfile['kind']): boolean {
  const traits = getTraitsForKind(kind);
  return traits?.temporalMode === 'realtime';
}

export type FrameIdFormat = "hex" | "decimal";
export type TimeFormat = "delta-last" | "delta-start" | "timestamp" | "human";
export type DefaultFrameType = "can" | "modbus" | "serial";
export type ThemeMode = "dark" | "light" | "auto";

export interface AppSettings {
  config_path: string;
  decoder_dir: string;
  dump_dir: string;
  report_dir: string;
  io_profiles: IOProfile[];
  default_read_profile?: string | null;
  default_write_profiles?: string[];
  display_frame_id_format?: FrameIdFormat;
  save_frame_id_format?: FrameIdFormat;
  display_time_format?: TimeFormat;
  display_timezone?: 'local' | 'utc';
  default_frame_type?: DefaultFrameType;
  signal_colour_none?: string;
  signal_colour_low?: string;
  signal_colour_medium?: string;
  signal_colour_high?: string;
  binary_one_colour?: string;
  binary_zero_colour?: string;
  binary_unused_colour?: string;
  discovery_history_buffer?: number;
  query_result_limit?: number;
  session_manager_stats_interval?: number;
  graph_buffer_size?: number;
  // Theme settings
  theme_mode?: ThemeMode;
  theme_bg_primary_light?: string;
  theme_bg_surface_light?: string;
  theme_text_primary_light?: string;
  theme_text_secondary_light?: string;
  theme_border_default_light?: string;
  theme_data_bg_light?: string;
  theme_data_text_primary_light?: string;
  theme_bg_primary_dark?: string;
  theme_bg_surface_dark?: string;
  theme_text_primary_dark?: string;
  theme_text_secondary_dark?: string;
  theme_border_default_dark?: string;
  theme_data_bg_dark?: string;
  theme_data_text_primary_dark?: string;
  theme_accent_primary?: string;
  theme_accent_success?: string;
  theme_accent_danger?: string;
  theme_accent_warning?: string;
  // Power management
  prevent_idle_sleep?: boolean;
  keep_display_awake?: boolean;
  // Diagnostics
  log_level?: string; // "off" | "info" | "debug" | "verbose"
  // Privacy / telemetry
  telemetry_enabled?: boolean;
  telemetry_consent_given?: boolean;
  // Buffer persistence
  clear_captures_on_start?: boolean;
  /** Buffer storage backend ("sqlite" is the only option for now) */
  buffer_storage?: string;
  // Decoder buffer limits
  decoder_max_unmatched_frames?: number;
  decoder_max_filtered_frames?: number;
  decoder_max_decoded_frames?: number;
  decoder_max_decoded_per_source?: number;
  // Transmit limits
  transmit_max_history?: number;
  // Modbus settings
  modbus_max_register_errors?: number;
  /** SMP UDP port for firmware upgrades (default 1337) */
  smp_port?: number;
  /** UI language code (BCP 47, e.g. "en-AU"). Drives i18next translations. */
  language?: string;
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
    discovery_history_buffer: settings.discovery_history_buffer ?? DEFAULT_DISCOVERY_HISTORY_BUFFER,
    query_result_limit: settings.query_result_limit ?? DEFAULT_QUERY_RESULT_LIMIT,
    // Theme settings
    theme_mode: settings.theme_mode ?? "auto",
    theme_bg_primary_light: settings.theme_bg_primary_light || "#ffffff",
    theme_bg_surface_light: settings.theme_bg_surface_light || "#f8fafc",
    theme_text_primary_light: settings.theme_text_primary_light || "#0f172a",
    theme_text_secondary_light: settings.theme_text_secondary_light || "#334155",
    theme_border_default_light: settings.theme_border_default_light || "#e2e8f0",
    theme_data_bg_light: settings.theme_data_bg_light || "#f8fafc",
    theme_data_text_primary_light: settings.theme_data_text_primary_light || "#0f172a",
    theme_bg_primary_dark: settings.theme_bg_primary_dark || "#0f172a",
    theme_bg_surface_dark: settings.theme_bg_surface_dark || "#1e293b",
    theme_text_primary_dark: settings.theme_text_primary_dark || "#ffffff",
    theme_text_secondary_dark: settings.theme_text_secondary_dark || "#cbd5e1",
    theme_border_default_dark: settings.theme_border_default_dark || "#334155",
    theme_data_bg_dark: settings.theme_data_bg_dark || "#111827",
    theme_data_text_primary_dark: settings.theme_data_text_primary_dark || "#e5e7eb",
    theme_accent_primary: settings.theme_accent_primary || "#2563eb",
    theme_accent_success: settings.theme_accent_success || "#16a34a",
    theme_accent_danger: settings.theme_accent_danger || "#dc2626",
    theme_accent_warning: settings.theme_accent_warning || "#d97706",
    // Privacy / telemetry
    telemetry_enabled: settings.telemetry_enabled ?? false,
    telemetry_consent_given: settings.telemetry_consent_given ?? false,
    // Buffer persistence
    clear_captures_on_start: settings.clear_captures_on_start ?? DEFAULT_CLEAR_BUFFERS_ON_START,
    buffer_storage: settings.buffer_storage ?? DEFAULT_BUFFER_STORAGE,
    // Decoder buffer limits
    decoder_max_unmatched_frames: settings.decoder_max_unmatched_frames ?? DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
    decoder_max_filtered_frames: settings.decoder_max_filtered_frames ?? DEFAULT_DECODER_MAX_FILTERED_FRAMES,
    decoder_max_decoded_frames: settings.decoder_max_decoded_frames ?? DEFAULT_DECODER_MAX_DECODED_FRAMES,
    decoder_max_decoded_per_source: settings.decoder_max_decoded_per_source ?? DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
    // Transmit limits
    transmit_max_history: settings.transmit_max_history ?? DEFAULT_TRANSMIT_MAX_HISTORY,
    // Modbus settings
    modbus_max_register_errors: settings.modbus_max_register_errors ?? DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
    // Localisation
    language: settings.language || "en-AU",
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
