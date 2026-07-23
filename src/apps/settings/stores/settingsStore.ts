// ui/src/apps/settings/stores/settingsStore.ts

import { create } from 'zustand';
import {
  loadSettings as loadSettingsApi,
  saveSettings as saveSettingsApi,
  validateDirectory as validateDirectoryApi,
  listCatalogs,
  setWakeSettings as setWakeSettingsApi,
  setLogLevel as setLogLevelApi,
} from '../../../api';
import { emit } from '@tauri-apps/api/event';
import { WINDOW_EVENTS } from '../../../events/registry';
import { getOrCreateDefaultDirs } from '../../../utils/defaultPaths';
import {
  getAllFavorites,
  type TimeRangeFavorite,
} from '../../../utils/favorites';
import {
  getAllSelectionSets,
  type SelectionSet,
} from '../../../utils/selectionSets';
import {
  getAllDashboardLayouts,
  type DashboardLayout,
} from '../../../utils/dashboardLayouts';
import { setIOSScreenWake } from '../../../utils/platform';
// Types
export type SettingsSection = "general" | "privacy" | "locations" | "data-io" | "devices" | "captures" | "catalogs" | "bookmarks" | "selection-sets" | "dashboard-layouts" | "display" | "mcp";

// The settings shape, IO-profile union + connection types/guards, default
// constants and normalisation live in the neutral settings/appSettings module.
// Import what the store uses locally; re-export the pieces that existing store
// consumers still import from here.
import {
  normalizeSettings,
  isProfileKind,
  defaultSignalColours,
  defaultThemeColours,
  defaultFrameEditorColours,
  DEFAULT_BUFFER_STORAGE,
  DEFAULT_CLEAR_BUFFERS_ON_START,
  DEFAULT_DISCOVERY_HISTORY_BUFFER,
  DEFAULT_QUERY_RESULT_LIMIT,
  DEFAULT_GRAPH_BUFFER_SIZE,
  DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
  DEFAULT_DECODER_MAX_FILTERED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
  DEFAULT_TRANSMIT_MAX_HISTORY,
  DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
} from '../../../settings/appSettings';
import type {
  AppSettings,
  IOProfile,
  FrameLinkConnection,
  SignalColours,
  ThemeMode,
  ThemeColours,
  DefaultFrameType,
} from '../../../settings/appSettings';

export {
  defaultThemeColours,
  defaultFrameEditorColours,
  DEFAULT_BUFFER_STORAGE,
  DEFAULT_CLEAR_BUFFERS_ON_START,
  DEFAULT_DISCOVERY_HISTORY_BUFFER,
  DEFAULT_QUERY_RESULT_LIMIT,
  DEFAULT_GRAPH_BUFFER_SIZE,
  DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
  DEFAULT_DECODER_MAX_FILTERED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
  DEFAULT_TRANSMIT_MAX_HISTORY,
  DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
};
export type {
  AppSettings,
  IOProfile,
  SignalColours,
  ThemeMode,
  ThemeColours,
  DefaultFrameType,
};

export interface DirectoryValidation {
  exists: boolean;
  writable: boolean;
  error?: string;
}

export interface CatalogFile {
  name: string;
  filename: string;
  path: string;
}

// Dialog types
type DialogName =
  | 'ioProfile'
  | 'deleteIOProfile'
  | 'deleteCatalog'
  | 'duplicateCatalog'
  | 'editCatalog'
  | 'editBookmark'
  | 'deleteBookmark'
  | 'createBookmark'
  | 'editSelectionSet'
  | 'deleteSelectionSet'
  | 'editDashboardLayout'
  | 'deleteDashboardLayout';

interface DialogPayload {
  editingProfileId: string | null;
  profileForm: IOProfile;
  ioProfileToDelete: IOProfile | null;
  catalogToDelete: CatalogFile | null;
  catalogToDuplicate: CatalogFile | null;
  catalogToEdit: CatalogFile | null;
  bookmarkToEdit: TimeRangeFavorite | null;
  bookmarkToDelete: TimeRangeFavorite | null;
  selectionSetToEdit: SelectionSet | null;
  selectionSetToDelete: SelectionSet | null;
  dashboardLayoutToEdit: DashboardLayout | null;
  dashboardLayoutToDelete: DashboardLayout | null;
}

const initialDialogs: Record<DialogName, boolean> = {
  ioProfile: false,
  deleteIOProfile: false,
  deleteCatalog: false,
  duplicateCatalog: false,
  editCatalog: false,
  editBookmark: false,
  deleteBookmark: false,
  createBookmark: false,
  editSelectionSet: false,
  deleteSelectionSet: false,
  editDashboardLayout: false,
  deleteDashboardLayout: false,
};

const initialDialogPayload: DialogPayload = {
  editingProfileId: null,
  profileForm: { id: '', name: '', kind: 'mqtt', connection: {} } satisfies IOProfile,
  ioProfileToDelete: null,
  catalogToDelete: null,
  catalogToDuplicate: null,
  catalogToEdit: null,
  bookmarkToEdit: null,
  bookmarkToDelete: null,
  selectionSetToEdit: null,
  selectionSetToDelete: null,
  dashboardLayoutToEdit: null,
  dashboardLayoutToDelete: null,
};

// Stable stringify helper for change detection
function stableStringify(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as any)[k])).join(',') + '}';
}

// Store state interface
interface SettingsState {
  // Locations
  locations: {
    configPath: string;
    decoderDir: string;
    dumpDir: string;
    reportDir: string;
    decoderValidation: DirectoryValidation | null;
    dumpValidation: DirectoryValidation | null;
    reportValidation: DirectoryValidation | null;
  };

  // IO Profiles
  ioProfiles: {
    profiles: IOProfile[];
    defaultReadProfile: string | null;
    defaultWriteProfiles: string[];
  };

  // Catalogs
  catalogs: {
    list: CatalogFile[];
  };

