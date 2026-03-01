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
  getAllGraphLayouts,
  type GraphLayout,
} from '../../../utils/graphLayouts';
import { setIOSScreenWake } from '../../../utils/platform';
// Types
export type SettingsSection = "general" | "privacy" | "locations" | "data-io" | "devices" | "buffers" | "catalogs" | "bookmarks" | "selection-sets" | "graph-layouts" | "display";
export type DefaultFrameType = 'can' | 'modbus' | 'serial';

// Buffer setting defaults — single source of truth, referenced by settingsStore and useSettings
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

export interface DirectoryValidation {
  exists: boolean;
  writable: boolean;
  error?: string;
}

export interface IOProfile {
  id: string;
  name: string;
  kind: 'mqtt' | 'postgres' | 'gvret_tcp' | 'gvret_usb' | 'csv_file' | 'serial' | 'slcan' | 'socketcan' | 'gs_usb' | 'modbus_tcp';
  connection: Record<string, any>;
  preferred_catalog?: string;
}

export interface CatalogFile {
  name: string;
  filename: string;
  path: string;
}

export interface SignalColours {
  none: string;
  low: string;
  medium: string;
  high: string;
}

export type ThemeMode = 'dark' | 'light' | 'auto';

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

interface AppSettings {
  config_path: string;
  decoder_dir: string;
  dump_dir: string;
  report_dir: string;
  io_profiles: IOProfile[];
  default_read_profile?: string | null;
  default_write_profiles?: string[];
  display_frame_id_format?: 'hex' | 'decimal';
  save_frame_id_format?: 'hex' | 'decimal';
  display_time_format?: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
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
  decoder_max_unmatched_frames?: number;
  decoder_max_filtered_frames?: number;
  decoder_max_decoded_frames?: number;
  decoder_max_decoded_per_source?: number;
  transmit_max_history?: number;
  smp_port?: number;
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
  log_level?: string;
  // Privacy / telemetry
  telemetry_enabled?: boolean;
  telemetry_consent_given?: boolean;
  // Buffer persistence
  clear_buffers_on_start?: boolean;
  buffer_storage?: string;
  // Modbus settings
  modbus_max_register_errors?: number;
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
  | 'editGraphLayout'
  | 'deleteGraphLayout';

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
  graphLayoutToEdit: GraphLayout | null;
  graphLayoutToDelete: GraphLayout | null;
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
  editGraphLayout: false,
  deleteGraphLayout: false,
};

const initialDialogPayload: DialogPayload = {
  editingProfileId: null,
  profileForm: { id: '', name: '', kind: 'mqtt', connection: {} },
  ioProfileToDelete: null,
  catalogToDelete: null,
  catalogToDuplicate: null,
  catalogToEdit: null,
  bookmarkToEdit: null,
  bookmarkToDelete: null,
  selectionSetToEdit: null,
  selectionSetToDelete: null,
  graphLayoutToEdit: null,
  graphLayoutToDelete: null,
};

const defaultSignalColours: SignalColours = {
  none: '#94a3b8',
  low: '#f59e0b',
  medium: '#3b82f6',
  high: '#22c55e',
};

