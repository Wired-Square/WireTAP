// ui/src/utils/decoderKnowledge.ts
// Accumulated knowledge about decoder structure from analysis tools

import type { TFunction } from 'i18next';
import type { BurstTiming } from '../generated/BurstTiming';
import type { IntervalGroup } from '../generated/IntervalGroup';
import type { MultiBusFrame } from '../generated/MultiBusFrame';
import type { MultiBytePattern } from '../generated/MultiBytePattern';
import type { MuxTiming } from '../generated/MuxTiming';
import type { ProtocolOrder } from '../generated/ProtocolOrder';
import type { ChangesFrame } from '../api/byteRoles';
import type { SerialFrameConfig } from './frameExport';
import { resolveByteIndexSync } from './analysis/checksums';
import { frameNoteLines } from './analysis/byteNoteText';

// ============================================================================
// Types for accumulated decoder knowledge
// ============================================================================

/**
 * Knowledge about a signal within a frame
 */
export type SignalKnowledge = {
  name: string;
  startBit: number;
  bitLength: number;
  source: string;       // Which tool/analysis contributed this: "mux-detection", "user", etc.
  confidence: 'low' | 'medium' | 'high';
  // Optional endianness override (when different from frame/decoder default)
  endianness?: 'little' | 'big';
  // Optional display format (e.g., "hex", "number", "ascii")
  format?: string;
};

/**
 * Knowledge about a single mux case
 */
export type MuxCaseKnowledge = {
  caseValue: number;
  signals: SignalKnowledge[];
  multiBytePatterns?: MultiBytePattern[];
};

/**
 * Knowledge about multiplexing within a frame
 */
export type MuxKnowledge = {
  selectorByte: number;       // 0 for byte[0], -1 for two-byte mux (byte[0:1])
  selectorStartBit: number;   // Start bit of mux selector
  selectorBitLength: number;  // Bit length of mux selector
  cases: number[];            // Mux case values
  caseKnowledge?: Map<number, MuxCaseKnowledge>;  // Per-case analysis data
  isTwoByte: boolean;         // True if this is a two-dimensional mux
  source: string;
};

/**
 * Knowledge about a single frame
 */
export type FrameKnowledge = {
  frameId: number;
  length: number;
  isExtended?: boolean;
  bus?: number;

  // Analysis results
  mux?: MuxKnowledge;
  signals: SignalKnowledge[];
  multiBytePatterns?: MultiBytePattern[];  // Detected multi-byte sensors/counters

  // Timing
  intervalMs?: number;

  // Flags from analysis
  isBurst?: boolean;
  burstInfo?: {
    burstCount: number;
    burstPeriodMs: number;
    interMessageMs: number;
    flags: string[];
  };

  isMultiBus?: boolean;
  multiBusInfo?: {
    buses: number[];
    countPerBus: Record<number, number>;
  };

  // Human-readable observations from analysis tools
  notes: string[];
};

/**
 * Meta knowledge about the decoder overall
 */
export type MetaKnowledge = {
  defaultInterval: number | null;  // Most common interval, or from largest group
  defaultEndianness: 'little' | 'big';
  defaultFrame: 'can' | 'serial';  // Protocol type detected from frames
};

/**
 * Complete accumulated knowledge about the decoder
 */
export type DecoderKnowledge = {
  meta: MetaKnowledge;
  frames: Map<number, FrameKnowledge>;

  // Raw analysis results for reference
  intervalGroups: IntervalGroup[];
  multiplexedFrames: MuxTiming[];
  burstFrames: BurstTiming[];
  multiBusFrames: MultiBusFrame[];

  // Tracking
  analysisRun: boolean;
  lastAnalyzed: number | null;  // timestamp
};

// ============================================================================
// Knowledge building functions
// ============================================================================

/**
 * Create empty decoder knowledge
 * @param defaultFrame - Protocol type: 'can' or 'serial' (default: 'can')
 */
export function createEmptyKnowledge(defaultFrame: 'can' | 'serial' = 'can'): DecoderKnowledge {
  return {
    meta: {
      defaultInterval: null,
      defaultEndianness: 'little',
      defaultFrame,
    },
    frames: new Map(),
    intervalGroups: [],
    multiplexedFrames: [],
    burstFrames: [],
    multiBusFrames: [],
    analysisRun: false,
    lastAnalyzed: null,
  };
}

/**
 * Initialize frame knowledge from discovered frame info
 */
export function initializeFrameKnowledge(
  frameId: number,
  length: number,
  isExtended?: boolean,
  bus?: number
): FrameKnowledge {
  return {
    frameId,
    length,
    isExtended,
    bus,
    signals: [],
    notes: [],
  };
}

