// ui/src/settings/appSettings.ts
//
// The single source of truth for the application settings shape: the
// `AppSettings` type, the IO-profile discriminated union and its connection
// types/guards, the default constants, and one `normalizeSettings` routine.
//
// This is a neutral module that neither `hooks/useSettings.ts` nor
// `apps/settings/stores/settingsStore.ts` depend on each other for — both import
// from here (and re-export for their existing consumers), which breaks the old
// import cycle between them and removes the duplicated type + default definitions.

import { getTraitsForKind, getProfileTraits, type Protocol } from "../utils/profileTraits";

// ============================================================================
// Profile Kind Type
// ============================================================================

export type ProfileKindId =
  | "mqtt"
  | "postgres"
  | "wiretap"
  | "gvret_tcp"
  | "gvret_usb"
  | "serial"
  | "slcan"
  | "socketcan"
  | "gs_usb"
  | "modbus_tcp"
  | "virtual"
  | "framelink";

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
  source_type?: "can_frame" | "modbus_frame" | "serial_frame" | "serial_raw";
  default_speed?: string;
  framing_mode?: string;
}

/** Connection to a WireTAP backend gateway (HTTP API, not direct Postgres) */
export interface WiretapConnection {
  url?: string;
  database?: string;
  api_key?: string;
  _api_key_stored?: boolean;
  default_speed?: string;
}

/** Interface configuration for GVRET devices */
export interface GvretInterfaceConfig {
  device_bus: number;
  enabled: boolean;
  protocol: "can" | "canfd";
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
  traffic_type?: "can" | "canfd" | "modbus" | "serial";
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
  wiretap: WiretapConnection;
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
  | MqttConnection["formats"];

/** @deprecated Use Protocol from profileTraits.ts instead */
export type ReaderProtocol = Protocol;

/**
 * Get display-friendly protocol(s) for a reader kind.
 * Delegates to getProfileTraits() for config-aware protocol detection,
 * then filters for display (e.g., shows only "CAN-FD" when FD is enabled,
 * since CAN is implied by CAN-FD).
 */
export function getReaderProtocols(
  kind: IOProfile["kind"],
  connection?: IOProfile["connection"],
): ReaderProtocol[] {
  const traits = getProfileTraits({ id: "", name: "", kind, connection: connection ?? {} } as IOProfile);
  if (!traits) return ["can"];

  const protocols = traits.protocols.filter((p): p is ReaderProtocol =>
    ["can", "canfd", "serial", "modbus"].includes(p),
  );

  // For display: if CAN-FD is present, omit base "can" (CAN-FD implies CAN)
  if (protocols.includes("canfd") && protocols.includes("can")) {
    return protocols.filter((p) => p !== "can");
  }

  return protocols.length > 0 ? protocols : ["can"];
}

/** Check if a reader kind is realtime (hardware) vs historical (replay) */
export function isReaderRealtime(kind: IOProfile["kind"]): boolean {
  const traits = getTraitsForKind(kind);
  return traits?.temporalMode === "realtime";
}

// ============================================================================
// Enum-ish scalar types
// ============================================================================

export type FrameIdFormat = "hex" | "decimal";
export type TimeFormat = "delta-last" | "delta-start" | "timestamp" | "human";
export type DefaultFrameType = "can" | "modbus" | "serial";
export type ThemeMode = "dark" | "light" | "auto";

export interface SignalColours {
  none: string;
  low: string;
  medium: string;
  high: string;
}

export interface ThemeColours {
  // Light mode
  bgPrimaryLight: string;
  bgSurfaceLight: string;
  textPrimaryLight: string;
  textSecondaryLight: string;
  borderDefaultLight: string;
  dataBgLight: string;
  dataTextPrimaryLight: string;
  // Dark mode
  bgPrimaryDark: string;
  bgSurfaceDark: string;
  textPrimaryDark: string;
  textSecondaryDark: string;
  borderDefaultDark: string;
  dataBgDark: string;
  dataTextPrimaryDark: string;
  // Accent colours (mode-independent)
  accentPrimary: string;
  accentSuccess: string;
  accentDanger: string;
  accentWarning: string;
}

// ============================================================================
// AppSettings — the persisted (snake_case) settings payload
// ============================================================================

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
  display_timezone?: "local" | "utc";
  default_frame_type?: DefaultFrameType;
  signal_colour_none?: string;
  signal_colour_low?: string;
  signal_colour_medium?: string;
  signal_colour_high?: string;
  binary_one_colour?: string;
  binary_zero_colour?: string;
  binary_unused_colour?: string;
  frame_editor_colours?: string[];
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
  usage_analytics_enabled?: boolean;
  usage_analytics_consent_given?: boolean;
  /** Random anonymous per-install id (generated once by the frontend) */
  install_id?: string;
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
  // MCP server (lets an external MCP client query live runtime state)
  mcp_server_enabled?: boolean;
  mcp_allow_control?: boolean;
  mcp_allow_session_control?: boolean;
  mcp_allow_catalog_write?: boolean;
  mcp_allow_catalog_modify?: boolean;
  mcp_allow_dashboard_write?: boolean;
  mcp_allow_ui_control?: boolean;
  mcp_server_port?: number;
  mcp_server_token?: string;
}

