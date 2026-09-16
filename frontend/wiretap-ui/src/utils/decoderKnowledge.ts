// ui/src/utils/decoderKnowledge.ts
// Accumulated knowledge about decoder structure from analysis tools

import type { MultiplexedFrame, BurstFrame, MultiBusFrame, IntervalGroup } from './analysis/messageOrderAnalysis';
import type { MultiBytePattern, MuxCaseAnalysis } from './analysis/payloadAnalysis';
import type { SerialFrameConfig } from './frameExport';
import { resolveByteIndexSync } from './analysis/checksums';

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
  multiplexedFrames: MultiplexedFrame[];
  burstFrames: BurstFrame[];
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
export function buildMuxKnowledge(mux: MultiplexedFrame): MuxKnowledge {
  const isTwoByte = mux.selectorByte === -1;

  return {
    selectorByte: mux.selectorByte,
    selectorStartBit: isTwoByte ? 0 : mux.selectorByte * 8,
    selectorBitLength: isTwoByte ? 16 : 8,
    cases: mux.selectorValues,
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
      for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
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
        startBit: pattern.startByte * 8,
        bitLength: pattern.length * 8,
        source: 'payload-analysis',
        confidence: pattern.correlatedRollover ? 'high' : 'medium',
      };

      // Add endianness if different from default
      if (pattern.endianness && pattern.endianness !== defaultEndianness) {
        signal.endianness = pattern.endianness;
      }

      generatedSignals.push(signal);

      // Mark these bytes as claimed
      for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
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
  const byteRange = `${pattern.startByte}_${pattern.startByte + pattern.length - 1}`;

  switch (pattern.pattern) {
    case 'counter16':
      return `counter_${byteRange}`;
    case 'counter32':
      return `counter_${byteRange}`;
    case 'sensor16':
      return `sensor_${byteRange}`;
    case 'value16':
      return `value_${byteRange}`;
    case 'value32':
      return `value_${byteRange}`;
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
    if (group.frameIds.length > largestGroup.frameIds.length) {
      largestGroup = group;
    }
  }

  return largestGroup.intervalMs;
}

/**
 * Update decoder knowledge with message order analysis results
 */
