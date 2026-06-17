// ui/src/stores/catalogEditorStore.ts

import { create } from 'zustand';
import { tlog } from '../api/settings';
import { emit } from '@tauri-apps/api/event';
import { WINDOW_EVENTS } from '../events/registry';
import type { CatalogSavedPayload } from '../events/registry';
import type { CanidFields, EditMode, MetaFields, TomlNode, ValidationError, SerialEncoding, HeaderFieldFormat, CanProtocolConfig, SerialProtocolConfig, ModbusProtocolConfig, SerialChecksumConfig, ProtocolType, SlaveOption } from '../apps/catalog/types';
import type { CatalogViewMode } from '../apps/catalog/tree/frameGroups';
import type { CatalogDiff } from '../api/catalog';

/** CAN header field form entry - name + field settings */
export interface CanHeaderFieldEntry {
  name: string;
  mask: string;        // Hex string like "0x000000FF"
  shift?: number;
  format: HeaderFieldFormat;
}

/** Serial header field form entry - name + mask over header bytes */
export interface SerialHeaderFieldEntry {
  name: string;
  mask: number;           // Bitmask over header bytes (e.g., 0xFF00 for first byte of 2-byte header)
  endianness: "big" | "little";
  format: HeaderFieldFormat;
}

// State types
export interface CatalogEditorState {
  // File state
  file: {
    path: string | null;
    name: string | null;
    decoderDir: string;
  };

  // Content state
  content: {
    toml: string;
    lastSavedToml: string;
    /** Increments on reload to force re-parse even when content unchanged */
    reloadVersion: number;
    /** Rust-computed diff of `toml` vs `lastSavedToml` (drives the unsaved-changes
     *  indicator and the Text-mode diff view). `null` until first computed. */
    diff: CatalogDiff | null;
  };

  // Edit mode
  mode: EditMode;

  // Tree state
  tree: {
    nodes: TomlNode[];
    selectedPath: string[] | null;
    expandedIds: Set<string>;
    // Protocol configs parsed from TOML
    canConfig?: CanProtocolConfig;
    serialConfig?: SerialProtocolConfig;
    modbusConfig?: ModbusProtocolConfig;
    // Track whether frames exist for each protocol
    hasCanFrames: boolean;
    hasSerialFrames: boolean;
    hasModbusFrames: boolean;
  };

  // UI state
  ui: {
    viewMode: CatalogViewMode;
    /** Active protocol filter from the badges (null = all protocols). */
    selectedProtocol: ProtocolType | null;
    availablePeers: string[];
    /** Declared slave nodes (name + address) for the Modbus Slave picker. */
    availableSlaves: SlaveOption[];
    find: {
      isOpen: boolean;
      query: string;
      matches: string[][]; // Array of paths that match
      currentIndex: number; // Current match index (-1 = none)
    };
    textFind: {
      isOpen: boolean;
      query: string;
      matchCount: number;
      currentIndex: number; // Current match index (-1 = none)
    };
    treeScrollTop: number;
    dialogs: {
      newCatalog: boolean;
      addNode: boolean;
      editNode: boolean;
      addMuxCase: boolean;
      editMuxCase: boolean;
      deleteCanFrame: boolean;
      deleteSignal: boolean;
      deleteChecksum: boolean;
      editChecksum: boolean;
      deleteGeneric: boolean;
      deleteNode: boolean;
      unsavedChanges: boolean;
      signalEdit: boolean;
      muxEdit: boolean;
      validationErrors: boolean;
      config: boolean; // Unified config dialog (replaces canConfig, serialConfig, modbusConfig)
    };
    dialogPayload: {
      idToDelete: string | null;
      nodeToDelete: string | null;
      genericPathToDelete: string[] | null;
      genericLabel: string | null;
      signalToDelete: any | null;
      checksumToDelete: any | null;
      checksumToEdit: any | null;
      currentMuxPath: string[];
      editingSignalIndex: number | null;
      editingCaseMuxPath: string[] | null;
      editingCaseOriginalValue: string | null;
      editingNodeOriginalName: string | null;
    };
  };