  // Bookmarks
  bookmarks: TimeRangeFavorite[];

  // Selection sets
  selectionSets: SelectionSet[];

  // Dashboard layouts
  dashboardLayouts: DashboardLayout[];

  // Display settings
  display: {
    frameIdFormat: 'hex' | 'decimal';
    saveFrameIdFormat: 'hex' | 'decimal';
    timeFormat: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
    timezone: 'local' | 'utc';
    signalColours: SignalColours;
    binaryOneColour: string;
    binaryZeroColour: string;
    binaryUnusedColour: string;
    frameEditorColours: string[];
    themeMode: ThemeMode;
    themeColours: ThemeColours;
  };

  // Buffer settings
  buffers: {
    clearCapturesOnStart: boolean;
    captureStorage: string;
    discoveryHistorySize: number;
    queryResultLimit: number;
    graphBufferSize: number;
    decoderMaxUnmatchedFrames: number;
    decoderMaxFilteredFrames: number;
    decoderMaxDecodedFrames: number;
    decoderMaxDecodedPerSource: number;
    transmitMaxHistory: number;
  };

  // General settings
  general: {
    defaultFrameType: DefaultFrameType;
    sessionManagerStatsInterval: number;
    preventIdleSleep: boolean;
    keepDisplayAwake: boolean;
    logLevel: string;
    telemetryEnabled: boolean;
    telemetryConsentGiven: boolean;
    usageAnalyticsEnabled: boolean;
    usageAnalyticsConsentGiven: boolean;
    installId: string;
    modbusMaxRegisterErrors: number;
    smpPort: number;
    language: string;
  };

  // MCP server (external MCP client access to live runtime state)
  mcp: {
    serverEnabled: boolean;
    allowControl: boolean;
    allowSessionControl: boolean;
    allowCatalogWrite: boolean;
    allowCatalogModify: boolean;
    allowDashboardWrite: boolean;
    allowUiControl: boolean;
    serverPort: number;
    serverToken: string;
  };

  // UI state
  ui: {
    currentSection: SettingsSection;
    dialogs: Record<DialogName, boolean>;
    dialogPayload: DialogPayload;
  };

  // Change tracking
  originalSettings: AppSettings | null;

  // Actions - Loading
  loadSettings: () => Promise<void>;
  loadCatalogs: () => Promise<void>;
  loadBookmarks: () => Promise<void>;
  loadSelectionSets: () => Promise<void>;
  loadDashboardLayouts: () => Promise<void>;

  // Actions - Saving
  saveSettings: () => Promise<void>;
  hasUnsavedChanges: () => boolean;

  // Actions - Navigation
  setSection: (section: SettingsSection) => void;

  // Actions - Dialogs
  openDialog: (name: DialogName) => void;
  closeDialog: (name: DialogName) => void;
  setDialogPayload: (payload: Partial<DialogPayload>) => void;

  // Actions - Locations
  setDecoderDir: (dir: string) => void;
  setDumpDir: (dir: string) => void;
  setReportDir: (dir: string) => void;

  // Actions - IO Profiles
  setProfiles: (profiles: IOProfile[]) => void;
  addProfile: (profile: IOProfile) => void;
  updateProfile: (id: string, profile: IOProfile) => void;
  removeProfile: (id: string) => void;
  setDefaultReadProfile: (id: string | null) => void;
  setDefaultWriteProfiles: (ids: string[]) => void;

  // Actions - Catalogs
  setCatalogList: (catalogs: CatalogFile[]) => void;

  // Actions - Bookmarks
  setBookmarks: (bookmarks: TimeRangeFavorite[]) => void;

  // Actions - Display
  setDisplayFrameIdFormat: (format: 'hex' | 'decimal') => void;
  setSaveFrameIdFormat: (format: 'hex' | 'decimal') => void;
  setDisplayTimeFormat: (format: 'delta-last' | 'delta-start' | 'timestamp' | 'human') => void;
  setTimezone: (timezone: 'local' | 'utc') => void;
  setSignalColour: (level: keyof SignalColours, colour: string) => void;
  resetSignalColour: (level: keyof SignalColours) => void;
  setBinaryOneColour: (colour: string) => void;
  setBinaryZeroColour: (colour: string) => void;
  setBinaryUnusedColour: (colour: string) => void;
  resetBinaryOneColour: () => void;
  resetBinaryZeroColour: () => void;
  resetBinaryUnusedColour: () => void;
  setFrameEditorColour: (index: number, colour: string) => void;
  resetFrameEditorColours: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  setThemeColour: (key: keyof ThemeColours, colour: string) => void;
  resetThemeColours: () => void;

  // Actions - Buffers
  setClearCapturesOnStart: (value: boolean) => void;
  setCaptureStorage: (value: string) => void;
  setDiscoveryHistorySize: (buffer: number) => void;
  setQueryResultLimit: (limit: number) => void;
  setGraphBufferSize: (size: number) => void;
  setDecoderMaxUnmatchedFrames: (value: number) => void;
  setDecoderMaxFilteredFrames: (value: number) => void;
  setDecoderMaxDecodedFrames: (value: number) => void;
  setDecoderMaxDecodedPerSource: (value: number) => void;
  setTransmitMaxHistory: (value: number) => void;

  // Actions - General
  setDefaultFrameType: (type: DefaultFrameType) => void;
  setSessionManagerStatsInterval: (interval: number) => void;
  setPreventIdleSleep: (value: boolean) => void;
  setKeepDisplayAwake: (value: boolean) => void;
  setLogLevel: (value: string) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setTelemetryConsentGiven: (value: boolean) => void;
  setUsageAnalyticsEnabled: (value: boolean) => void;
  setUsageAnalyticsConsentGiven: (value: boolean) => void;
  setInstallId: (value: string) => void;
  setModbusMaxRegisterErrors: (value: number) => void;
  setSmpPort: (port: number) => void;
  setLanguage: (lang: string) => void;
  setMcpServerEnabled: (value: boolean) => void;
  setMcpAllowControl: (value: boolean) => void;
  setMcpAllowSessionControl: (value: boolean) => void;
  setMcpAllowCatalogWrite: (value: boolean) => void;
  setMcpAllowCatalogModify: (value: boolean) => void;
  setMcpAllowDashboardWrite: (value: boolean) => void;
  setMcpAllowUiControl: (value: boolean) => void;
  setMcpServerPort: (port: number) => void;
  setMcpServerToken: (token: string) => void;
}