export const defaultThemeColours: ThemeColours = {
  // Light mode
  bgPrimaryLight: '#ffffff',      // white
  bgSurfaceLight: '#f8fafc',      // slate-50
  textPrimaryLight: '#0f172a',    // slate-900
  textSecondaryLight: '#334155',  // slate-700
  borderDefaultLight: '#e2e8f0',  // slate-200
  dataBgLight: '#f8fafc',         // slate-50
  dataTextPrimaryLight: '#0f172a', // slate-900
  // Dark mode
  bgPrimaryDark: '#0f172a',       // slate-900
  bgSurfaceDark: '#1e293b',       // slate-800
  textPrimaryDark: '#ffffff',     // white
  textSecondaryDark: '#cbd5e1',   // slate-300
  borderDefaultDark: '#334155',   // slate-700
  dataBgDark: '#111827',          // gray-900
  dataTextPrimaryDark: '#e5e7eb', // gray-200
  // Accent colours (mode-independent)
  accentPrimary: '#2563eb',       // blue-600
  accentSuccess: '#16a34a',       // green-600
  accentDanger: '#dc2626',        // red-600
  accentWarning: '#d97706',       // amber-600
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

  // Graph layouts
  graphLayouts: GraphLayout[];

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
    themeMode: ThemeMode;
    themeColours: ThemeColours;
  };

  // Buffer settings
  buffers: {
    clearBuffersOnStart: boolean;
    bufferStorage: string;
    discoveryHistoryBuffer: number;
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
    modbusMaxRegisterErrors: number;
    smpPort: number;
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
  loadGraphLayouts: () => Promise<void>;

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
  setThemeMode: (mode: ThemeMode) => void;
  setThemeColour: (key: keyof ThemeColours, colour: string) => void;
  resetThemeColours: () => void;

  // Actions - Buffers
  setClearBuffersOnStart: (value: boolean) => void;
  setBufferStorage: (value: string) => void;
  setDiscoveryHistoryBuffer: (buffer: number) => void;
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
  setModbusMaxRegisterErrors: (value: number) => void;
  setSmpPort: (port: number) => void;
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

  graphLayouts: [],

  display: {
    frameIdFormat: 'hex',
    saveFrameIdFormat: 'hex',
    timeFormat: 'human',
    timezone: 'local',
    signalColours: { ...defaultSignalColours },
    binaryOneColour: '#14b8a6',
    binaryZeroColour: '#94a3b8',
    binaryUnusedColour: '#64748b',
    themeMode: 'auto',
    themeColours: { ...defaultThemeColours },
  },

  buffers: {
    clearBuffersOnStart: DEFAULT_CLEAR_BUFFERS_ON_START,
    bufferStorage: DEFAULT_BUFFER_STORAGE,
    discoveryHistoryBuffer: DEFAULT_DISCOVERY_HISTORY_BUFFER,
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
    modbusMaxRegisterErrors: DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
    smpPort: 1337,
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

      const normalized: AppSettings = {
        config_path: settings.config_path || '',
        decoder_dir: decoderDir,
        dump_dir: dumpDir,
        report_dir: reportDir,
        io_profiles: settings.io_profiles || [],
        default_read_profile: settings.default_read_profile ?? null,
        default_write_profiles: settings.default_write_profiles ?? [],
        display_frame_id_format: settings.display_frame_id_format === 'decimal' ? 'decimal' : 'hex',
        save_frame_id_format: settings.save_frame_id_format === 'decimal' ? 'decimal' : 'hex',
        display_time_format: settings.display_time_format ?? 'human',
        display_timezone: settings.display_timezone ?? 'local',
        signal_colour_none: settings.signal_colour_none || defaultSignalColours.none,
        signal_colour_low: settings.signal_colour_low || defaultSignalColours.low,
        signal_colour_medium: settings.signal_colour_medium || defaultSignalColours.medium,
        signal_colour_high: settings.signal_colour_high || defaultSignalColours.high,
        binary_one_colour: settings.binary_one_colour || '#14b8a6',
        binary_zero_colour: settings.binary_zero_colour || '#94a3b8',
        binary_unused_colour: settings.binary_unused_colour || '#64748b',
        discovery_history_buffer: settings.discovery_history_buffer ?? DEFAULT_DISCOVERY_HISTORY_BUFFER,
        query_result_limit: settings.query_result_limit ?? DEFAULT_QUERY_RESULT_LIMIT,
        session_manager_stats_interval: settings.session_manager_stats_interval ?? 60,
        graph_buffer_size: settings.graph_buffer_size ?? DEFAULT_GRAPH_BUFFER_SIZE,
        decoder_max_unmatched_frames: settings.decoder_max_unmatched_frames ?? DEFAULT_DECODER_MAX_UNMATCHED_FRAMES,
        decoder_max_filtered_frames: settings.decoder_max_filtered_frames ?? DEFAULT_DECODER_MAX_FILTERED_FRAMES,
        decoder_max_decoded_frames: settings.decoder_max_decoded_frames ?? DEFAULT_DECODER_MAX_DECODED_FRAMES,
        decoder_max_decoded_per_source: settings.decoder_max_decoded_per_source ?? DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
        transmit_max_history: settings.transmit_max_history ?? DEFAULT_TRANSMIT_MAX_HISTORY,
        default_frame_type: (settings.default_frame_type as DefaultFrameType) ?? 'can',
        // Theme settings
        theme_mode: (settings.theme_mode as ThemeMode) ?? 'auto',
        theme_bg_primary_light: settings.theme_bg_primary_light || defaultThemeColours.bgPrimaryLight,
        theme_bg_surface_light: settings.theme_bg_surface_light || defaultThemeColours.bgSurfaceLight,
        theme_text_primary_light: settings.theme_text_primary_light || defaultThemeColours.textPrimaryLight,
        theme_text_secondary_light: settings.theme_text_secondary_light || defaultThemeColours.textSecondaryLight,
        theme_border_default_light: settings.theme_border_default_light || defaultThemeColours.borderDefaultLight,
        theme_data_bg_light: settings.theme_data_bg_light || defaultThemeColours.dataBgLight,
        theme_data_text_primary_light: settings.theme_data_text_primary_light || defaultThemeColours.dataTextPrimaryLight,
        theme_bg_primary_dark: settings.theme_bg_primary_dark || defaultThemeColours.bgPrimaryDark,
        theme_bg_surface_dark: settings.theme_bg_surface_dark || defaultThemeColours.bgSurfaceDark,
        theme_text_primary_dark: settings.theme_text_primary_dark || defaultThemeColours.textPrimaryDark,
        theme_text_secondary_dark: settings.theme_text_secondary_dark || defaultThemeColours.textSecondaryDark,
        theme_border_default_dark: settings.theme_border_default_dark || defaultThemeColours.borderDefaultDark,
        theme_data_bg_dark: settings.theme_data_bg_dark || defaultThemeColours.dataBgDark,
        theme_data_text_primary_dark: settings.theme_data_text_primary_dark || defaultThemeColours.dataTextPrimaryDark,
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
        // Buffer persistence
        clear_buffers_on_start: settings.clear_buffers_on_start ?? DEFAULT_CLEAR_BUFFERS_ON_START,
        buffer_storage: settings.buffer_storage ?? DEFAULT_BUFFER_STORAGE,
        // Modbus
        modbus_max_register_errors: settings.modbus_max_register_errors ?? DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
        // Networking
        smp_port: settings.smp_port ?? 1337,
      };

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
          clearBuffersOnStart: normalized.clear_buffers_on_start ?? DEFAULT_CLEAR_BUFFERS_ON_START,
          bufferStorage: normalized.buffer_storage ?? DEFAULT_BUFFER_STORAGE,
          discoveryHistoryBuffer: normalized.discovery_history_buffer ?? DEFAULT_DISCOVERY_HISTORY_BUFFER,
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
          modbusMaxRegisterErrors: normalized.modbus_max_register_errors ?? DEFAULT_MODBUS_MAX_REGISTER_ERRORS,
          smpPort: normalized.smp_port ?? 1337,
        },
        originalSettings: normalized,
      });

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
      const { decoderDir } = get().locations;
      if (!decoderDir) return;
      const catalogList = await listCatalogs(decoderDir);
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

  loadGraphLayouts: async () => {
    try {
      const allLayouts = await getAllGraphLayouts();
      allLayouts.sort((a, b) => a.name.localeCompare(b.name));
      set({ graphLayouts: allLayouts });
    } catch (error) {
      console.error('Failed to load graph layouts:', error);
    }
  },

  // Saving actions
  saveSettings: async () => {
    if (!get().hasUnsavedChanges()) return;

    try {
      const { locations, ioProfiles, display, buffers, general } = get();

      const settings = {
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
        // Buffers
        clear_buffers_on_start: buffers.clearBuffersOnStart,
        buffer_storage: buffers.bufferStorage,
        discovery_history_buffer: buffers.discoveryHistoryBuffer,
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
      };

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
    const { locations, ioProfiles, display, buffers, general, originalSettings } = get();
    if (!originalSettings) return false;

    const currentSettings = {
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
      // Buffers
      clear_buffers_on_start: buffers.clearBuffersOnStart,
      discovery_history_buffer: buffers.discoveryHistoryBuffer,
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
    };

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
  setClearBuffersOnStart: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, clearBuffersOnStart: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setBufferStorage: (value) => {
    set((state) => ({
      buffers: { ...state.buffers, bufferStorage: value },
    }));
    scheduleSave(get().saveSettings);
  },

  setDiscoveryHistoryBuffer: (buffer) => {
    set((state) => ({
      buffers: { ...state.buffers, discoveryHistoryBuffer: buffer },
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
}));