  // Form state
  forms: {
    meta: MetaFields;
    canFrame: CanidFields;
    signal: any;
    mux: any;
    nodeName: string;
    nodeNotes: string;
    /** Modbus-specific: the device (slave) address a node owns. */
    nodeDeviceAddress?: number;
    muxCaseValue: string;
    muxCaseNotes: string;
    canDefaultEndianness: "little" | "big";  // For CAN config - stored in [meta.can]
    canDefaultInterval: number | undefined;   // For CAN config - stored in [meta.can]
    canDefaultExtended: boolean | undefined;  // For CAN config - default to 29-bit extended IDs
    canDefaultFd: boolean | undefined;        // For CAN config - default to CAN FD frames
    canFrameIdMask: string;           // For CAN config - hex string like "0x1FFFFF00"
    canHeaderFields: CanHeaderFieldEntry[];  // For CAN config - header fields extracted from CAN ID
    serialEncoding: SerialEncoding;  // For new catalog dialog - stored in [frame.serial.config]
    serialByteOrder: "little" | "big";  // For Serial config - default byte order for signals
    serialHeaderFields: SerialHeaderFieldEntry[];  // For Serial config - header field masks over header bytes
    serialHeaderLength: number | undefined;  // For Serial config - global header length in bytes
    serialMaxFrameLength: number | undefined;  // For Serial config - max frame length (default: 64)
    serialChecksum: SerialChecksumConfig | null;  // For Serial config - protocol-level checksum defaults
    modbusDeviceAddress: number;     // For new catalog dialog - stored in [meta.modbus]
    modbusRegisterBase: 0 | 1;       // For new catalog dialog - stored in [meta.modbus]
    modbusDefaultInterval: number | undefined;  // Default poll interval in ms - stored in [meta.modbus]
    modbusDefaultByteOrder: "big" | "little";   // Default byte order - stored in [meta.modbus]
    modbusDefaultWordOrder: "big" | "little";   // Default word order - stored in [meta.modbus]
  };

  // Validation state
  validation: {
    errors: ValidationError[];
    isValid: boolean | null; // null = not validated yet, true = valid, false = invalid
  };

  // Status state
  status: {
    isLoading: boolean;
    isSaving: boolean;
    lastError?: string;
    /** Set when a catalogue was upgraded to the current schema on load (the
     * working buffer holds the migrated text, the baseline the on-disk original).
     * `null` once dismissed, saved, or when no migration occurred. */
    migration: { summary: string[] } | null;
  };

  // Actions - File operations
  setDecoderDir: (dir: string) => void;
  openSuccess: (path: string, toml: string) => void;
  /** Like {@link openSuccess} but the loaded file was upgraded on open: the
   * working buffer is the migrated text while the diff baseline stays the
   * on-disk original, so the upgrade shows as an unsaved, diffable change. */
  openSuccessMigrated: (path: string, originalToml: string, migratedToml: string, summary: string[]) => void;
  openError: (error: string) => void;
  saveStart: () => void;
  saveSuccess: (toml: string) => void;
  saveError: (error: string) => void;
  /** Dismiss the load-time migration banner. */
  dismissMigration: () => void;

  // Actions - Content
  setMode: (mode: EditMode) => void;
  setToml: (toml: string) => void;
  /** Cache the Rust-computed diff/dirty result (see {@link CatalogDiff}). */
  setDiff: (diff: CatalogDiff | null) => void;

  // Actions - Validation
  setValidation: (errors: ValidationError[], isValid?: boolean) => void;
  clearValidation: () => void;

  // Actions - Tree
  setTree: (nodes: TomlNode[]) => void;
  setTreeData: (data: {
    nodes: TomlNode[];
    canConfig?: CanProtocolConfig;
    serialConfig?: SerialProtocolConfig;
    modbusConfig?: ModbusProtocolConfig;
    hasCanFrames?: boolean;
    hasSerialFrames?: boolean;
    hasModbusFrames?: boolean;
  }) => void;
  setSelectedPath: (path: string[] | null) => void;
  toggleExpanded: (id: string) => void;
  resetExpanded: () => void;
  /** Expand every node that has children (skips `meta`, mirroring the renderer). */
  expandAll: () => void;