// ============================================================================
// Defaults — the single source of truth for the frontend, kept in step with
// the Rust `AppSettings` defaults in src-tauri/src/settings.rs.
// ============================================================================

export const DEFAULT_BUFFER_STORAGE = "sqlite";
export const DEFAULT_CLEAR_BUFFERS_ON_START = true;
export const DEFAULT_DISCOVERY_HISTORY_BUFFER = 100_000;
export const DEFAULT_QUERY_RESULT_LIMIT = 10_000;
export const DEFAULT_GRAPH_BUFFER_SIZE = 10_000;
export const DEFAULT_DECODER_MAX_UNMATCHED_FRAMES = 1000;
export const DEFAULT_DECODER_MAX_FILTERED_FRAMES = 1000;
export const DEFAULT_DECODER_MAX_DECODED_FRAMES = 500;
export const DEFAULT_DECODER_MAX_DECODED_PER_SOURCE = 2000;
export const DEFAULT_TRANSMIT_MAX_HISTORY = 1000;
export const DEFAULT_MODBUS_MAX_REGISTER_ERRORS = 3;

export const defaultSignalColours: SignalColours = {
  none: "#94a3b8",
  low: "#f59e0b",
  medium: "#3b82f6",
  high: "#22c55e",
};

export function defaultFrameEditorColours(): string[] {
  return ["#22d3ee", "#4ade80", "#facc15", "#c084fc", "#60a5fa", "#f87171", "#67e8f9", "#86efac"];
}

export const defaultThemeColours: ThemeColours = {
  // Light mode
  bgPrimaryLight: "#ffffff", // white
  bgSurfaceLight: "#f8fafc", // slate-50
  textPrimaryLight: "#0f172a", // slate-900
  textSecondaryLight: "#334155", // slate-700
  borderDefaultLight: "#e2e8f0", // slate-200
  dataBgLight: "#f8fafc", // slate-50
  dataTextPrimaryLight: "#0f172a", // slate-900
  // Dark mode
  bgPrimaryDark: "#0f172a", // slate-900
  bgSurfaceDark: "#1e293b", // slate-800
  textPrimaryDark: "#ffffff", // white
  textSecondaryDark: "#cbd5e1", // slate-300
  borderDefaultDark: "#334155", // slate-700
  dataBgDark: "#111827", // gray-900
  dataTextPrimaryDark: "#e5e7eb", // gray-200
  // Accent colours (mode-independent)
  accentPrimary: "#2563eb", // blue-600
  accentSuccess: "#16a34a", // green-600
  accentDanger: "#dc2626", // red-600
  accentWarning: "#d97706", // amber-600
};

// ============================================================================
// Normalisation
// ============================================================================

/**
 * Normalise a (possibly partial) settings payload from the backend into a
 * complete `AppSettings`, filling any missing field with its default. The
 * single normalise routine used by both the settings store and the read-only
 * `useSettings()` hook, so both agree on every field.
 */
