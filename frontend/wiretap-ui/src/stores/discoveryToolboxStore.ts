// ui/src/stores/discoveryToolboxStore.ts
//
// Toolbox state and analysis functionality for Discovery app.
// Manages analysis tools (message order, changes, serial analysis) and decoder knowledge.

import { create } from 'zustand';
import type { FrameMessage } from '../types/frame';
import type { MessageOrderResult } from '../utils/analysis/messageOrderAnalysis';
import type { PayloadAnalysisResult, MirrorGroup, TimestampedPayload } from '../utils/analysis/payloadAnalysis';
import type { SerialFrameAnalysisResult } from '../utils/analysis/serialFrameAnalysis';
import { detectSerialFraming, type FramingDetectionResult } from '../api/framingDetection';
import { tlog } from '../api/settings';
import { byteToHex } from '../utils/byteUtils';
import type { ModbusRtuOptions } from '../api/capture';
import type {
  ChecksumDiscoveryOptions,
  ChecksumDiscoveryResult,
} from '../api/checksums';
import {
  type DecoderKnowledge,
  createEmptyKnowledge,
  initializeFrameKnowledge,
  updateKnowledgeFromMessageOrder,
  updateKnowledgeFromPayloadAnalysis,
} from '../utils/decoderKnowledge';
import type { FcProbeEntry, Protocol } from '../api/io';
import { MODBUS_BLANK_CONNECTION, type ModbusConnection } from '../utils/modbusProfiles';
import type { FrameInfo } from './discoveryStore';
import { parseFrameKey, type ProtocolFrames } from '../utils/frameKey';
import { useDiscoveryUIStore } from './discoveryUIStore';
import { ANALYSIS_YIELD_MS } from '../constants';

// Toolbox types
export type ToolboxView = 'frames' | 'message-order' | 'changes' | 'serial-framing' | 'serial-payload' | 'checksum-discovery' | 'modbus-register-scan' | 'modbus-unit-scan' | 'modbus-function-codes';

/**
 * Where a checksum scan reads its payloads: a capture Rust can read itself, or
 * the frames the frontend holds when nothing has written them to one.
 */
export type ChecksumScanSource =
  | { captureId: string; selection: ProtocolFrames[] }
  | { frames: FrameMessage[] };

/** The `ToolboxState` slot each tool writes its output into. */
export type ToolResultKey =
  | 'messageOrderResults'
  | 'changesResults'
  | 'serialFramingResults'
  | 'serialPayloadResults'
  | 'checksumDiscoveryResults'
  | 'modbusRegisterScanResults'
  | 'modbusUnitIdScanResults'
  | 'modbusFcProbeResults';

/**
 * Tab ID, label and result slot for each analysis tool's output tab.
 *
 * `resultKey` is here so the two ways of discarding a result — closing one tab,
 * and dropping the source — read the same list. They used to spell it out
 * separately and had already drifted apart by one tool.
 *
 * `protocol` is what a tool's output *is*, for tools that only ever speak one.
 * With no source selected there is no session and no frame to read a protocol
 * off, and the view would otherwise fall back to claiming CAN.
 *
 * `ownsData` divides the two kinds of tool. An analysis tool describes the
 * frames currently on screen, so dropping the source invalidates it. A Modbus
 * tool went and got its own answer — a sweep from its own capture, a probe from
 * four requests — and stays true whatever the app looks at next. Only the first
 * kind is cleared when the view resets, which is what lets scan tabs accumulate
 * as you work through a device instead of each sweep wiping the last.
 */
export const TOOL_TAB_CONFIG: Record<
  string,
  { tabId: string; label: string; resultKey: ToolResultKey; ownsData?: boolean; protocol?: Protocol }