  // Actions - UI
  setViewMode: (mode: CatalogViewMode) => void;
  setSelectedProtocol: (protocol: ProtocolType | null) => void;
  setAvailablePeers: (peers: string[]) => void;
  setAvailableSlaves: (slaves: SlaveOption[]) => void;

  // Actions - Scroll
  setTreeScrollTop: (scrollTop: number) => void;

  // Actions - Find (UI mode)
  openFind: () => void;
  closeFind: () => void;
  setFindQuery: (query: string) => void;
  setFindMatches: (matches: string[][]) => void;
  findNext: () => void;
  findPrevious: () => void;

  // Actions - Text Find (text mode)
  openTextFind: () => void;
  closeTextFind: () => void;
  setTextFindQuery: (query: string) => void;
  setTextFindMatchCount: (count: number) => void;
  textFindNext: () => void;
  textFindPrevious: () => void;

  // Actions - Dialogs
  openDialog: (name: keyof CatalogEditorState['ui']['dialogs']) => void;
  closeDialog: (name: keyof CatalogEditorState['ui']['dialogs']) => void;
  resetDialogs: () => void;
  setDialogPayload: (payload: Partial<CatalogEditorState['ui']['dialogPayload']>) => void;

  // Actions - Forms
  setMetaForm: (meta: MetaFields) => void;
  setCanFrameForm: (canFrame: CanidFields) => void;
  setSignalForm: (signal: any) => void;
  setMuxForm: (mux: any) => void;
  setNodeName: (name: string) => void;
  setNodeNotes: (notes: string) => void;
  setNodeDeviceAddress: (addr: number | undefined) => void;
  setMuxCaseValue: (value: string) => void;
  setMuxCaseNotes: (notes: string) => void;
  setCanDefaultEndianness: (endianness: "little" | "big") => void;
  setCanDefaultInterval: (interval: number | undefined) => void;
  setCanDefaultExtended: (extended: boolean | undefined) => void;
  setCanDefaultFd: (fd: boolean | undefined) => void;
  setCanFrameIdMask: (mask: string) => void;
  setCanHeaderFields: (fields: CanHeaderFieldEntry[]) => void;
  setSerialEncoding: (encoding: SerialEncoding) => void;
  setSerialByteOrder: (byteOrder: "little" | "big") => void;
  setSerialHeaderFields: (fields: SerialHeaderFieldEntry[]) => void;
  setSerialHeaderLength: (length: number | undefined) => void;
  setSerialMaxFrameLength: (length: number | undefined) => void;
  setSerialChecksum: (checksum: SerialChecksumConfig | null) => void;
  setModbusDeviceAddress: (address: number) => void;
  setModbusRegisterBase: (base: 0 | 1) => void;
  setModbusDefaultInterval: (interval: number | undefined) => void;
  setModbusDefaultByteOrder: (order: "big" | "little") => void;
  setModbusDefaultWordOrder: (order: "big" | "little") => void;

  // Computed
  hasUnsavedChanges: () => boolean;
}

const initialDialogs = {
  newCatalog: false,
  addNode: false,
  editNode: false,
  addMuxCase: false,
  editMuxCase: false,
  deleteCanFrame: false,
  deleteSignal: false,
  deleteChecksum: false,
  editChecksum: false,
  deleteGeneric: false,
  deleteNode: false,
  unsavedChanges: false,
  signalEdit: false,
  muxEdit: false,
  validationErrors: false,
  config: false, // Unified config dialog
};

const initialDialogPayload = {
  idToDelete: null,
  nodeToDelete: null,
  genericPathToDelete: null,
  genericLabel: null,
  signalToDelete: null,
  checksumToDelete: null,
  checksumToEdit: null,
  currentMuxPath: [],
  editingSignalIndex: null,
  editingCaseMuxPath: null,
  editingCaseOriginalValue: null,
  editingNodeOriginalName: null,
};