export function normalizeSettings(
  settings: Partial<AppSettings>,
  defaultDirs?: { decoders: string; dumps: string; reports: string } | null,
): AppSettings {
  const frameEditorColours =
    settings.frame_editor_colours?.length === 8
      ? settings.frame_editor_colours
      : defaultFrameEditorColours();

  return {
    config_path: settings.config_path || "",
    decoder_dir: settings.decoder_dir || defaultDirs?.decoders || "",
    dump_dir: settings.dump_dir || defaultDirs?.dumps || "",
    report_dir: settings.report_dir || defaultDirs?.reports || "",
    io_profiles: settings.io_profiles || [],
    default_read_profile: settings.default_read_profile ?? null,
    default_write_profiles: settings.default_write_profiles ?? [],
    display_frame_id_format: settings.display_frame_id_format === "decimal" ? "decimal" : "hex",
    save_frame_id_format: settings.save_frame_id_format === "decimal" ? "decimal" : "hex",
    display_time_format: settings.display_time_format ?? "human",
    display_timezone: settings.display_timezone ?? "local",
    default_frame_type: settings.default_frame_type ?? "can",
    signal_colour_none: settings.signal_colour_none || defaultSignalColours.none,
    signal_colour_low: settings.signal_colour_low || defaultSignalColours.low,
    signal_colour_medium: settings.signal_colour_medium || defaultSignalColours.medium,
    signal_colour_high: settings.signal_colour_high || defaultSignalColours.high,
    binary_one_colour: settings.binary_one_colour || "#14b8a6",
    binary_zero_colour: settings.binary_zero_colour || "#94a3b8",
    binary_unused_colour: settings.binary_unused_colour || "#64748b",
    frame_editor_colours: frameEditorColours,
    discovery_history_buffer: settings.discovery_history_buffer ?? DEFAULT_DISCOVERY_HISTORY_BUFFER,
    query_result_limit: settings.query_result_limit ?? DEFAULT_QUERY_RESULT_LIMIT,
    session_manager_stats_interval: settings.session_manager_stats_interval ?? 60,
    graph_buffer_size: settings.graph_buffer_size ?? DEFAULT_GRAPH_BUFFER_SIZE,
    decoder_max_unmatched_frames:
      settings.decoder_max_unmatched_frames ?? DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
    decoder_max_filtered_frames:
      settings.decoder_max_filtered_frames ?? DEFAULT_DECODER_MAX_FILTERED_FRAMES,
    decoder_max_decoded_frames:
      settings.decoder_max_decoded_frames ?? DEFAULT_DECODER_MAX_DECODED_FRAMES,
    decoder_max_decoded_per_source:
      settings.decoder_max_decoded_per_source ?? DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
    transmit_max_history: settings.transmit_max_history ?? DEFAULT_TRANSMIT_MAX_HISTORY,
    // Theme settings
    theme_mode: settings.theme_mode ?? "auto",
    theme_bg_primary_light: settings.theme_bg_primary_light || defaultThemeColours.bgPrimaryLight,
    theme_bg_surface_light: settings.theme_bg_surface_light || defaultThemeColours.bgSurfaceLight,
    theme_text_primary_light:
      settings.theme_text_primary_light || defaultThemeColours.textPrimaryLight,
    theme_text_secondary_light:
      settings.theme_text_secondary_light || defaultThemeColours.textSecondaryLight,
    theme_border_default_light:
      settings.theme_border_default_light || defaultThemeColours.borderDefaultLight,
    theme_data_bg_light: settings.theme_data_bg_light || defaultThemeColours.dataBgLight,
    theme_data_text_primary_light:
      settings.theme_data_text_primary_light || defaultThemeColours.dataTextPrimaryLight,
    theme_bg_primary_dark: settings.theme_bg_primary_dark || defaultThemeColours.bgPrimaryDark,
    theme_bg_surface_dark: settings.theme_bg_surface_dark || defaultThemeColours.bgSurfaceDark,
    theme_text_primary_dark: settings.theme_text_primary_dark || defaultThemeColours.textPrimaryDark,
    theme_text_secondary_dark:
      settings.theme_text_secondary_dark || defaultThemeColours.textSecondaryDark,
    theme_border_default_dark:
      settings.theme_border_default_dark || defaultThemeColours.borderDefaultDark,
    theme_data_bg_dark: settings.theme_data_bg_dark || defaultThemeColours.dataBgDark,
    theme_data_text_primary_dark:
      settings.theme_data_text_primary_dark || defaultThemeColours.dataTextPrimaryDark,
    theme_accent_primary: settings.theme_accent_primary || defaultThemeColours.accentPrimary,
    theme_accent_success: settings.theme_accent_success || defaultThemeColours.accentSuccess,
    theme_accent_danger: settings.theme_accent_danger || defaultThemeColours.accentDanger,
    theme_accent_warning: settings.theme_accent_warning || defaultThemeColours.accentWarning,
    // Power management
    prevent_idle_sleep: settings.prevent_idle_sleep ?? true,
    keep_display_awake: settings.keep_display_awake ?? false,
    // Diagnostics
    log_level: settings.log_level ?? "off",
    // Privacy / telemetry
    telemetry_enabled: settings.telemetry_enabled ?? false,
    telemetry_consent_given: settings.telemetry_consent_given ?? false,
    usage_analytics_enabled: settings.usage_analytics_enabled ?? false,
    usage_analytics_consent_given: settings.usage_analytics_consent_given ?? false,
    install_id: settings.install_id ?? "",
    // Buffer persistence
    clear_captures_on_start: settings.clear_captures_on_start ?? DEFAULT_CLEAR_BUFFERS_ON_START,
    buffer_storage: settings.buffer_storage ?? DEFAULT_BUFFER_STORAGE,
    // Modbus
    modbus_max_register_errors:
      settings.modbus_max_register_errors ?? DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
    // Networking
    smp_port: settings.smp_port ?? 1337,
    // Localisation
    language: settings.language ?? "en-AU",
    // MCP server (all gates off by default)
    mcp_server_enabled: settings.mcp_server_enabled ?? false,
    mcp_allow_control: settings.mcp_allow_control ?? false,
    mcp_allow_session_control: settings.mcp_allow_session_control ?? false,
    mcp_allow_catalog_write: settings.mcp_allow_catalog_write ?? false,
    mcp_allow_catalog_modify: settings.mcp_allow_catalog_modify ?? false,
    mcp_allow_dashboard_write: settings.mcp_allow_dashboard_write ?? false,
    mcp_allow_ui_control: settings.mcp_allow_ui_control ?? false,
    mcp_server_port: settings.mcp_server_port ?? 8787,
    mcp_server_token: settings.mcp_server_token ?? "",
  };
}

/** Helper: get display frame ID format from settings */
export const getDisplayFrameIdFormat = (settings?: AppSettings | null): FrameIdFormat =>
  settings?.display_frame_id_format === "decimal" ? "decimal" : "hex";

/** Helper: get save frame ID format from settings */
export const getSaveFrameIdFormat = (settings?: AppSettings | null): FrameIdFormat =>
  settings?.save_frame_id_format === "decimal" ? "decimal" : "hex";