> = {
  'message-order':        { tabId: 'tool:message-order',        label: 'Frame Order',     resultKey: 'messageOrderResults' },
  'changes':              { tabId: 'tool:changes',              label: 'Payload Changes', resultKey: 'changesResults' },
  'checksum-discovery':   { tabId: 'tool:checksum-discovery',   label: 'Checksums',       resultKey: 'checksumDiscoveryResults' },
  'serial-framing':       { tabId: 'tool:serial-framing',       label: 'Serial Framing',  resultKey: 'serialFramingResults' },
  'serial-payload':       { tabId: 'tool:serial-payload',       label: 'Serial Payload',  resultKey: 'serialPayloadResults' },
  'modbus-register-scan': { tabId: 'tool:modbus-register-scan', label: 'Register Scan',   resultKey: 'modbusRegisterScanResults', ownsData: true, protocol: 'modbus' },
  'modbus-unit-scan':     { tabId: 'tool:modbus-unit-scan',     label: 'Unit ID Scan',    resultKey: 'modbusUnitIdScanResults',   ownsData: true, protocol: 'modbus' },
  'modbus-function-codes':{ tabId: 'tool:modbus-function-codes',label: 'Function Codes',  resultKey: 'modbusFcProbeResults',      ownsData: true, protocol: 'modbus' },
};

/** The table read the other way round. One index, so a third per-tab fact needs no fourth. */
const CONFIG_BY_TAB_ID = new Map(Object.values(TOOL_TAB_CONFIG).map((c) => [c.tabId, c]));

/** The protocol an open tool tab is showing, for a tool that speaks only one. */
export function protocolForToolTab(tabId: string): Protocol | undefined {
  return CONFIG_BY_TAB_ID.get(tabId)?.protocol;
}

/** The results a view reset discards: everything that describes frames it is dropping. */
const NO_BORROWED_RESULTS = Object.fromEntries(
  Object.values(TOOL_TAB_CONFIG).filter((c) => !c.ownsData).map((c) => [c.resultKey, null])
) as Partial<Record<ToolResultKey, null>>;

export type MessageOrderOptions = {
  startMessageId: number | null;
};

export type ChangesOptions = {
  maxExamples: number;
};

/**
 * The device the three Modbus tools point at.
 *
 * Store state rather than per-panel, like every other tool's options: the panels
 * are mounted by `activeTool` and unmounted when the dialog closes, so per-panel
 * state loses the address on every tool switch — which is exactly the
 * probe → unit scan → register sweep chain these tools are meant to support.
 */
export type ModbusTargetOptions = {
  profileId: string | null;
  connection: ModbusConnection;
};

export type ChangesResult = {
  tool: 'changes';
  frameCount: number;
  uniqueFrameIds: number;
  analysisResults: PayloadAnalysisResult[];
  mirrorGroups: MirrorGroup[];
};

export type SerialFramingResult = {
  tool: 'serial-framing';
  framingResult: FramingDetectionResult;
};

export type SerialPayloadResult = {
  tool: 'serial-payload';
  analysisResult: SerialFrameAnalysisResult;
};

export type DeviceInfo = {
  vendor?: string;
  product_code?: string;
  revision?: string;
};

/**
 * A Modbus scan's identity and progress.
 *
 * Deliberately holds no frames: a scan owns a session and writes into its
 * capture like any other source, so the results arrive through the normal frame
 * path. Duplicating them here would deliver every register twice and put them
 * beyond the reach of the analysis tools and the TOML export.
 */
export type ModbusScanResults = {
  scanType: 'register' | 'unit-id';
  isScanning: boolean;
  progress: { current: number; total: number; found_count: number; pass: number; total_passes: number } | null;
  /** Device identification info keyed by unit ID (from FC43) */
  deviceInfo: Map<number, DeviceInfo>;
  /** Diagnoses from the sweep, e.g. a function code that never answered. */
  notes: string[];
  /** The scan's own session. Kept for life: it is how the tab knows whether the
   *  frames on screen are still its own. `isScanning` is what bounds the
   *  progress subscription. */
  sessionId: string;
  /** The capture holding this scan's rows, once known — the tab's own copy of
   *  the answer, so a later sweep cannot overwrite what this one found. */
  captureId: string | null;
};

/**
 * A function-code probe's answer.
 *
 * Unlike the sweeps this owns no session and writes no capture — four requests
 * per unit produce a verdict table and nothing else — so the rows live here
 * rather than in a frame store.
 */
export type ModbusFcProbeResults = {
  isProbing: boolean;
  /** The device probed, for the tab's header. */
  deviceName: string;
  entries: FcProbeEntry[];
  /** Set instead of `entries` when the probe itself failed. */
  error: string | null;
};