export const useCatalogEditorStore = create<CatalogEditorState>((set, get) => ({
  // Initial state
  file: { path: null, name: null, decoderDir: '' },
  content: { toml: '', lastSavedToml: '', reloadVersion: 0, diff: null },
  mode: 'ui',

  tree: {
    nodes: [],
    selectedPath: null,
    expandedIds: new Set<string>(),
    canConfig: undefined,
    serialConfig: undefined,
    modbusConfig: undefined,
    hasCanFrames: false,
    hasSerialFrames: false,
    hasModbusFrames: false,
  },

  ui: {
    viewMode: 'tree',
    selectedProtocol: null,
    availablePeers: [],
    availableSlaves: [],
    find: {
      isOpen: false,
      query: '',
      matches: [],
      currentIndex: -1,
    },
    textFind: {
      isOpen: false,
      query: '',
      matchCount: 0,
      currentIndex: -1,
    },
    treeScrollTop: 0,
    dialogs: { ...initialDialogs },
    dialogPayload: { ...initialDialogPayload },
  },

  forms: {
    meta: {
      name: '',
      version: 1,
    },
    canFrame: {
      id: '',
      length: 8,
      transmitter: undefined,
      interval: undefined,
      isIntervalInherited: false,
      isLengthInherited: false,
      isTransmitterInherited: false,
      notes: undefined,
    },
    signal: {
      name: '',
      start_bit: 0,
      bit_length: 8,
    },
    mux: {
      name: '',
      start_bit: 0,
      bit_length: 8,
    },
    nodeName: '',
    nodeNotes: '',
    nodeDeviceAddress: undefined,
    muxCaseValue: '',
    muxCaseNotes: '',
    canDefaultEndianness: 'little',   // Default for new catalogs - stored in [meta.can]
    canDefaultInterval: undefined,     // Default for new catalogs - stored in [meta.can]
    canDefaultExtended: undefined,     // Default for new catalogs - undefined = auto-detect from ID
    canDefaultFd: undefined,           // Default for new catalogs - undefined = classic CAN
    canFrameIdMask: '',       // Empty = no mask
    canHeaderFields: [],      // Empty = no header fields
    serialEncoding: 'slip',  // Default for new catalogs
    serialByteOrder: 'big',  // Default for new catalogs - stored in [meta.serial]
    serialHeaderFields: [],  // Empty = no header fields (ID field replaces frame_id_mask)
    serialHeaderLength: undefined,  // No global header length
    serialMaxFrameLength: undefined,  // Default: 64 in backend
    serialChecksum: null,    // No protocol-level checksum config
    modbusDeviceAddress: 1,  // Default for new catalogs
    modbusRegisterBase: 0,   // Default for new catalogs (0-based)
    modbusDefaultInterval: undefined,  // No default interval
    modbusDefaultByteOrder: 'big',     // Default for new catalogs
    modbusDefaultWordOrder: 'big',     // Default for new catalogs
  },

  validation: { errors: [], isValid: null },
  status: { isLoading: false, isSaving: false, migration: null },

  // File operations
  setDecoderDir: (dir) =>
    set((state) => ({ file: { ...state.file, decoderDir: dir } })),

  openSuccess: (path, toml) => {
    const name = path.split('/').pop() ?? null;
    const newReloadVersion = get().content.reloadVersion + 1;
    set({
      file: { ...get().file, path, name },
      content: { toml, lastSavedToml: toml, reloadVersion: newReloadVersion, diff: null },
      tree: {
        nodes: [],
        selectedPath: null,
        expandedIds: new Set<string>(),
        canConfig: undefined,
        serialConfig: undefined,
        modbusConfig: undefined,
        hasCanFrames: false,
        hasSerialFrames: false,
        hasModbusFrames: false,
      },
      ui: {
        ...get().ui,
        viewMode: 'tree',
        selectedProtocol: null,
        availablePeers: [],
    availableSlaves: [],
        dialogs: { ...initialDialogs },
        dialogPayload: { ...initialDialogPayload },
      },
      validation: { errors: [], isValid: null },
      status: { ...get().status, isLoading: false, lastError: undefined, migration: null },
    });
  },

  openSuccessMigrated: (path, originalToml, migratedToml, summary) => {
    // Reuse the full open reset (working buffer = migrated text), then peg the
    // diff baseline to the on-disk original and raise the migration banner. The
    // buffer now differs from the baseline, so the diff/dirty indicators light up.
    get().openSuccess(path, migratedToml);
    set((state) => ({
      content: { ...state.content, lastSavedToml: originalToml },
      status: { ...state.status, migration: { summary } },
    }));
  },

  openError: (error) =>
    set((state) => ({
      status: { ...state.status, isLoading: false, lastError: error, migration: null },
    })),

  dismissMigration: () =>
    set((state) => ({ status: { ...state.status, migration: null } })),

  saveStart: () =>
    set((state) => ({
      status: { ...state.status, isSaving: true, lastError: undefined },
    })),

  saveSuccess: (toml) => {
    set((state) => ({
      content: { ...state.content, toml, lastSavedToml: toml, diff: null },
      status: { ...state.status, isSaving: false, migration: null },
    }));

    // Emit catalog-saved event for inter-window communication
    const catalogPath = useCatalogEditorStore.getState().file.path;
    if (catalogPath) {
      const payload: CatalogSavedPayload = {
        catalogPath,
        timestamp: Date.now(),
      };
      emit(WINDOW_EVENTS.CATALOG_SAVED, payload).catch((err) =>
        tlog.info(`[catalogEditorStore] Failed to emit catalog-saved event: ${err}`)
      );
    }
  },

  saveError: (error) =>
    set((state) => ({
      status: { ...state.status, isSaving: false, lastError: error },
    })),

  // Content actions
  setMode: (mode) => set({ mode }),

  setToml: (toml) =>
    // Invalidate the cached diff; the editor recomputes it from Rust (debounced),
    // so the dirty indicator falls back to a string compare for the brief gap.
    set((state) => ({ content: { ...state.content, toml, diff: null } })),

  setDiff: (diff) =>
    set((state) => ({ content: { ...state.content, diff } })),

  // Validation actions
  setValidation: (errors, isValid) => set({
    validation: {
      errors,
      isValid: isValid !== undefined ? isValid : errors.length === 0
    }
  }),

  clearValidation: () => set({ validation: { errors: [], isValid: null } }),

  // Tree actions
  setTree: (nodes) =>
    set((state) => ({ tree: { ...state.tree, nodes } })),

  setTreeData: (data) =>
    set((state) => ({
      tree: {
        ...state.tree,
        nodes: data.nodes,
        canConfig: data.canConfig,
        serialConfig: data.serialConfig,
        modbusConfig: data.modbusConfig,
        hasCanFrames: data.hasCanFrames ?? false,
        hasSerialFrames: data.hasSerialFrames ?? false,
        hasModbusFrames: data.hasModbusFrames ?? false,
      },
    })),

  setSelectedPath: (path) =>
    set((state) => ({ tree: { ...state.tree, selectedPath: path } })),

  toggleExpanded: (id) => {
    const { tree } = get();
    const next = new Set(tree.expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ tree: { ...tree, expandedIds: next } });
  },

  resetExpanded: () =>
    set((state) => ({
      tree: { ...state.tree, expandedIds: new Set<string>() },
    })),

  expandAll: () => {
    const { tree } = get();
    const ids = new Set<string>();
    const walk = (nodes: TomlNode[]) => {
      for (const node of nodes) {
        const hasChildren = !!node.children && node.children.length > 0 && node.type !== "meta";
        if (hasChildren) {
          ids.add(node.path.join("."));
          walk(node.children!);
        }
      }
    };
    walk(tree.nodes);
    set({ tree: { ...tree, expandedIds: ids } });
  },

  // UI actions
  setViewMode: (mode) =>
    set((state) => ({ ui: { ...state.ui, viewMode: mode } })),

  setSelectedProtocol: (protocol) =>
    set((state) => ({ ui: { ...state.ui, selectedProtocol: protocol } })),

  setAvailablePeers: (peers) =>
    set((state) => ({ ui: { ...state.ui, availablePeers: peers } })),

  setAvailableSlaves: (slaves) =>
    set((state) => ({ ui: { ...state.ui, availableSlaves: slaves } })),

  // Scroll actions
  setTreeScrollTop: (scrollTop) =>
    set((state) => ({ ui: { ...state.ui, treeScrollTop: scrollTop } })),

  // Find actions
  openFind: () =>
    set((state) => ({
      ui: { ...state.ui, find: { ...state.ui.find, isOpen: true } },
    })),

  closeFind: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        find: { isOpen: false, query: '', matches: [], currentIndex: -1 },
      },
    })),

  setFindQuery: (query) =>
    set((state) => ({
      ui: {
        ...state.ui,
        find: { ...state.ui.find, query, currentIndex: -1 },
      },
    })),

  setFindMatches: (matches) =>
    set((state) => ({
      ui: {
        ...state.ui,
        find: { ...state.ui.find, matches, currentIndex: matches.length > 0 ? 0 : -1 },
      },
    })),

  findNext: () => {
    const { ui } = get();
    const { matches, currentIndex } = ui.find;
    if (matches.length === 0) return;
    const nextIndex = (currentIndex + 1) % matches.length;
    set({
      ui: { ...ui, find: { ...ui.find, currentIndex: nextIndex } },
    });
  },

  findPrevious: () => {
    const { ui } = get();
    const { matches, currentIndex } = ui.find;
    if (matches.length === 0) return;
    const prevIndex = currentIndex <= 0 ? matches.length - 1 : currentIndex - 1;
    set({
      ui: { ...ui, find: { ...ui.find, currentIndex: prevIndex } },
    });
  },

  // Text Find actions (text mode)
  openTextFind: () =>
    set((state) => ({
      ui: { ...state.ui, textFind: { ...state.ui.textFind, isOpen: true } },
    })),

  closeTextFind: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        textFind: { isOpen: false, query: '', matchCount: 0, currentIndex: -1 },
      },
    })),

  setTextFindQuery: (query) =>
    set((state) => ({
      ui: {
        ...state.ui,
        textFind: { ...state.ui.textFind, query, currentIndex: -1 },
      },
    })),

  setTextFindMatchCount: (matchCount) =>
    set((state) => ({
      ui: {
        ...state.ui,
        // Don't auto-navigate - keep currentIndex at -1 until user explicitly navigates
        textFind: { ...state.ui.textFind, matchCount, currentIndex: -1 },
      },
    })),

  textFindNext: () => {
    const { ui } = get();
    const { matchCount, currentIndex } = ui.textFind;
    if (matchCount === 0) return;
    // If currentIndex is -1 (no navigation yet), start at 0; otherwise go to next
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % matchCount;
    set({
      ui: { ...ui, textFind: { ...ui.textFind, currentIndex: nextIndex } },
    });
  },

  textFindPrevious: () => {
    const { ui } = get();
    const { matchCount, currentIndex } = ui.textFind;
    if (matchCount === 0) return;
    // If currentIndex is -1 (no navigation yet), start at last match; otherwise go to previous
    const prevIndex = currentIndex < 0 ? matchCount - 1 : (currentIndex <= 0 ? matchCount - 1 : currentIndex - 1);
    set({
      ui: { ...ui, textFind: { ...ui.textFind, currentIndex: prevIndex } },
    });
  },

  // Dialog actions
  openDialog: (name) =>
    set((state) => ({
      ui: { ...state.ui, dialogs: { ...state.ui.dialogs, [name]: true } },
    })),

  closeDialog: (name) =>
    set((state) => ({
      ui: { ...state.ui, dialogs: { ...state.ui.dialogs, [name]: false } },
    })),

  resetDialogs: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        dialogs: { ...initialDialogs },
        dialogPayload: { ...initialDialogPayload },
      },
    })),

  setDialogPayload: (payload) =>
    set((state) => ({
      ui: {
        ...state.ui,
        dialogPayload: { ...state.ui.dialogPayload, ...payload },
      },
    })),

  // Form actions
  setMetaForm: (meta) =>
    set((state) => ({ forms: { ...state.forms, meta } })),

  setCanFrameForm: (canFrame) =>
    set((state) => ({ forms: { ...state.forms, canFrame } })),

  setSignalForm: (signal) =>
    set((state) => ({ forms: { ...state.forms, signal } })),

  setMuxForm: (mux) =>
    set((state) => ({ forms: { ...state.forms, mux } })),

  setNodeName: (nodeName) =>
    set((state) => ({ forms: { ...state.forms, nodeName } })),

  setNodeNotes: (nodeNotes) =>
    set((state) => ({ forms: { ...state.forms, nodeNotes } })),

  setNodeDeviceAddress: (nodeDeviceAddress) =>
    set((state) => ({ forms: { ...state.forms, nodeDeviceAddress } })),

  setMuxCaseValue: (muxCaseValue) =>
    set((state) => ({ forms: { ...state.forms, muxCaseValue } })),

  setMuxCaseNotes: (muxCaseNotes) =>
    set((state) => ({ forms: { ...state.forms, muxCaseNotes } })),

  setCanDefaultEndianness: (canDefaultEndianness) =>
    set((state) => ({ forms: { ...state.forms, canDefaultEndianness } })),

  setCanDefaultInterval: (canDefaultInterval) =>
    set((state) => ({ forms: { ...state.forms, canDefaultInterval } })),

  setCanDefaultExtended: (canDefaultExtended) =>
    set((state) => ({ forms: { ...state.forms, canDefaultExtended } })),

  setCanDefaultFd: (canDefaultFd) =>
    set((state) => ({ forms: { ...state.forms, canDefaultFd } })),

  setCanFrameIdMask: (canFrameIdMask) =>
    set((state) => ({ forms: { ...state.forms, canFrameIdMask } })),

  setCanHeaderFields: (canHeaderFields) =>
    set((state) => ({ forms: { ...state.forms, canHeaderFields } })),

  setSerialEncoding: (serialEncoding) =>
    set((state) => ({ forms: { ...state.forms, serialEncoding } })),

  setSerialByteOrder: (serialByteOrder) =>
    set((state) => ({ forms: { ...state.forms, serialByteOrder } })),

  setSerialHeaderFields: (serialHeaderFields) =>
    set((state) => ({ forms: { ...state.forms, serialHeaderFields } })),

  setSerialHeaderLength: (serialHeaderLength) =>
    set((state) => ({ forms: { ...state.forms, serialHeaderLength } })),

  setSerialMaxFrameLength: (serialMaxFrameLength) =>
    set((state) => ({ forms: { ...state.forms, serialMaxFrameLength } })),

  setSerialChecksum: (serialChecksum) =>
    set((state) => ({ forms: { ...state.forms, serialChecksum } })),

  setModbusDeviceAddress: (modbusDeviceAddress) =>
    set((state) => ({ forms: { ...state.forms, modbusDeviceAddress } })),

  setModbusRegisterBase: (modbusRegisterBase) =>
    set((state) => ({ forms: { ...state.forms, modbusRegisterBase } })),

  setModbusDefaultInterval: (modbusDefaultInterval) =>
    set((state) => ({ forms: { ...state.forms, modbusDefaultInterval } })),

  setModbusDefaultByteOrder: (modbusDefaultByteOrder) =>
    set((state) => ({ forms: { ...state.forms, modbusDefaultByteOrder } })),

  setModbusDefaultWordOrder: (modbusDefaultWordOrder) =>
    set((state) => ({ forms: { ...state.forms, modbusDefaultWordOrder } })),

  // Computed
  hasUnsavedChanges: () => {
    const { content } = get();
    // Prefer the Rust-computed diff; fall back to a string compare until it lands.
    if (content.diff) return content.diff.dirty;
    return content.toml !== content.lastSavedToml && content.lastSavedToml !== '';
  },
}));