// Auto-save debounce
let saveTimeout: number | null = null;

const scheduleSave = (save: () => Promise<void>) => {
  if (saveTimeout) {
    window.clearTimeout(saveTimeout);
  }
  saveTimeout = window.setTimeout(() => {
    save();
  }, 1000);
};

/**
 * Migrate old-style per-interface FrameLink profiles into grouped device profiles.
 * Old format: one IOProfile per interface with connection.interface_index.
 * New format: one IOProfile per device with connection.interfaces[].
 * Returns { profiles, removedIds } where removedIds are IDs that were merged away.
 */
function migrateFrameLinkProfiles(profiles: IOProfile[]): { profiles: IOProfile[]; removedIds: Set<string> } {
  type FrameLinkProfile = Extract<IOProfile, { kind: "framelink" }>;

  const isOldStyleFrameLink = (p: IOProfile): p is FrameLinkProfile =>
    isProfileKind(p, "framelink") && p.connection?.interface_index != null && !Array.isArray(p.connection?.interfaces);

  const oldStyle = profiles.filter(isOldStyleFrameLink);
  if (oldStyle.length === 0) return { profiles, removedIds: new Set() };

  const rest = profiles.filter((p) => !isOldStyleFrameLink(p));

  // Group by (host, device_id) or (host, port) if no device_id
  const groups = new Map<string, FrameLinkProfile[]>();
  for (const p of oldStyle) {
    const c = p.connection;
    const key = `${c.host}:${c.device_id ?? c.port ?? "120"}`;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }

  const merged: IOProfile[] = [];
  const removedIds = new Set<string>();
  for (const group of groups.values()) {
    const first = group[0];
    const fc = first.connection;
    // Derive device label: strip interface suffix from first profile name
    const ifaceName = fc.interface_name ?? "";
    const deviceLabel = ifaceName && first.name.endsWith(ifaceName)
      ? first.name.slice(0, -ifaceName.length).trim() || fc.device_id || first.name
      : fc.device_id ?? first.name;

    const connection: FrameLinkConnection = {
      host: fc.host,
      port: fc.port ?? "120",
      timeout: fc.timeout,
      device_id: fc.device_id,
      interfaces: group
        .map((p) => ({
          index: p.connection.interface_index as number,
          iface_type: (p.connection.interface_type as number) ?? 1,
          name: p.connection.interface_name ?? `IF${p.connection.interface_index}`,
        }))
        .sort((a, b) => a.index - b.index),
    };

    merged.push({
      id: first.id,
      name: deviceLabel,
      kind: "framelink",
      connection,
      preferred_catalog: first.preferred_catalog,
    } satisfies IOProfile);

    // Track removed IDs (all except the first which we kept)
    for (let i = 1; i < group.length; i++) {
      removedIds.add(group[i].id);
    }
  }

  return { profiles: [...rest, ...merged], removedIds };
}

/**
 * Build the persisted snake_case AppSettings payload from store state. The
 * single source of truth for both `saveSettings` (what we write) and
 * `hasUnsavedChanges` (what we diff against `originalSettings`) — the two must
 * be byte-identical or dirty-tracking drifts, so keep this the only place the
 * mapping lives.
 */