/**
 * Build mux knowledge from detected multiplexed frame
 */
export function buildMuxKnowledge(mux: MuxTiming): MuxKnowledge {
  const isTwoByte = mux.selector === 'twoByte';

  return {
    selectorByte: isTwoByte ? -1 : 0,
    selectorStartBit: 0,
    selectorBitLength: isTwoByte ? 16 : 8,
    cases: Object.keys(mux.occurrences).map(Number),
    isTwoByte,
    source: 'message-order-analysis',
  };
}

/**
 * Create a default hex signal that covers unclaimed bytes
 */
export function createDefaultHexSignal(
  startByte: number,
  byteLength: number,
  name?: string
): SignalKnowledge {
  return {
    name: name ?? `data_${startByte}`,
    startBit: startByte * 8,
    bitLength: byteLength * 8,
    source: 'default',
    confidence: 'low',
    format: 'hex',
  };
}

/**
 * Calculate unclaimed bytes in a frame and create default signals for them.
 * If multi-byte patterns are provided, generates typed signals for detected patterns.
 * If serialConfig is provided, excludes bytes used for frame ID, source address, and checksum.
 */
export function createDefaultSignalsForFrame(
  frameLength: number,
  mux?: MuxKnowledge,
  existingSignals: SignalKnowledge[] = [],
  multiBytePatterns?: MultiBytePattern[],
  defaultEndianness: 'little' | 'big' = 'little',
  serialConfig?: SerialFrameConfig
): SignalKnowledge[] {
  // Track which bytes are claimed
  const claimedBytes = new Set<number>();
  const generatedSignals: SignalKnowledge[] = [];

  // Mux selector claims bytes
  if (mux) {
    if (mux.isTwoByte) {
      claimedBytes.add(0);
      claimedBytes.add(1);
    } else {
      claimedBytes.add(mux.selectorByte);
    }
  }

  // Serial config claims bytes for frame ID, source address, and checksum
  if (serialConfig) {
    // Frame ID bytes
    if (serialConfig.frame_id_start_byte !== undefined && serialConfig.frame_id_bytes !== undefined) {
      const startByte = resolveByteIndexSync(serialConfig.frame_id_start_byte, frameLength);
      for (let i = startByte; i < startByte + serialConfig.frame_id_bytes && i < frameLength; i++) {
        claimedBytes.add(i);
      }
    }

    // Source address bytes
    if (serialConfig.source_address_start_byte !== undefined && serialConfig.source_address_bytes !== undefined) {
      const startByte = resolveByteIndexSync(serialConfig.source_address_start_byte, frameLength);
      for (let i = startByte; i < startByte + serialConfig.source_address_bytes && i < frameLength; i++) {
        claimedBytes.add(i);
      }
    }

    // Checksum bytes
    if (serialConfig.checksum) {
      const startByte = resolveByteIndexSync(serialConfig.checksum.start_byte, frameLength);
      for (let i = startByte; i < startByte + serialConfig.checksum.byte_length && i < frameLength; i++) {
        claimedBytes.add(i);
      }
    }
  }

  // Existing signals claim bytes (approximate - just mark the byte range)
  for (const signal of existingSignals) {
    const startByte = Math.floor(signal.startBit / 8);
    const endByte = Math.ceil((signal.startBit + signal.bitLength) / 8);
    for (let i = startByte; i < endByte; i++) {
      claimedBytes.add(i);
    }
  }

  // Generate signals from multi-byte patterns first (sensors, counters)
  if (multiBytePatterns && multiBytePatterns.length > 0) {
    for (const pattern of multiBytePatterns) {
      // Skip if any bytes in this pattern are already claimed
      let anyByteClaimed = false;
      for (let i = pattern.start; i < pattern.start + pattern.len; i++) {
        if (claimedBytes.has(i)) {
          anyByteClaimed = true;
          break;
        }
      }
      if (anyByteClaimed) continue;

      // Generate signal name based on pattern type
      const signalName = generatePatternSignalName(pattern);
      const signal: SignalKnowledge = {
        name: signalName,
        startBit: pattern.start * 8,
        bitLength: pattern.len * 8,
        source: 'payload-analysis',
        confidence: pattern.correlatedRollover ? 'high' : 'medium',
      };

      // Add endianness if different from default
      if ((pattern.endianness === 'little' || pattern.endianness === 'big') && pattern.endianness !== defaultEndianness) {
        signal.endianness = pattern.endianness;
      }

      generatedSignals.push(signal);

      // Mark these bytes as claimed
      for (let i = pattern.start; i < pattern.start + pattern.len; i++) {
        claimedBytes.add(i);
      }
    }
  }

  // Find unclaimed byte ranges and create default hex signals
  const defaultSignals: SignalKnowledge[] = [];
  let rangeStart: number | null = null;

  for (let i = 0; i <= frameLength; i++) {
    if (i < frameLength && !claimedBytes.has(i)) {
      if (rangeStart === null) {
        rangeStart = i;
      }
    } else {
      if (rangeStart !== null) {
        const byteLength = i - rangeStart;
        defaultSignals.push(createDefaultHexSignal(rangeStart, byteLength));
        rangeStart = null;
      }
    }
  }

  // Return pattern-based signals first, then default hex signals
  return [...generatedSignals, ...defaultSignals];
}