export function updateKnowledgeFromMessageOrder(
  knowledge: DecoderKnowledge,
  results: {
    intervalGroups: IntervalGroup[];
    multiplexedFrames: MultiplexedFrame[];
    burstFrames: BurstFrame[];
    multiBusFrames: MultiBusFrame[];
  }
): DecoderKnowledge {
  const newKnowledge = { ...knowledge };
  newKnowledge.frames = new Map(knowledge.frames);

  // Store raw results
  newKnowledge.intervalGroups = results.intervalGroups;
  newKnowledge.multiplexedFrames = results.multiplexedFrames;
  newKnowledge.burstFrames = results.burstFrames;
  newKnowledge.multiBusFrames = results.multiBusFrames;

  // Update meta with default interval
  const defaultInterval = determineDefaultInterval(results.intervalGroups);
  if (defaultInterval !== null) {
    newKnowledge.meta = {
      ...newKnowledge.meta,
      defaultInterval,
    };
  }

  // Update frame intervals from interval groups
  for (const group of results.intervalGroups) {
    for (const frameId of group.frameIds) {
      let frame = newKnowledge.frames.get(frameId);
      if (frame) {
        frame = { ...frame, intervalMs: group.intervalMs };
        newKnowledge.frames.set(frameId, frame);
      }
    }
  }

  // Update frames with mux knowledge
  for (const mux of results.multiplexedFrames) {
    let frame = newKnowledge.frames.get(mux.frameId);
    if (frame) {
      frame = {
        ...frame,
        mux: buildMuxKnowledge(mux),
        intervalMs: mux.muxPeriodMs,  // Use true mux period
      };
      newKnowledge.frames.set(mux.frameId, frame);
    }
  }

  // Update frames with burst knowledge
  for (const burst of results.burstFrames) {
    let frame = newKnowledge.frames.get(burst.frameId);
    if (frame) {
      frame = {
        ...frame,
        isBurst: true,
        burstInfo: {
          burstCount: burst.burstCount,
          burstPeriodMs: burst.burstPeriodMs,
          interMessageMs: burst.interMessageMs,
          flags: burst.flags,
        },
        intervalMs: burst.burstPeriodMs,  // Use burst period as interval
      };
      newKnowledge.frames.set(burst.frameId, frame);
    }
  }

  // Update frames with multi-bus knowledge
  for (const multiBus of results.multiBusFrames) {
    let frame = newKnowledge.frames.get(multiBus.frameId);
    if (frame) {
      frame = {
        ...frame,
        isMultiBus: true,
        multiBusInfo: {
          buses: multiBus.buses,
          countPerBus: multiBus.countPerBus,
        },
      };
      newKnowledge.frames.set(multiBus.frameId, frame);
    }
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
 * Mux info from payload analysis (simplified version)
 */
type PayloadMuxInfo = {
  selectorByte: number;
  selectorValues: number[];
  isTwoByte: boolean;
};

/**
 * Update knowledge from payload analysis results (from Changes tool)
 */
export function updateKnowledgeFromPayloadAnalysis(
  knowledge: DecoderKnowledge,
  analysisResults: Array<{
    frameId: number;
    notes: string[];
    muxInfo?: PayloadMuxInfo;
    multiBytePatterns?: MultiBytePattern[];
    muxCaseAnalyses?: MuxCaseAnalysis[];
    inferredEndianness?: 'little' | 'big' | 'mixed';
  }>
): DecoderKnowledge {
  let updatedKnowledge = { ...knowledge };
  updatedKnowledge.frames = new Map(knowledge.frames);

  for (const result of analysisResults) {
    const frame = updatedKnowledge.frames.get(result.frameId);
    if (frame) {
      // Update notes
      const existingNotes = new Set(frame.notes);
      for (const note of result.notes) {
        existingNotes.add(note);
      }

      // Build updated frame
      const updatedFrame: FrameKnowledge = {
        ...frame,
        notes: Array.from(existingNotes),
      };

      // Store mux info if detected and not already present from message-order analysis
      if (result.muxInfo && !frame.mux) {
        updatedFrame.mux = {
          selectorByte: result.muxInfo.selectorByte,
          selectorStartBit: result.muxInfo.isTwoByte ? 0 : result.muxInfo.selectorByte * 8,
          selectorBitLength: result.muxInfo.isTwoByte ? 16 : 8,
          cases: result.muxInfo.selectorValues,
          isTwoByte: result.muxInfo.isTwoByte,
          source: 'changes-analysis',
        };
      }

      // Store per-case mux analysis data (multi-byte patterns per case)
      if (result.muxCaseAnalyses && result.muxCaseAnalyses.length > 0 && updatedFrame.mux) {
        const caseKnowledge = updatedFrame.mux.caseKnowledge ?? new Map<number, MuxCaseKnowledge>();

        for (const caseAnalysis of result.muxCaseAnalyses) {
          const existing = caseKnowledge.get(caseAnalysis.muxValue);
          const existingPatterns = existing?.multiBytePatterns ?? [];
          const existingStartBytes = new Set(existingPatterns.map(p => p.startByte));
          const newPatterns = (caseAnalysis.multiBytePatterns ?? []).filter(
            p => !existingStartBytes.has(p.startByte)
          );

          caseKnowledge.set(caseAnalysis.muxValue, {
            caseValue: caseAnalysis.muxValue,
            signals: existing?.signals ?? [],
            multiBytePatterns: [...existingPatterns, ...newPatterns],
          });
        }

        updatedFrame.mux = { ...updatedFrame.mux, caseKnowledge };
      }

      // Store multi-byte patterns if detected (for non-mux frames)
      if (result.multiBytePatterns && result.multiBytePatterns.length > 0) {
        // Merge with existing patterns, avoiding duplicates by startByte
        const existingPatterns = frame.multiBytePatterns ?? [];
        const existingStartBytes = new Set(existingPatterns.map(p => p.startByte));
        const newPatterns = result.multiBytePatterns.filter(p => !existingStartBytes.has(p.startByte));
        updatedFrame.multiBytePatterns = [...existingPatterns, ...newPatterns];
      }

      updatedKnowledge.frames.set(result.frameId, updatedFrame);
    }
  }

  // Aggregate inferred endianness from all frames to update meta.defaultEndianness
  let littleCount = 0;
  let bigCount = 0;
  for (const result of analysisResults) {
    if (result.inferredEndianness === 'little') littleCount++;
    else if (result.inferredEndianness === 'big') bigCount++;
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