function buildAppSettings(s: SettingsState) {
  const { locations, ioProfiles, display, buffers, general, mcp } = s;
  return {
    config_path: locations.configPath,
    decoder_dir: locations.decoderDir,
    dump_dir: locations.dumpDir,
    report_dir: locations.reportDir,
    io_profiles: ioProfiles.profiles,
    default_read_profile: ioProfiles.defaultReadProfile,
    default_write_profiles: ioProfiles.defaultWriteProfiles,
    display_frame_id_format: display.frameIdFormat,
    save_frame_id_format: display.saveFrameIdFormat,
    display_time_format: display.timeFormat,
    display_timezone: display.timezone,
    default_frame_type: general.defaultFrameType,
    signal_colour_none: display.signalColours.none,
    signal_colour_low: display.signalColours.low,
    signal_colour_medium: display.signalColours.medium,
    signal_colour_high: display.signalColours.high,
    binary_one_colour: display.binaryOneColour,
    binary_zero_colour: display.binaryZeroColour,
    binary_unused_colour: display.binaryUnusedColour,
    frame_editor_colours: display.frameEditorColours,
    // Buffers
    clear_captures_on_start: buffers.clearCapturesOnStart,
    buffer_storage: buffers.captureStorage,
    discovery_history_buffer: buffers.discoveryHistorySize,
    query_result_limit: buffers.queryResultLimit,
    graph_buffer_size: buffers.graphBufferSize,
    decoder_max_unmatched_frames: buffers.decoderMaxUnmatchedFrames,
    decoder_max_filtered_frames: buffers.decoderMaxFilteredFrames,
    decoder_max_decoded_frames: buffers.decoderMaxDecodedFrames,
    decoder_max_decoded_per_source: buffers.decoderMaxDecodedPerSource,
    transmit_max_history: buffers.transmitMaxHistory,
    session_manager_stats_interval: general.sessionManagerStatsInterval,
    // Power management
    prevent_idle_sleep: general.preventIdleSleep,
    keep_display_awake: general.keepDisplayAwake,
    // Diagnostics
    log_level: general.logLevel,
    // Privacy / telemetry
    telemetry_enabled: general.telemetryEnabled,
    telemetry_consent_given: general.telemetryConsentGiven,
    usage_analytics_enabled: general.usageAnalyticsEnabled,
    usage_analytics_consent_given: general.usageAnalyticsConsentGiven,
    install_id: general.installId,
    // Modbus
    modbus_max_register_errors: general.modbusMaxRegisterErrors,
    // Theme settings
    theme_mode: display.themeMode,
    theme_bg_primary_light: display.themeColours.bgPrimaryLight,
    theme_bg_surface_light: display.themeColours.bgSurfaceLight,
    theme_text_primary_light: display.themeColours.textPrimaryLight,
    theme_text_secondary_light: display.themeColours.textSecondaryLight,
    theme_border_default_light: display.themeColours.borderDefaultLight,
    theme_data_bg_light: display.themeColours.dataBgLight,
    theme_data_text_primary_light: display.themeColours.dataTextPrimaryLight,
    theme_bg_primary_dark: display.themeColours.bgPrimaryDark,
    theme_bg_surface_dark: display.themeColours.bgSurfaceDark,
    theme_text_primary_dark: display.themeColours.textPrimaryDark,
    theme_text_secondary_dark: display.themeColours.textSecondaryDark,
    theme_border_default_dark: display.themeColours.borderDefaultDark,
    theme_data_bg_dark: display.themeColours.dataBgDark,
    theme_data_text_primary_dark: display.themeColours.dataTextPrimaryDark,
    theme_accent_primary: display.themeColours.accentPrimary,
    theme_accent_success: display.themeColours.accentSuccess,
    theme_accent_danger: display.themeColours.accentDanger,
    theme_accent_warning: display.themeColours.accentWarning,
    // Networking
    smp_port: general.smpPort,
    // Localisation
    language: general.language,
    // MCP server
    mcp_server_enabled: mcp.serverEnabled,
    mcp_allow_control: mcp.allowControl,
    mcp_allow_session_control: mcp.allowSessionControl,
    mcp_allow_catalog_write: mcp.allowCatalogWrite,
    mcp_allow_catalog_modify: mcp.allowCatalogModify,
    mcp_allow_dashboard_write: mcp.allowDashboardWrite,
    mcp_allow_ui_control: mcp.allowUiControl,
    mcp_server_port: mcp.serverPort,
    mcp_server_token: mcp.serverToken,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // Initial state
  locations: {
    configPath: '',
    decoderDir: '',
    dumpDir: '',
    reportDir: '',
    decoderValidation: null,
    dumpValidation: null,
    reportValidation: null,
  },

  ioProfiles: {
    profiles: [],
    defaultReadProfile: null,
    defaultWriteProfiles: [],
  },

  catalogs: {
    list: [],
  },

  bookmarks: [],

  selectionSets: [],

  dashboardLayouts: [],

  display: {
    frameIdFormat: 'hex',
    saveFrameIdFormat: 'hex',
    timeFormat: 'human',
    timezone: 'local',
    signalColours: { ...defaultSignalColours },
    binaryOneColour: '#14b8a6',
    binaryZeroColour: '#94a3b8',
    binaryUnusedColour: '#64748b',
    frameEditorColours: defaultFrameEditorColours(),
    themeMode: 'auto',
    themeColours: { ...defaultThemeColours },
  },

  buffers: {
    clearCapturesOnStart: DEFAULT_CLEAR_BUFFERS_ON_START,
    captureStorage: DEFAULT_BUFFER_STORAGE,
    discoveryHistorySize: DEFAULT_DISCOVERY_HISTORY_BUFFER,
    queryResultLimit: DEFAULT_QUERY_RESULT_LIMIT,
    graphBufferSize: DEFAULT_GRAPH_BUFFER_SIZE,
    decoderMaxUnmatchedFrames: DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
    decoderMaxFilteredFrames: DEFAULT_DECODER_MAX_FILTERED_FRAMES,
    decoderMaxDecodedFrames: DEFAULT_DECODER_MAX_DECODED_FRAMES,
    decoderMaxDecodedPerSource: DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
    transmitMaxHistory: DEFAULT_TRANSMIT_MAX_HISTORY,
  },

  general: {
    defaultFrameType: 'can',
    sessionManagerStatsInterval: 60,
    preventIdleSleep: true,
    keepDisplayAwake: false,
    logLevel: "off",
    telemetryEnabled: false,
    telemetryConsentGiven: false,
    usageAnalyticsEnabled: false,
    usageAnalyticsConsentGiven: false,
    installId: "",
    modbusMaxRegisterErrors: DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
    smpPort: 1337,
    language: "en-AU",
  },

  mcp: {
    serverEnabled: false,
    allowControl: false,
    allowSessionControl: false,
    allowCatalogWrite: false,
    allowCatalogModify: false,
    allowDashboardWrite: false,
    allowUiControl: false,
    serverPort: 8787,
    serverToken: "",
  },

  ui: {
    currentSection: 'general',
    dialogs: { ...initialDialogs },
    dialogPayload: { ...initialDialogPayload },
  },

  originalSettings: null,

  // Loading actions
  loadSettings: async () => {
    try {
      const settings = await loadSettingsApi();

      // Get default directories for empty paths
      let defaultDirs: { decoders: string; dumps: string; reports: string } | null = null;
      if (!settings.decoder_dir || !settings.dump_dir || !settings.report_dir) {
        try {
          defaultDirs = await getOrCreateDefaultDirs();
        } catch (err) {
          console.warn('Could not get/create default directories:', err);
        }
      }

      const decoderDir = settings.decoder_dir || defaultDirs?.decoders || '';
      const dumpDir = settings.dump_dir || defaultDirs?.dumps || '';
      const reportDir = settings.report_dir || defaultDirs?.reports || '';

      // Validate directories
      const validateDir = async (path: string): Promise<DirectoryValidation | null> => {
        if (!path) return null;
        try {
          return await validateDirectoryApi(path);
        } catch {
          return { exists: false, writable: false, error: 'Validation failed' };
        }
      };

      const [decoderValidation, dumpValidation, reportValidation] = await Promise.all([
        validateDir(decoderDir),
        validateDir(dumpDir),
        validateDir(reportDir),
      ]);

      // Migrate old per-interface FrameLink profiles to grouped device profiles
      const migration = migrateFrameLinkProfiles(settings.io_profiles || []);
      let defaultRead = settings.default_read_profile ?? null;
      let defaultWrites = settings.default_write_profiles ?? [];
      if (migration.removedIds.size > 0) {
        // If default profiles were merged away, clear them (the surviving profile ID is kept)
        if (defaultRead && migration.removedIds.has(defaultRead)) {
          defaultRead = null;
        }
        defaultWrites = defaultWrites.filter((id: string) => !migration.removedIds.has(id));
      }

      // One shared normalise routine (settings/appSettings) fills every missing
      // field with its default, applied on top of the migrated profiles.
      const normalized = normalizeSettings(
        {
          ...settings,
          io_profiles: migration.profiles,
          default_read_profile: defaultRead,
          default_write_profiles: defaultWrites,
        },
        defaultDirs,
      );

      set({
        locations: {
          configPath: normalized.config_path,
          decoderDir: normalized.decoder_dir,
          dumpDir: normalized.dump_dir,
          reportDir: normalized.report_dir,
          decoderValidation,
          dumpValidation,
          reportValidation,
        },
        ioProfiles: {
          profiles: normalized.io_profiles,
          defaultReadProfile: normalized.default_read_profile || null,
          defaultWriteProfiles: normalized.default_write_profiles || [],
        },
        catalogs: {
          ...get().catalogs,
        },
        display: {
          frameIdFormat: normalized.display_frame_id_format === 'decimal' ? 'decimal' : 'hex',
          saveFrameIdFormat: normalized.save_frame_id_format === 'decimal' ? 'decimal' : 'hex',
          timeFormat: (['delta-last', 'delta-start', 'timestamp'].includes(normalized.display_time_format || '')
            ? normalized.display_time_format
            : 'human') as 'delta-last' | 'delta-start' | 'timestamp' | 'human',
          timezone: normalized.display_timezone === 'utc' ? 'utc' : 'local',
          signalColours: {
            none: normalized.signal_colour_none || defaultSignalColours.none,
            low: normalized.signal_colour_low || defaultSignalColours.low,
            medium: normalized.signal_colour_medium || defaultSignalColours.medium,
            high: normalized.signal_colour_high || defaultSignalColours.high,
          },
          binaryOneColour: normalized.binary_one_colour || '#14b8a6',
          binaryZeroColour: normalized.binary_zero_colour || '#94a3b8',
          binaryUnusedColour: normalized.binary_unused_colour || '#64748b',
          frameEditorColours: normalized.frame_editor_colours ?? defaultFrameEditorColours(),
          themeMode: normalized.theme_mode || 'auto',
          themeColours: {
            bgPrimaryLight: normalized.theme_bg_primary_light || defaultThemeColours.bgPrimaryLight,
            bgSurfaceLight: normalized.theme_bg_surface_light || defaultThemeColours.bgSurfaceLight,
            textPrimaryLight: normalized.theme_text_primary_light || defaultThemeColours.textPrimaryLight,
            textSecondaryLight: normalized.theme_text_secondary_light || defaultThemeColours.textSecondaryLight,
            borderDefaultLight: normalized.theme_border_default_light || defaultThemeColours.borderDefaultLight,
            dataBgLight: normalized.theme_data_bg_light || defaultThemeColours.dataBgLight,
            dataTextPrimaryLight: normalized.theme_data_text_primary_light || defaultThemeColours.dataTextPrimaryLight,
            bgPrimaryDark: normalized.theme_bg_primary_dark || defaultThemeColours.bgPrimaryDark,
            bgSurfaceDark: normalized.theme_bg_surface_dark || defaultThemeColours.bgSurfaceDark,
            textPrimaryDark: normalized.theme_text_primary_dark || defaultThemeColours.textPrimaryDark,
            textSecondaryDark: normalized.theme_text_secondary_dark || defaultThemeColours.textSecondaryDark,
            borderDefaultDark: normalized.theme_border_default_dark || defaultThemeColours.borderDefaultDark,
            dataBgDark: normalized.theme_data_bg_dark || defaultThemeColours.dataBgDark,
            dataTextPrimaryDark: normalized.theme_data_text_primary_dark || defaultThemeColours.dataTextPrimaryDark,
            accentPrimary: normalized.theme_accent_primary || defaultThemeColours.accentPrimary,
            accentSuccess: normalized.theme_accent_success || defaultThemeColours.accentSuccess,
            accentDanger: normalized.theme_accent_danger || defaultThemeColours.accentDanger,
            accentWarning: normalized.theme_accent_warning || defaultThemeColours.accentWarning,
          },
        },
        buffers: {
          clearCapturesOnStart: normalized.clear_captures_on_start ?? DEFAULT_CLEAR_BUFFERS_ON_START,
          captureStorage: normalized.buffer_storage ?? DEFAULT_BUFFER_STORAGE,
          discoveryHistorySize: normalized.discovery_history_buffer ?? DEFAULT_DISCOVERY_HISTORY_BUFFER,
          queryResultLimit: normalized.query_result_limit ?? DEFAULT_QUERY_RESULT_LIMIT,
          graphBufferSize: normalized.graph_buffer_size ?? DEFAULT_GRAPH_BUFFER_SIZE,
          decoderMaxUnmatchedFrames: normalized.decoder_max_unmatched_frames ?? DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
          decoderMaxFilteredFrames: normalized.decoder_max_filtered_frames ?? DEFAULT_DECODER_MAX_FILTERED_FRAMES,
          decoderMaxDecodedFrames: normalized.decoder_max_decoded_frames ?? DEFAULT_DECODER_MAX_DECODED_FRAMES,
          decoderMaxDecodedPerSource: normalized.decoder_max_decoded_per_source ?? DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
          transmitMaxHistory: normalized.transmit_max_history ?? DEFAULT_TRANSMIT_MAX_HISTORY,
        },
        general: {
          defaultFrameType: normalized.default_frame_type ?? 'can',
          sessionManagerStatsInterval: normalized.session_manager_stats_interval ?? 60,
          preventIdleSleep: normalized.prevent_idle_sleep ?? true,
          keepDisplayAwake: normalized.keep_display_awake ?? false,
          logLevel: normalized.log_level ?? "off",
          telemetryEnabled: normalized.telemetry_enabled ?? false,
          telemetryConsentGiven: normalized.telemetry_consent_given ?? false,
          usageAnalyticsEnabled: normalized.usage_analytics_enabled ?? false,
          usageAnalyticsConsentGiven: normalized.usage_analytics_consent_given ?? false,
          installId: normalized.install_id ?? "",
          modbusMaxRegisterErrors: normalized.modbus_max_register_errors ?? DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
          smpPort: normalized.smp_port ?? 1337,
          language: normalized.language ?? "en-AU",
        },
        mcp: {
          serverEnabled: normalized.mcp_server_enabled ?? false,
          allowControl: normalized.mcp_allow_control ?? false,
          allowSessionControl: normalized.mcp_allow_session_control ?? false,
          allowCatalogWrite: normalized.mcp_allow_catalog_write ?? false,
          allowCatalogModify: normalized.mcp_allow_catalog_modify ?? false,
          allowDashboardWrite: normalized.mcp_allow_dashboard_write ?? false,
          allowUiControl: normalized.mcp_allow_ui_control ?? false,
          serverPort: normalized.mcp_server_port ?? 8787,
          serverToken: normalized.mcp_server_token ?? "",
        },
      });

      // Baseline for dirty-tracking. Build it from the just-applied slices via
      // the same buildAppSettings the dirty check uses, so a clean load is never
      // spuriously dirty. When a migration ran, seed the baseline with the
      // pre-migration profiles so hasUnsavedChanges() fires and the migrated
      // form is re-persisted below.
      const baseline = buildAppSettings(get());
      set({
        originalSettings: migration.removedIds.size > 0
          ? { ...baseline, io_profiles: settings.io_profiles || [] }
          : baseline,
      });

      // Persist migrated settings so old profiles are not re-migrated next load
      if (migration.removedIds.size > 0) {
        scheduleSave(get().saveSettings);
      }

      // Update backend wake settings cache (desktop)
      setWakeSettingsApi(
        normalized.prevent_idle_sleep ?? true,
        normalized.keep_display_awake ?? false
      ).catch(console.error);

      // Set iOS screen wake state on startup (no-op on other platforms)
      setIOSScreenWake(normalized.keep_display_awake ?? false).catch(console.error);

      // Load catalogs after we have the decoder dir
      get().loadCatalogs();
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  },

  loadCatalogs: async () => {
    try {
      const catalogList = await listCatalogs();
      set((state) => ({
        catalogs: { ...state.catalogs, list: catalogList },
      }));
    } catch (error) {
      console.error('Failed to load catalogs:', error);
    }
  },

  loadBookmarks: async () => {
    try {
      const allBookmarks = await getAllFavorites();
      allBookmarks.sort((a, b) => a.name.localeCompare(b.name));
      set({ bookmarks: allBookmarks });
    } catch (error) {
      console.error('Failed to load bookmarks:', error);
    }
  },

  loadSelectionSets: async () => {
    try {
      const allSets = await getAllSelectionSets();
      allSets.sort((a, b) => a.name.localeCompare(b.name));
      set({ selectionSets: allSets });
    } catch (error) {
      console.error('Failed to load selection sets:', error);
    }
  },

  loadDashboardLayouts: async () => {
    try {
      const allLayouts = await getAllDashboardLayouts();
      allLayouts.sort((a, b) => a.name.localeCompare(b.name));
      set({ dashboardLayouts: allLayouts });
    } catch (error) {
      console.error('Failed to load graph layouts:', error);
    }
  },

  // Saving actions
  saveSettings: async () => {
    if (!get().hasUnsavedChanges()) return;

    try {
      const settings = buildAppSettings(get());

      await saveSettingsApi(settings);
      set({ originalSettings: settings });

      // Notify other windows
      await emit(WINDOW_EVENTS.SETTINGS_CHANGED, {
        settings,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  },

  hasUnsavedChanges: () => {
    const { originalSettings } = get();
    if (!originalSettings) return false;
    const currentSettings = buildAppSettings(get());
    return stableStringify(currentSettings) !== stableStringify(originalSettings);
  },

  // Navigation
  setSection: (section) => set((state) => ({
    ui: { ...state.ui, currentSection: section },
  })),

  // Dialog management
  openDialog: (name) => set((state) => ({
    ui: { ...state.ui, dialogs: { ...state.ui.dialogs, [name]: true } },
  })),

  closeDialog: (name) => set((state) => ({
    ui: { ...state.ui, dialogs: { ...state.ui.dialogs, [name]: false } },
  })),

  setDialogPayload: (payload) => set((state) => ({
    ui: {
      ...state.ui,
      dialogPayload: { ...state.ui.dialogPayload, ...payload },
    },
  })),

  // Location setters with validation
  setDecoderDir: async (dir) => {
    set((state) => ({
      locations: { ...state.locations, decoderDir: dir, decoderValidation: null },
    }));
    if (dir) {
      try {
        const validation = await validateDirectoryApi(dir);
        set((state) => ({
          locations: { ...state.locations, decoderValidation: validation },
        }));
      } catch {
        set((state) => ({
          locations: {
            ...state.locations,
            decoderValidation: { exists: false, writable: false, error: 'Validation failed' },
          },
        }));
      }
    }
    scheduleSave(get().saveSettings);
  },

  setDumpDir: async (dir) => {
    set((state) => ({
      locations: { ...state.locations, dumpDir: dir, dumpValidation: null },
    }));
    if (dir) {
      try {
        const validation = await validateDirectoryApi(dir);
        set((state) => ({
          locations: { ...state.locations, dumpValidation: validation },
        }));
      } catch {
        set((state) => ({
          locations: {
            ...state.locations,
            dumpValidation: { exists: false, writable: false, error: 'Validation failed' },
          },
        }));
      }
    }
    scheduleSave(get().saveSettings);
  },

  setReportDir: async (dir) => {
    set((state) => ({
      locations: { ...state.locations, reportDir: dir, reportValidation: null },
    }));
    if (dir) {
      try {
        const validation = await validateDirectoryApi(dir);
        set((state) => ({
          locations: { ...state.locations, reportValidation: validation },
        }));
      } catch {
        set((state) => ({
          locations: {
            ...state.locations,
            reportValidation: { exists: false, writable: false, error: 'Validation failed' },
          },
        }));
      }
    }
    scheduleSave(get().saveSettings);
  },

  // IO Profile actions
  setProfiles: (profiles) => {
    set((state) => ({
      ioProfiles: { ...state.ioProfiles, profiles },
    }));
    scheduleSave(get().saveSettings);
  },

  addProfile: (profile) => {
    set((state) => ({
      ioProfiles: {
        ...state.ioProfiles,
        profiles: [...state.ioProfiles.profiles, profile],
      },
    }));
    scheduleSave(get().saveSettings);
  },

  updateProfile: (id, profile) => {
    set((state) => ({
      ioProfiles: {
        ...state.ioProfiles,
        profiles: state.ioProfiles.profiles.map((p) => (p.id === id ? profile : p)),
      },
    }));
    scheduleSave(get().saveSettings);
  },

  removeProfile: (id) => {
    const { ioProfiles } = get();
    set((state) => ({
      ioProfiles: {
        ...state.ioProfiles,
        profiles: state.ioProfiles.profiles.filter((p) => p.id !== id),
        defaultReadProfile: ioProfiles.defaultReadProfile === id ? null : ioProfiles.defaultReadProfile,
        defaultWriteProfiles: ioProfiles.defaultWriteProfiles.filter((wId) => wId !== id),
      },
    }));
    scheduleSave(get().saveSettings);
  },

  setDefaultReadProfile: (id) => {
    set((state) => ({
      ioProfiles: { ...state.ioProfiles, defaultReadProfile: id },
    }));
    scheduleSave(get().saveSettings);
  },

  setDefaultWriteProfiles: (ids) => {
    set((state) => ({
      ioProfiles: { ...state.ioProfiles, defaultWriteProfiles: ids },
    }));
    scheduleSave(get().saveSettings);
  },

  // Catalog actions
  setCatalogList: (catalogs) => set((state) => ({
    catalogs: { ...state.catalogs, list: catalogs },
  })),

  // Bookmark actions
  setBookmarks: (bookmarks) => set({ bookmarks }),

  // Display actions
  setDisplayFrameIdFormat: (format) => {
    set((state) => ({
      display: { ...state.display, frameIdFormat: format },
    }));
    scheduleSave(get().saveSettings);
  },

  setSaveFrameIdFormat: (format) => {
    set((state) => ({
      display: { ...state.display, saveFrameIdFormat: format },
    }));
    scheduleSave(get().saveSettings);
  },

  setDisplayTimeFormat: (format) => {
    set((state) => ({
      display: { ...state.display, timeFormat: format },
    }));
    scheduleSave(get().saveSettings);
  },

  setTimezone: (timezone) => {
    set((state) => ({
      display: { ...state.display, timezone },
    }));
    scheduleSave(get().saveSettings);
  },

  setSignalColour: (level, colour) => {
    set((state) => ({
      display: {
        ...state.display,
        signalColours: { ...state.display.signalColours, [level]: colour },
      },
    }));
    scheduleSave(get().saveSettings);
  },

  resetSignalColour: (level) => {
    set((state) => ({
      display: {
        ...state.display,
        signalColours: { ...state.display.signalColours, [level]: defaultSignalColours[level] },
      },
    }));
    scheduleSave(get().saveSettings);
  },

  setBinaryOneColour: (colour) => {
    set((state) => ({
      display: { ...state.display, binaryOneColour: colour },
    }));
    scheduleSave(get().saveSettings);
  },

  setBinaryZeroColour: (colour) => {
    set((state) => ({
      display: { ...state.display, binaryZeroColour: colour },
    }));
    scheduleSave(get().saveSettings);
  },

  setBinaryUnusedColour: (colour) => {
    set((state) => ({
      display: { ...state.display, binaryUnusedColour: colour },
    }));
    scheduleSave(get().saveSettings);
  },

  resetBinaryOneColour: () => {
    set((state) => ({
      display: { ...state.display, binaryOneColour: '#14b8a6' },
    }));
    scheduleSave(get().saveSettings);
  },

  resetBinaryZeroColour: () => {
    set((state) => ({
      display: { ...state.display, binaryZeroColour: '#94a3b8' },
    }));
    scheduleSave(get().saveSettings);
  },

  resetBinaryUnusedColour: () => {
    set((state) => ({
      display: { ...state.display, binaryUnusedColour: '#64748b' },
    }));
    scheduleSave(get().saveSettings);
  },

  setFrameEditorColour: (index, colour) => {
    set((state) => {
      const colours = [...state.display.frameEditorColours];
      colours[index] = colour;
      return { display: { ...state.display, frameEditorColours: colours } };
    });
    scheduleSave(get().saveSettings);
  },
  resetFrameEditorColours: () => {
    set((state) => ({
      display: { ...state.display, frameEditorColours: defaultFrameEditorColours() },
    }));
    scheduleSave(get().saveSettings);
  },

  setThemeMode: (mode) => {
    set((state) => ({
      display: { ...state.display, themeMode: mode },
    }));
    scheduleSave(get().saveSettings);
  },

  setThemeColour: (key, colour) => {
    set((state) => ({
      display: {
        ...state.display,
        themeColours: { ...state.display.themeColours, [key]: colour },
      },
    }));
    scheduleSave(get().saveSettings);
  },

  resetThemeColours: () => {
    set((state) => ({
      display: {
        ...state.display,
        themeColours: { ...defaultThemeColours },
      },
    }));
    scheduleSave(get().saveSettings);
  },

  // Buffer actions
  setClearCapturesOnStart: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, clearCapturesOnStart: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setCaptureStorage: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, captureStorage: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setDiscoveryHistorySize: (buffer) => {
    set((state) => ({
      buffers: { ...state.buffers, discoveryHistorySize: buffer },
    }));
    scheduleSave(get().saveSettings);
  },

  // General actions
  setDefaultFrameType: (type) => {
    set((state) => ({
      general: { ...state.general, defaultFrameType: type },
    }));
    scheduleSave(get().saveSettings);
  },

  setQueryResultLimit: (limit) => {
    set((state) => ({
      buffers: { ...state.buffers, queryResultLimit: limit },
    }));
    scheduleSave(get().saveSettings);
  },

  setSessionManagerStatsInterval: (interval) => {
    set((state) => ({
      general: { ...state.general, sessionManagerStatsInterval: interval },
    }));
    scheduleSave(get().saveSettings);
  },

  setGraphBufferSize: (size) => {
    set((state) => ({
      buffers: { ...state.buffers, graphBufferSize: size },
    }));
    scheduleSave(get().saveSettings);
  },

  setDecoderMaxUnmatchedFrames: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, decoderMaxUnmatchedFrames: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setDecoderMaxFilteredFrames: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, decoderMaxFilteredFrames: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setDecoderMaxDecodedFrames: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, decoderMaxDecodedFrames: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setDecoderMaxDecodedPerSource: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, decoderMaxDecodedPerSource: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setTransmitMaxHistory: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, transmitMaxHistory: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setPreventIdleSleep: (value) => {
    set((state) => ({
      general: { ...state.general, preventIdleSleep: value },
    }));
    scheduleSave(get().saveSettings);
    // Update backend cache immediately
    const { keepDisplayAwake } = get().general;
    setWakeSettingsApi(value, keepDisplayAwake).catch(console.error);
  },

  setKeepDisplayAwake: (value) => {
    set((state) => ({
      general: { ...state.general, keepDisplayAwake: value },
    }));
    scheduleSave(get().saveSettings);
    // Update backend cache immediately (desktop)
    const { preventIdleSleep } = get().general;
    setWakeSettingsApi(preventIdleSleep, value).catch(console.error);
    // Update iOS screen wake (no-op on other platforms)
    setIOSScreenWake(value).catch(console.error);
  },

  setLogLevel: (value) => {
    set((state) => ({
      general: { ...state.general, logLevel: value },
    }));
    scheduleSave(get().saveSettings);
    // Update log level immediately
    setLogLevelApi(value).catch(console.error);
  },

  setTelemetryEnabled: (value) => {
    set((state) => ({
      general: { ...state.general, telemetryEnabled: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setTelemetryConsentGiven: (value) => {
    set((state) => ({
      general: { ...state.general, telemetryConsentGiven: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setUsageAnalyticsEnabled: (value) => {
    set((state) => ({
      general: { ...state.general, usageAnalyticsEnabled: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setUsageAnalyticsConsentGiven: (value) => {
    set((state) => ({
      general: { ...state.general, usageAnalyticsConsentGiven: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setInstallId: (value) => {
    set((state) => ({
      general: { ...state.general, installId: value },
    }));
    scheduleSave(get().saveSettings);
  },

    setModbusMaxRegisterErrors: (value) => {
        set((state) => ({
            general: { ...state.general, modbusMaxRegisterErrors: value },
        }));
        scheduleSave(get().saveSettings);
    },

  setSmpPort: (port) => {
    set((state) => ({
      general: { ...state.general, smpPort: port },
    }));
    scheduleSave(get().saveSettings);
  },

  setLanguage: (lang) => {
    set((state) => ({
      general: { ...state.general, language: lang },
    }));
    scheduleSave(get().saveSettings);
  },

  setMcpServerEnabled: (value) => {
    set((state) => ({ mcp: { ...state.mcp, serverEnabled: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpAllowControl: (value) => {
    set((state) => ({ mcp: { ...state.mcp, allowControl: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpAllowSessionControl: (value) => {
    set((state) => ({ mcp: { ...state.mcp, allowSessionControl: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpAllowCatalogWrite: (value) => {
    set((state) => ({ mcp: { ...state.mcp, allowCatalogWrite: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpAllowCatalogModify: (value) => {
    set((state) => ({ mcp: { ...state.mcp, allowCatalogModify: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpAllowDashboardWrite: (value) => {
    set((state) => ({ mcp: { ...state.mcp, allowDashboardWrite: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpAllowUiControl: (value) => {
    set((state) => ({ mcp: { ...state.mcp, allowUiControl: value } }));
    scheduleSave(get().saveSettings);
  },
  setMcpServerPort: (port) => {
    set((state) => ({ mcp: { ...state.mcp, serverPort: port } }));
    scheduleSave(get().saveSettings);
  },
  setMcpServerToken: (token) => {
    set((state) => ({ mcp: { ...state.mcp, serverToken: token } }));
    scheduleSave(get().saveSettings);
  },
}));