/**
 * Generate a signal name from a multi-byte pattern
 */
function generatePatternSignalName(pattern: MultiBytePattern): string {
  const byteRange = `${pattern.start}_${pattern.start + pattern.len - 1}`;

  switch (pattern.kind) {
    case 'counter16':
      return `counter_${byteRange}`;
    case 'sensor16':
      return `sensor_${byteRange}`;
    default:
      return `data_${byteRange}`;
  }
}

/**
 * Determine the most likely default interval from interval groups
 * Picks the group with the most frames
 */
export function determineDefaultInterval(groups: IntervalGroup[]): number | null {
  if (groups.length === 0) return null;

  // Find group with most frames
  let largestGroup = groups[0];
  for (const group of groups) {
    if (group.keys.length > largestGroup.keys.length) {
      largestGroup = group;
    }
  }

  return largestGroup.intervalMs;
}

/**
 * Update decoder knowledge with message order analysis results, every protocol
 * and bus folded onto the bare frame id the knowledge is keyed by.
 */
export function updateKnowledgeFromMessageOrder(
  knowledge: DecoderKnowledge,
  orders: ProtocolOrder[]
): DecoderKnowledge {
  const newKnowledge = { ...knowledge };
  newKnowledge.frames = new Map(knowledge.frames);

  const buses = orders.flatMap((o) => o.order.buses);
  newKnowledge.intervalGroups = buses.flatMap((b) => b.intervalGroups);
  newKnowledge.multiplexedFrames = buses.flatMap((b) => b.mux);
  newKnowledge.burstFrames = buses.flatMap((b) => b.bursts);
  newKnowledge.multiBusFrames = orders.flatMap((o) => o.order.multiBus);

  const defaultInterval = determineDefaultInterval(newKnowledge.intervalGroups);
  if (defaultInterval !== null) {
    newKnowledge.meta = {
      ...newKnowledge.meta,
      defaultInterval,
    };
  }

  const update = (frameId: number, change: Partial<FrameKnowledge>) => {
    const frame = newKnowledge.frames.get(frameId);
    if (frame) newKnowledge.frames.set(frameId, { ...frame, ...change });
  };

  for (const group of newKnowledge.intervalGroups) {
    for (const key of group.keys) update(key.frameId, { intervalMs: group.intervalMs });
  }

  for (const mux of newKnowledge.multiplexedFrames) {
    update(mux.frameId, { mux: buildMuxKnowledge(mux), intervalMs: mux.muxPeriodMs ?? mux.interMessageMs });
  }

  for (const burst of newKnowledge.burstFrames) {
    update(burst.frameId, {
      isBurst: true,
      burstInfo: {
        burstCount: burst.framesPerBurst,
        burstPeriodMs: burst.burstPeriodMs,
        interMessageMs: burst.interMessageMs,
        flags: burst.flags,
      },
      intervalMs: burst.burstPeriodMs,
    });
  }

  for (const multiBus of newKnowledge.multiBusFrames) {
    update(multiBus.frameId, {
      isMultiBus: true,
      multiBusInfo: {
        buses: Object.keys(multiBus.framesPerBus).map(Number),
        countPerBus: multiBus.framesPerBus as Record<number, number>,
      },
    });
  }

  newKnowledge.analysisRun = true;
  newKnowledge.lastAnalyzed = Date.now();

  return newKnowledge;
}

/**
 * Initialize knowledge from discovered frames
 */
export function initializeKnowledgeFromFrames(
  frameInfoMap: Map<number, { len: number; isExtended?: boolean; bus?: number }>
): DecoderKnowledge {
  const knowledge = createEmptyKnowledge();

  for (const [frameId, info] of frameInfoMap) {
    knowledge.frames.set(
      frameId,
      initializeFrameKnowledge(frameId, info.len, info.isExtended, info.bus)
    );
  }

  return knowledge;
}