type ModbusScanKey = 'modbusRegisterScanResults' | 'modbusUnitIdScanResults';

const MODBUS_SCAN_KEYS: readonly ModbusScanKey[] = [
  'modbusRegisterScanResults',
  'modbusUnitIdScanResults',
];

function resultKeyFor(scanType: 'register' | 'unit-id'): ModbusScanKey {
  return scanType === 'register' ? 'modbusRegisterScanResults' : 'modbusUnitIdScanResults';
}

/**
 * The sweep still running, if any.
 *
 * A finished scan keeps its session id — that is how its tab tells its own rows
 * from a later sweep's — so "the first slot with a session id" is not the same
 * question, and three call sites had each answered it their own way. `isScanning`
 * is the one that means "still going", and only one sweep runs at a time.
 */
export function runningModbusScan(toolbox: ToolboxState): ModbusScanResults | null {
  return MODBUS_SCAN_KEYS.map((k) => toolbox[k]).find((scan) => scan?.isScanning) ?? null;
}

export type ToolboxState = {
  isExpanded: boolean;
  activeView: ToolboxView;
  messageOrder: MessageOrderOptions;
  changes: ChangesOptions;
  checksumDiscovery: ChecksumDiscoveryOptions;
  modbusTarget: ModbusTargetOptions;
  messageOrderResults: MessageOrderResult | null;
  changesResults: ChangesResult | null;
  serialFramingResults: SerialFramingResult | null;
  serialPayloadResults: SerialPayloadResult | null;
  checksumDiscoveryResults: ChecksumDiscoveryResult | null;
  modbusRegisterScanResults: ModbusScanResults | null;
  modbusUnitIdScanResults: ModbusScanResults | null;
  modbusFcProbeResults: ModbusFcProbeResults | null;
  isRunning: boolean;
};

interface DiscoveryToolboxState {
  // Toolbox state
  toolbox: ToolboxState;

  // Decoder knowledge
  knowledge: DecoderKnowledge;
  showInfoView: boolean;

  // Actions - Toolbox
  toggleToolboxExpanded: () => void;
  setActiveView: (view: ToolboxView) => void;
  updateMessageOrderOptions: (options: Partial<MessageOrderOptions>) => void;
  updateChangesOptions: (options: Partial<ChangesOptions>) => void;
  updateChecksumDiscoveryOptions: (options: Partial<ChecksumDiscoveryOptions>) => void;
  updateModbusTarget: (options: Partial<ModbusTargetOptions>) => void;
  setIsRunning: (running: boolean) => void;
  setMessageOrderResults: (results: MessageOrderResult | null) => void;
  setChangesResults: (results: ChangesResult | null) => void;
  setSerialFramingResults: (results: SerialFramingResult | null) => void;
  setSerialPayloadResults: (results: SerialPayloadResult | null) => void;
  setChecksumDiscoveryResults: (results: ChecksumDiscoveryResult | null) => void;
  startModbusScan: (scanType: 'register' | 'unit-id', sessionId: string) => void;
  startModbusFcProbe: (deviceName: string) => void;
  finishModbusFcProbe: (outcome: { entries: FcProbeEntry[] } | { error: string }) => void;
  setModbusScanDevices: (devices: Array<{ unit_id: number; vendor?: string | null; product_code?: string | null; revision?: string | null }>) => void;
  updateModbusScanProgress: (
    progress: { current: number; total: number; found_count: number; pass: number; total_passes: number },
    notes?: string[]
  ) => void;
  finishModbusScan: (notes?: string[]) => void;
  setModbusScanCapture: (sessionId: string, captureId: string) => void;
  clearAnalysisResults: () => void;
  clearToolResult: (toolTabId: string) => void;

  // Actions - Knowledge
  openInfoView: (frameInfoMap: Map<string, FrameInfo>) => void;
  closeInfoView: () => void;
  resetKnowledge: () => void;
  updateKnowledge: (knowledge: DecoderKnowledge) => void;

  // Analysis runners - these need frame data passed in
  runMessageOrderAnalysis: (
    frames: FrameMessage[],
    frameInfoMap: Map<string, FrameInfo>
  ) => Promise<MessageOrderResult>;