/**
 * Add notes to a frame's knowledge, avoiding duplicates
 */
export function addNotesToFrameKnowledge(
  knowledge: DecoderKnowledge,
  frameId: number,
  notes: string[]
): DecoderKnowledge {
  const newKnowledge = { ...knowledge };
  newKnowledge.frames = new Map(knowledge.frames);

  const frame = newKnowledge.frames.get(frameId);
  if (frame) {
    const existingNotes = new Set(frame.notes);
    for (const note of notes) {
      existingNotes.add(note);
    }
    newKnowledge.frames.set(frameId, {
      ...frame,
      notes: Array.from(existingNotes),
    });
  }

  return newKnowledge;
}

/**
 * Update knowledge from Payload Changes, its notes worded by `t`.
 */
export function updateKnowledgeFromPayloadAnalysis(
  knowledge: DecoderKnowledge,
  frames: ChangesFrame[],
  t: TFunction
): DecoderKnowledge {
  let updatedKnowledge = { ...knowledge };
  updatedKnowledge.frames = new Map(knowledge.frames);

  for (const result of frames) {
    const frame = updatedKnowledge.frames.get(result.frameId);
    if (frame) {
      const notes = frameNoteLines(t, result.notes.frame, result.mux?.detection.selector);
      const updatedFrame: FrameKnowledge = {
        ...frame,
        notes: Array.from(new Set([...frame.notes, ...notes])),
      };

      // Store mux info if detected and not already present from message-order analysis
      if (result.mux && !frame.mux) {
        const isTwoByte = result.mux.detection.selector === 'twoByte';
        updatedFrame.mux = {
          selectorByte: isTwoByte ? -1 : 0,
          selectorStartBit: 0,
          selectorBitLength: isTwoByte ? 16 : 8,
          cases: result.mux.cases.map((c) => c.value),
          isTwoByte,
          source: 'changes-analysis',
        };
      }

      // Store per-case mux analysis data (multi-byte patterns per case)
      if (result.mux && result.mux.cases.length > 0 && updatedFrame.mux) {
        const caseKnowledge = updatedFrame.mux.caseKnowledge ?? new Map<number, MuxCaseKnowledge>();

        for (const muxCase of result.mux.cases) {
          const existing = caseKnowledge.get(muxCase.value);
          const existingPatterns = existing?.multiBytePatterns ?? [];
          const existingStarts = new Set(existingPatterns.map(p => p.start));
          const newPatterns = muxCase.patterns.filter(p => !existingStarts.has(p.start));

          caseKnowledge.set(muxCase.value, {
            caseValue: muxCase.value,
            signals: existing?.signals ?? [],
            multiBytePatterns: [...existingPatterns, ...newPatterns],
          });
        }

        updatedFrame.mux = { ...updatedFrame.mux, caseKnowledge };
      }

      // A mux frame's patterns are its cases'; its top-level ones span every case.
      if (!result.mux && result.patterns.length > 0) {
        const existingPatterns = frame.multiBytePatterns ?? [];
        const existingStarts = new Set(existingPatterns.map(p => p.start));
        const newPatterns = result.patterns.filter(p => !existingStarts.has(p.start));
        updatedFrame.multiBytePatterns = [...existingPatterns, ...newPatterns];
      }

      updatedKnowledge.frames.set(result.frameId, updatedFrame);
    }
  }

  // Aggregate inferred endianness from all frames to update meta.defaultEndianness
  let littleCount = 0;
  let bigCount = 0;
  for (const result of frames) {
    if (result.endianness === 'little') littleCount++;
    else if (result.endianness === 'big') bigCount++;
    // 'mixed' doesn't contribute to either
  }

  // Only update if we have strong evidence
  if (littleCount > 0 || bigCount > 0) {
    const totalCount = littleCount + bigCount;
    // Update default endianness if at least 2/3 of frames agree
    if (littleCount >= totalCount * 0.67) {
      updatedKnowledge.meta = { ...updatedKnowledge.meta, defaultEndianness: 'little' };
    } else if (bigCount >= totalCount * 0.67) {
      updatedKnowledge.meta = { ...updatedKnowledge.meta, defaultEndianness: 'big' };
    }
    // If mixed, leave as default (little)
  }

  updatedKnowledge.analysisRun = true;
  updatedKnowledge.lastAnalyzed = Date.now();

  return updatedKnowledge;
}