  runChangesAnalysis: (
    frames: FrameMessage[],
    frameInfoMap: Map<string, FrameInfo>
  ) => Promise<ChangesResult>;

  runSerialFramingAnalysis: (
    bytesCaptureId: string,
    modbus?: ModbusRtuOptions
  ) => Promise<SerialFramingResult>;

  runSerialPayloadAnalysis: (
    frames: FrameMessage[]
  ) => Promise<SerialPayloadResult>;

  runChecksumDiscoveryAnalysis: (
    source: ChecksumScanSource
  ) => Promise<ChecksumDiscoveryResult>;
}

/**
 * Apply `fn` to whichever scan is currently running.
 *
 * Only one scan runs at a time in the UI, but which of the two result slots it
 * occupies depends on its type — so every progress update had been repeating the
 * same "check both slots, pick the scanning one, write it back" dance.
 */
function updateActiveScan(
  state: DiscoveryToolboxState,
  fn: (scan: ModbusScanResults) => ModbusScanResults
): Partial<DiscoveryToolboxState> | DiscoveryToolboxState {
  const scan = runningModbusScan(state.toolbox);
  if (!scan) return state;
  return {
    toolbox: { ...state.toolbox, [resultKeyFor(scan.scanType)]: fn(scan) },
  };
}

export const useDiscoveryToolboxStore = create<DiscoveryToolboxState>((set, get) => ({
  // Initial state
  toolbox: {
    isExpanded: false,
    activeView: 'frames',
    messageOrder: { startMessageId: null },
    changes: { maxExamples: 30 },
    checksumDiscovery: {
      minSamples: 10,
      searchCustomPolynomials: false,
      minLikeness: 50,
    },
    modbusTarget: { profileId: null, connection: MODBUS_BLANK_CONNECTION },
    messageOrderResults: null,
    changesResults: null,
    serialFramingResults: null,
    serialPayloadResults: null,
    checksumDiscoveryResults: null,
    modbusRegisterScanResults: null,
    modbusUnitIdScanResults: null,
    modbusFcProbeResults: null,
    isRunning: false,
  },
  knowledge: createEmptyKnowledge(),
  showInfoView: false,

  // Toolbox actions
  toggleToolboxExpanded: () => {
    set((state) => ({
      toolbox: { ...state.toolbox, isExpanded: !state.toolbox.isExpanded },
    }));
  },

  setActiveView: (view) => {
    set((state) => ({
      toolbox: { ...state.toolbox, activeView: view },
    }));
  },

  updateMessageOrderOptions: (options) => {
    set((state) => ({
      toolbox: { ...state.toolbox, messageOrder: { ...state.toolbox.messageOrder, ...options } },
    }));
  },

  updateChangesOptions: (options) => {
    set((state) => ({
      toolbox: { ...state.toolbox, changes: { ...state.toolbox.changes, ...options } },
    }));
  },

  updateChecksumDiscoveryOptions: (options) => {
    set((state) => ({
      toolbox: { ...state.toolbox, checksumDiscovery: { ...state.toolbox.checksumDiscovery, ...options } },
    }));
  },

  updateModbusTarget: (options) => {
    set((state) => ({
      toolbox: { ...state.toolbox, modbusTarget: { ...state.toolbox.modbusTarget, ...options } },
    }));
  },

  setIsRunning: (running) => {
    set((state) => ({
      toolbox: { ...state.toolbox, isRunning: running },
    }));
  },

  setMessageOrderResults: (results) => {
    set((state) => ({
      toolbox: { ...state.toolbox, messageOrderResults: results },
    }));
  },

  setChangesResults: (results) => {
    set((state) => ({
      toolbox: { ...state.toolbox, changesResults: results },
    }));
  },

  setSerialFramingResults: (results) => {
    set((state) => ({
      toolbox: { ...state.toolbox, serialFramingResults: results },
    }));
  },

  setSerialPayloadResults: (results) => {
    set((state) => ({
      toolbox: { ...state.toolbox, serialPayloadResults: results },
    }));
  },

  setChecksumDiscoveryResults: (results) => {
    set((state) => ({
      toolbox: { ...state.toolbox, checksumDiscoveryResults: results },
    }));
  },

  startModbusScan: (scanType, sessionId) => {
    const tabKey = scanType === 'register' ? 'modbus-register-scan' : 'modbus-unit-scan';
    set((state) => ({
      toolbox: {
        ...state.toolbox,
        [resultKeyFor(scanType)]: {
          scanType,
          isScanning: true,
          progress: null,
          deviceInfo: new Map(),
          notes: [],
          sessionId,
          captureId: null,
        },
      },
    }));
    useDiscoveryUIStore.getState().setFramesViewActiveTab(TOOL_TAB_CONFIG[tabKey].tabId);
  },

  startModbusFcProbe: (deviceName) => {
    set((state) => ({
      toolbox: {
        ...state.toolbox,
        modbusFcProbeResults: { isProbing: true, deviceName, entries: [], error: null },
      },
    }));
    useDiscoveryUIStore
      .getState()
      .setFramesViewActiveTab(TOOL_TAB_CONFIG['modbus-function-codes'].tabId);
  },

  finishModbusFcProbe: (outcome) => {
    set((state) => {
      const prev = state.toolbox.modbusFcProbeResults;
      if (!prev) return state;
      return {
        toolbox: {
          ...state.toolbox,
          modbusFcProbeResults: { ...prev, isProbing: false, entries: [], error: null, ...outcome },
        },
      };
    });
  },

  // The backend republishes its whole device list on every progress tick, so
  // replace the map in one update rather than folding in an entry at a time —
  // the latter cost a store notification and a full Map copy per device, per tick.
  setModbusScanDevices: (devices) => {
    set((state) => {
      // Device identification only comes from unit ID scans.
      const scan = state.toolbox.modbusUnitIdScanResults;
      if (!scan || devices.length === scan.deviceInfo.size) return state;
      const deviceInfo = new Map(
        devices.map((d) => [
          d.unit_id,
          {
            vendor: d.vendor ?? undefined,
            product_code: d.product_code ?? undefined,
            revision: d.revision ?? undefined,
          },
        ])
      );
      return {
        toolbox: { ...state.toolbox, modbusUnitIdScanResults: { ...scan, deviceInfo } },
      };
    });
  },

  updateModbusScanProgress: (progress, notes) => {
    set((state) =>
      updateActiveScan(state, (scan) => ({ ...scan, progress, notes: notes ?? scan.notes }))
    );
  },

  // Stamped while Discovery is joined to the sweep, which is the only moment the
  // scan's capture id is on hand — and it must outlive that join, since it is
  // what the tab reads from once a later sweep owns the frame store.
  setModbusScanCapture: (sessionId, captureId) => {
    set((state) => {
      for (const key of MODBUS_SCAN_KEYS) {
        const scan = state.toolbox[key];
        // Matched by session id, not by which sweep is running: the stamp has to
        // reach the tab that owns the capture even once it has finished.
        if (scan?.sessionId !== sessionId || scan.captureId === captureId) continue;
        return { toolbox: { ...state.toolbox, [key]: { ...scan, captureId } } };
      }
      return state;
    });
  },

  finishModbusScan: (notes) => {
    set((state) =>
      updateActiveScan(state, (scan) => ({
        ...scan,
        isScanning: false,
        notes: notes ?? scan.notes,
      }))
    );
  },

  clearAnalysisResults: () => {
    set((state) => ({ toolbox: { ...state.toolbox, ...NO_BORROWED_RESULTS } }));
  },

  clearToolResult: (toolTabId) => {
    const resultKey = CONFIG_BY_TAB_ID.get(toolTabId)?.resultKey;
    if (!resultKey) return;
    set((state) => ({ toolbox: { ...state.toolbox, [resultKey]: null } }));
  },

  // Knowledge actions
  openInfoView: (frameInfoMap) => {
    const { knowledge } = get();
    if (knowledge.frames.size === 0 && frameInfoMap.size > 0) {
      // Detect predominant protocol from frames
      let serialCount = 0;
      let canCount = 0;
      for (const info of frameInfoMap.values()) {
        if (info.protocol === 'serial') {
          serialCount++;
        } else {
          canCount++;
        }
      }
      const detectedProtocol: 'can' | 'serial' = serialCount > canCount ? 'serial' : 'can';

      const newKnowledge = createEmptyKnowledge(detectedProtocol);
      for (const [fk, info] of frameInfoMap) {
        const { frameId } = parseFrameKey(fk);
        newKnowledge.frames.set(
          frameId,
          initializeFrameKnowledge(frameId, info.len, info.isExtended, info.bus)
        );
      }
      set({ knowledge: newKnowledge, showInfoView: true });
    } else {
      set({ showInfoView: true });
    }
  },

  closeInfoView: () => set({ showInfoView: false }),

  resetKnowledge: () => set({ knowledge: createEmptyKnowledge() }),

  updateKnowledge: (knowledge) => set({ knowledge }),

  // Analysis runners
  runMessageOrderAnalysis: async (frames, frameInfoMap) => {
    const { toolbox, knowledge } = get();

    set((state) => ({ toolbox: { ...state.toolbox, isRunning: true } }));

    // Allow React to render
    await new Promise(resolve => setTimeout(resolve, ANALYSIS_YIELD_MS));

    // Lazy load analysis module
    const { analyzeMessageOrder } = await import('../utils/analysis/messageOrderAnalysis');
    const messageOrderResults = analyzeMessageOrder(frames, toolbox.messageOrder) as MessageOrderResult;

    // Update knowledge with message order analysis results
    let updatedKnowledge = knowledge;
    if (updatedKnowledge.frames.size === 0) {
      for (const [fk, info] of frameInfoMap) {
        const { frameId } = parseFrameKey(fk);
        updatedKnowledge.frames.set(
          frameId,
          initializeFrameKnowledge(frameId, info.len, info.isExtended, info.bus)
        );
      }
    }

    updatedKnowledge = updateKnowledgeFromMessageOrder(updatedKnowledge, {
      intervalGroups: messageOrderResults.intervalGroups,
      multiplexedFrames: messageOrderResults.multiplexedFrames,
      burstFrames: messageOrderResults.burstFrames,
      multiBusFrames: messageOrderResults.multiBusFrames,
    });

    set((state) => ({
      knowledge: updatedKnowledge,
      toolbox: {
        ...state.toolbox,
        isRunning: false,
        messageOrderResults,
      },
    }));

    // Switch to tool-specific tab to show results
    useDiscoveryUIStore.getState().setFramesViewActiveTab(TOOL_TAB_CONFIG['message-order'].tabId);

    return messageOrderResults;
  },

  runChangesAnalysis: async (frames, frameInfoMap) => {
    const { knowledge } = get();

    set((state) => ({ toolbox: { ...state.toolbox, isRunning: true } }));

    await new Promise(resolve => setTimeout(resolve, ANALYSIS_YIELD_MS));

    const { analyzePayloadsWithMuxDetection, detectMirrorFrames } = await import('../utils/analysis/payloadAnalysis');

    // Group frames by frame ID
    const framesByIdMap = new Map<number, number[][]>();
    const timestampedByIdMap = new Map<number, TimestampedPayload[]>();

    for (const f of frames) {
      if (!framesByIdMap.has(f.frame_id)) {
        framesByIdMap.set(f.frame_id, []);
        timestampedByIdMap.set(f.frame_id, []);
      }
      framesByIdMap.get(f.frame_id)!.push(f.bytes);
      timestampedByIdMap.get(f.frame_id)!.push({
        timestamp: f.timestamp_us,
        payload: f.bytes,
      });
    }

    // Analyze each frame ID
    const analysisResults: PayloadAnalysisResult[] = [];
    for (const [frameId, payloads] of framesByIdMap) {
      const frameKnowledge = knowledge.frames.get(frameId);
      const isBurstFrame = frameKnowledge?.isBurst ?? false;
      const result = analyzePayloadsWithMuxDetection(payloads, frameId, isBurstFrame);
      analysisResults.push(result);
    }

    const mirrorGroups = detectMirrorFrames(timestampedByIdMap);

    const changesResults: ChangesResult = {
      tool: 'changes',
      frameCount: frames.length,
      uniqueFrameIds: framesByIdMap.size,
      analysisResults,
      mirrorGroups,
    };

    // Update knowledge
    let updatedKnowledge = knowledge;
    if (updatedKnowledge.frames.size === 0) {
      for (const [fk, info] of frameInfoMap) {
        const { frameId } = parseFrameKey(fk);
        updatedKnowledge.frames.set(
          frameId,
          initializeFrameKnowledge(frameId, info.len, info.isExtended, info.bus)
        );
      }
    }

    updatedKnowledge = updateKnowledgeFromPayloadAnalysis(
      updatedKnowledge,
      analysisResults.map((r) => ({
        frameId: r.frameId,
        notes: r.notes,
        muxInfo: r.muxInfo,
        multiBytePatterns: r.multiBytePatterns,
        muxCaseAnalyses: r.muxCaseAnalyses,
        inferredEndianness: r.inferredEndianness,
      }))
    );

    set((state) => ({
      knowledge: updatedKnowledge,
      toolbox: {
        ...state.toolbox,
        isRunning: false,
        changesResults,
      },
    }));

    // Switch to tool-specific tab to show results
    useDiscoveryUIStore.getState().setFramesViewActiveTab(TOOL_TAB_CONFIG['changes'].tabId);

    return changesResults;
  },

  runSerialFramingAnalysis: async (bytesCaptureId, modbus) => {
    set((state) => ({ toolbox: { ...state.toolbox, isRunning: true } }));

    // Rust reads the bytes out of the capture store itself, so nothing is
    // copied to the frontend to be analysed.
    const framingResult = await detectSerialFraming(bytesCaptureId, modbus);
    const ranked = framingResult.candidates.map((c) => `${c.mode}=${c.confidence} (${c.estimatedFrameCount} frames)`);
    tlog.info(`[discoveryToolboxStore] Serial framing over ${framingResult.byteCount} bytes: ${ranked.join(', ')}; `
      + `unframed codes [${framingResult.unframedFunctions.map(byteToHex).join(' ')}], ${framingResult.unframedBroadcasts} broadcasts`);
    const serialFramingResults: SerialFramingResult = {
      tool: 'serial-framing',
      framingResult,
    };

    set((state) => ({
      toolbox: {
        ...state.toolbox,
        isRunning: false,
        serialFramingResults,
      },
    }));

    return serialFramingResults;
  },

  runSerialPayloadAnalysis: async (frames) => {
    set((state) => ({ toolbox: { ...state.toolbox, isRunning: true } }));

    await new Promise(resolve => setTimeout(resolve, ANALYSIS_YIELD_MS));

    const { analyzeSerialFrameStructure } = await import('../utils/analysis/serialFrameAnalysis');

    const allPayloads = frames.map(f => f.bytes);
    const analysisResult = await analyzeSerialFrameStructure(allPayloads);

    const serialPayloadResults: SerialPayloadResult = {
      tool: 'serial-payload',
      analysisResult,
    };

    set((state) => ({
      toolbox: {
        ...state.toolbox,
        isRunning: false,
        serialPayloadResults,
      },
    }));

    return serialPayloadResults;
  },

  runChecksumDiscoveryAnalysis: async (source) => {
    const { toolbox } = get();

    set((state) => ({ toolbox: { ...state.toolbox, isRunning: true } }));

    // Allow React to render
    await new Promise(resolve => setTimeout(resolve, ANALYSIS_YIELD_MS));

    // One IPC call for the whole scan — reading, grouping, sampling, sweeping
    // and solving all happen in Rust.
    const { discoverChecksums, discoverChecksumsInCapture } = await import('../api/checksums');

    const checksumDiscoveryResults =
      'captureId' in source
        ? await discoverChecksumsInCapture(
            source.captureId,
            source.selection,
            toolbox.checksumDiscovery
          )
        : await discoverChecksums(source.frames, toolbox.checksumDiscovery);

    set((state) => ({
      toolbox: {
        ...state.toolbox,
        isRunning: false,
        checksumDiscoveryResults,
      },
    }));

    // Switch to tool-specific tab to show results
    useDiscoveryUIStore.getState().setFramesViewActiveTab(TOOL_TAB_CONFIG['checksum-discovery'].tabId);

    return checksumDiscoveryResults;
  },
}));
