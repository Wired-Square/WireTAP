// ui/src/utils/analysis/payloadAnalysis.ts
// Payload byte pattern analysis for CAN frame discovery

import {
  detectMuxInPayloads,
  getMuxPayloadStartByte,
  formatMuxInfo,
  formatMuxValue,
} from './muxDetection';

// ============================================================================
// Types
// ============================================================================

export type ByteRole = 'static' | 'counter' | 'sensor' | 'value' | 'unknown';

export type ByteStats = {
  byteIndex: number;
  min: number;
  max: number;
  uniqueValues: Set<number>;
  role: ByteRole;
  // For counters
  isCounter?: boolean;
  counterDirection?: 'up' | 'down';
  counterStep?: number;
  rolloverDetected?: boolean;
  // For looping counters (modulo-based, e.g., 0-9 repeating)
  isLoopingCounter?: boolean;
  loopingRange?: { min: number; max: number }; // The range it loops within
  loopingModulo?: number; // Detected modulo value (e.g., 10 for 0-9)
  // For static bytes
  staticValue?: number;
  // For sensor (monotonic trending values)
  isSensor?: boolean;
  sensorTrend?: 'increasing' | 'decreasing' | 'mixed';
  trendStrength?: number; // 0-1, percentage of transitions in trend direction
};

export type MultiBytePattern = {
  startByte: number;
  length: number;
  pattern: 'counter16' | 'counter32' | 'sensor16' | 'sensor32' | 'value16' | 'value32' | 'text' | 'unknown';
  endianness?: 'little' | 'big';
  rolloverDetected?: boolean;
  // For correlated multi-byte sensors detected via rollover
  correlatedRollover?: boolean;
  // For sensor32 detected via slow-changing upper bytes
  slowUpperBytes?: boolean;
  // Value range for sensor16/sensor32 patterns
  minValue?: number;
  maxValue?: number;
  // For text patterns - sample text found
  sampleText?: string;
};

/**
 * Per-mux-case analysis result
 */
export type MuxCaseAnalysis = {
  muxValue: number;
  sampleCount: number;
  byteStats: ByteStats[];
  multiBytePatterns: MultiBytePattern[];
  notes: string[];
};

/**
 * Mux info for a frame
 */
export type MuxInfo = {
  selectorByte: number;      // 0 for byte[0], -1 for two-byte
  selectorValues: number[];  // The mux case values
  isTwoByte: boolean;
};

export type PayloadAnalysisResult = {
  frameId: number;
  sampleCount: number;
  byteStats: ByteStats[];
  multiBytePatterns: MultiBytePattern[];
  notes: string[];
  // For burst frames, we analyze only the stable part
  analyzedFromByte: number;
  analyzedToByteExclusive: number;
  isBurstFrame: boolean;
  // Mux detection results
  isMuxFrame: boolean;
  muxInfo?: MuxInfo;
  muxCaseAnalyses?: MuxCaseAnalysis[];
  // Varying length detection
  hasVaryingLength?: boolean;
  lengthRange?: { min: number; max: number };
  // Identical payload detection
  isIdentical?: boolean;
  identicalPayload?: number[]; // The constant payload bytes
  // Inferred endianness from multi-byte patterns
  inferredEndianness?: 'little' | 'big' | 'mixed';
};

// ============================================================================
// Core Analysis Functions
// ============================================================================

/**
 * Analyze byte patterns in a set of frames for a single frame ID
 * @param frames - Array of frame payloads (just the bytes arrays)
 * @param frameId - The frame ID being analyzed
 * @param payloadStartByte - Starting byte for analysis (skip mux/burst selector bytes)
 * @param isBurstFrame - Whether this is a burst frame (affects notes)
 */
export function analyzeBytePatterns(
  frames: number[][],
  frameId: number,
  payloadStartByte: number = 0,
  isBurstFrame: boolean = false
): PayloadAnalysisResult {
  if (frames.length === 0) {
    return {
      frameId,
      sampleCount: 0,
      byteStats: [],
      multiBytePatterns: [],
      notes: ['No frames to analyze'],
      analyzedFromByte: payloadStartByte,
      analyzedToByteExclusive: payloadStartByte,
      isBurstFrame,
      isMuxFrame: false,
    };
  }

  const notes: string[] = [];

  // Detect varying length
  const lengths = frames.map(f => f.length);
  const minLength = Math.min(...lengths);
  const maxLength = Math.max(...lengths);
  const hasVaryingLength = minLength !== maxLength;
  const lengthRange = hasVaryingLength ? { min: minLength, max: maxLength } : undefined;

  if (hasVaryingLength) {
    notes.push(`Varying length: ${minLength}–${maxLength} bytes`);
  }

  // Use minimum length for analysis to ensure all frames have the bytes
  const frameLength = minLength;

  if (isBurstFrame) {
    notes.push('Burst frame: analyzing stable payload portion only');
  }

  // Detect identical payloads (all frames have the same payload)
  let isIdentical = frames.length > 1;
  let identicalPayload: number[] | undefined;

  if (isIdentical) {
    const firstPayload = frames[0];
    for (let i = 1; i < frames.length && isIdentical; i++) {
      const frame = frames[i];
      if (frame.length !== firstPayload.length) {
        isIdentical = false;
        break;
      }
      for (let j = 0; j < firstPayload.length; j++) {
        if (frame[j] !== firstPayload[j]) {
          isIdentical = false;
          break;
        }
      }
    }
    if (isIdentical) {
      identicalPayload = [...firstPayload];
      const hexPayload = identicalPayload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      notes.push(`Identical payload across all ${frames.length} samples: ${hexPayload}`);
    }
  }

  // Collect statistics for each byte position
  const byteStats: ByteStats[] = [];

  for (let byteIdx = payloadStartByte; byteIdx < frameLength; byteIdx++) {
    const stats = analyzeBytePosition(frames, byteIdx);
    byteStats.push(stats);
  }

  // Detect multi-byte patterns (counters, values that span bytes)
  const multiBytePatterns = detectMultiBytePatterns(frames, byteStats);

  // Build a set of byte indices that are part of multi-byte patterns
  // These should not be reported as single-byte sensors/values
  const bytesInMultiBytePatterns = new Set<number>();
  for (const pattern of multiBytePatterns) {
    for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
      bytesInMultiBytePatterns.add(i);
    }
  }

  // Generate notes based on findings
  // Filter out bytes that are part of multi-byte patterns from single-byte reports
  const staticBytes = byteStats.filter(s => s.role === 'static');
  const counterBytes = byteStats.filter(s => s.role === 'counter' && !bytesInMultiBytePatterns.has(s.byteIndex));
  const sensorBytes = byteStats.filter(s => s.role === 'sensor' && !bytesInMultiBytePatterns.has(s.byteIndex));
  const valueBytes = byteStats.filter(s => s.role === 'value' && !bytesInMultiBytePatterns.has(s.byteIndex));

  if (staticBytes.length > 0) {
    const staticPositions = staticBytes.map(s => `byte[${s.byteIndex}]=0x${s.staticValue!.toString(16).toUpperCase().padStart(2, '0')}`);
    notes.push(`Static bytes: ${staticPositions.join(', ')}`);
  }

  if (counterBytes.length > 0) {
    for (const counter of counterBytes) {
      const direction = counter.counterDirection === 'up' ? 'incrementing' : 'decrementing';
      if (counter.isLoopingCounter && counter.loopingRange && counter.loopingModulo) {
        // Looping counter with modulo info
        notes.push(`Looping counter at byte[${counter.byteIndex}]: ${direction}, step=${counter.counterStep}, range ${counter.loopingRange.min}–${counter.loopingRange.max} (mod ${counter.loopingModulo})`);
      } else {
        const rollover = counter.rolloverDetected ? ' (rollover detected)' : '';
        notes.push(`Counter at byte[${counter.byteIndex}]: ${direction}, step=${counter.counterStep}${rollover}`);
      }
    }
  }

  if (sensorBytes.length > 0) {
    for (const sensor of sensorBytes) {
      const trend = sensor.sensorTrend === 'increasing' ? '↑' : sensor.sensorTrend === 'decreasing' ? '↓' : '↕';
      const strength = sensor.trendStrength ? ` (${Math.round(sensor.trendStrength * 100)}% trend)` : '';
      notes.push(`Sensor at byte[${sensor.byteIndex}]: ${trend} range ${sensor.min}–${sensor.max}${strength}`);
    }
  }

  for (const pattern of multiBytePatterns) {
    if (pattern.pattern === 'counter16' || pattern.pattern === 'counter32') {
      const bits = pattern.pattern === 'counter16' ? 16 : 32;
      const rollover = pattern.rolloverDetected ? ' (rollover detected)' : '';
      notes.push(`${bits}-bit counter at byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}], ${pattern.endianness} endian${rollover}`);
    } else if (pattern.pattern === 'sensor16') {
      const correlation = pattern.correlatedRollover ? ' (rollover correlation detected)' : '';
      const rangeInfo = (pattern.minValue !== undefined && pattern.maxValue !== undefined)
        ? `, range ${pattern.minValue}–${pattern.maxValue}`
        : '';
      notes.push(`16-bit sensor at byte[${pattern.startByte}:${pattern.startByte + 1}], ${pattern.endianness} endian${rangeInfo}${correlation}`);
    } else if (pattern.pattern === 'sensor32') {
      const slowUpper = pattern.slowUpperBytes ? ' (slow-changing upper bytes)' : '';
      const correlation = pattern.correlatedRollover ? ' (rollover correlation detected)' : '';
      const rangeInfo = (pattern.minValue !== undefined && pattern.maxValue !== undefined)
        ? `, range ${pattern.minValue}–${pattern.maxValue}`
        : '';
      notes.push(`32-bit sensor at byte[${pattern.startByte}:${pattern.startByte + 3}], ${pattern.endianness} endian${rangeInfo}${slowUpper}${correlation}`);
    } else if (pattern.pattern === 'text') {
      const sample = pattern.sampleText ? ` "${pattern.sampleText}"` : '';
      notes.push(`Text at byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]${sample}`);
    }
  }

  if (valueBytes.length > 0 && counterBytes.length === 0 && sensorBytes.length === 0 && multiBytePatterns.length === 0) {
    notes.push(`${valueBytes.length} byte(s) with varying values detected`);
  }

  // Infer endianness from multi-byte patterns and add to notes if detected
  const inferredEndianness = inferEndiannessFromPatterns(multiBytePatterns);
  if (inferredEndianness) {
    const endiannessLabel = inferredEndianness === 'mixed' ? 'Mixed endianness' :
      inferredEndianness === 'little' ? 'Little-endian' : 'Big-endian';
    notes.unshift(`${endiannessLabel} (inferred from ${multiBytePatterns.filter(p => p.endianness).length} multi-byte pattern(s))`);
  }

  return {
    frameId,
    sampleCount: frames.length,
    byteStats,
    multiBytePatterns,
    notes,
    analyzedFromByte: payloadStartByte,
    analyzedToByteExclusive: frameLength,
    isBurstFrame,
    isMuxFrame: false,
    hasVaryingLength,
    lengthRange,
    isIdentical,
    identicalPayload,
    inferredEndianness,
  };
}

/**
 * Analyze payloads with mux detection - groups by mux value and analyzes each case separately
 * @param payloads - Array of frame payloads (just the bytes arrays)
 * @param frameId - The frame ID being analyzed
 * @param isBurstFrame - Whether this is a burst frame (affects notes)
 */
export function analyzePayloadsWithMuxDetection(
  payloads: number[][],
  frameId: number,
  isBurstFrame: boolean = false
): PayloadAnalysisResult {
  if (payloads.length === 0) {
    return {
      frameId,
      sampleCount: 0,
      byteStats: [],
      multiBytePatterns: [],
      notes: ['No frames to analyze'],
      analyzedFromByte: 0,
      analyzedToByteExclusive: 0,
      isBurstFrame,
      isMuxFrame: false,
    };
  }

  // Detect varying length first
  const lengths = payloads.map(p => p.length);
  const minLength = Math.min(...lengths);
  const maxLength = Math.max(...lengths);
  const hasVaryingLength = minLength !== maxLength;
  const lengthRange = hasVaryingLength ? { min: minLength, max: maxLength } : undefined;

  // Detect identical payloads
  let isIdentical = payloads.length > 1;
  let identicalPayload: number[] | undefined;

  if (isIdentical) {
    const firstPayload = payloads[0];
    for (let i = 1; i < payloads.length && isIdentical; i++) {
      const payload = payloads[i];
      if (payload.length !== firstPayload.length) {
        isIdentical = false;
        break;
      }
      for (let j = 0; j < firstPayload.length; j++) {
        if (payload[j] !== firstPayload[j]) {
          isIdentical = false;
          break;
        }
      }
    }
    if (isIdentical) {
      identicalPayload = [...firstPayload];
    }
  }

  // Try to detect mux pattern
  const muxResult = detectMuxInPayloads(payloads);

  if (!muxResult) {
    // No mux detected - use standard analysis (which will also detect varying/identical)
    return analyzeBytePatterns(payloads, frameId, 0, isBurstFrame);
  }

  // Mux detected! Analyze each case separately
  const muxInfo: MuxInfo = {
    selectorByte: muxResult.selectorByte,
    selectorValues: muxResult.selectorValues,
    isTwoByte: muxResult.isTwoByte,
  };

  const startByte = getMuxPayloadStartByte(muxResult);
  const frameLength = minLength; // Use min length for safety
  const notes: string[] = [];

  if (hasVaryingLength) {
    notes.push(`Varying length: ${minLength}–${maxLength} bytes`);
  }

  if (isBurstFrame) {
    notes.push('Burst frame with mux: analyzing stable payload portion only');
  }

  if (isIdentical && identicalPayload) {
    const hexPayload = identicalPayload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    notes.push(`Identical payload across all ${payloads.length} samples: ${hexPayload}`);
  }

  notes.push(`Multiplexed frame: ${formatMuxInfo(muxResult)}`);

  // Group payloads by mux value
  const payloadsByMuxValue = new Map<number, number[][]>();
  for (const payload of payloads) {
    const muxValue = muxResult.getKey(payload);
    if (!payloadsByMuxValue.has(muxValue)) {
      payloadsByMuxValue.set(muxValue, []);
    }
    payloadsByMuxValue.get(muxValue)!.push(payload);
  }

  // Analyze each mux case
  const muxCaseAnalyses: MuxCaseAnalysis[] = [];
  const allByteStats: ByteStats[] = [];
  const allMultiBytePatterns: MultiBytePattern[] = [];

  for (const muxValue of muxResult.selectorValues) {
    const casePayloads = payloadsByMuxValue.get(muxValue) || [];
    if (casePayloads.length === 0) continue;

    // Analyze this case's payloads (skip the mux selector bytes)
    const caseByteStats: ByteStats[] = [];
    for (let byteIdx = startByte; byteIdx < frameLength; byteIdx++) {
      const stats = analyzeBytePosition(casePayloads, byteIdx);
      caseByteStats.push(stats);
    }

    const caseMultiBytePatterns = detectMultiBytePatterns(casePayloads, caseByteStats);

    // Build a set of byte indices that are part of multi-byte patterns
    const caseBytesInMultiBytePatterns = new Set<number>();
    for (const pattern of caseMultiBytePatterns) {
      for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
        caseBytesInMultiBytePatterns.add(i);
      }
    }

    // Generate notes for this case
    // Filter out bytes that are part of multi-byte patterns from single-byte reports
    const caseNotes: string[] = [];
    const staticBytes = caseByteStats.filter(s => s.role === 'static');
    const counterBytes = caseByteStats.filter(s => s.role === 'counter' && !caseBytesInMultiBytePatterns.has(s.byteIndex));
    const sensorBytes = caseByteStats.filter(s => s.role === 'sensor' && !caseBytesInMultiBytePatterns.has(s.byteIndex));

    if (staticBytes.length > 0) {
      const staticPositions = staticBytes.map(s => `byte[${s.byteIndex}]=0x${s.staticValue!.toString(16).toUpperCase().padStart(2, '0')}`);
      caseNotes.push(`Static: ${staticPositions.join(', ')}`);
    }

    if (counterBytes.length > 0) {
      for (const counter of counterBytes) {
        const direction = counter.counterDirection === 'up' ? 'inc' : 'dec';
        if (counter.isLoopingCounter && counter.loopingRange && counter.loopingModulo) {
          caseNotes.push(`Loop counter byte[${counter.byteIndex}]: ${direction}, step=${counter.counterStep}, ${counter.loopingRange.min}–${counter.loopingRange.max} (mod ${counter.loopingModulo})`);
        } else {
          const rollover = counter.rolloverDetected ? ' +rollover' : '';
          caseNotes.push(`Counter byte[${counter.byteIndex}]: ${direction}, step=${counter.counterStep}${rollover}`);
        }
      }
    }

    if (sensorBytes.length > 0) {
      for (const sensor of sensorBytes) {
        const trend = sensor.sensorTrend === 'increasing' ? '↑' : sensor.sensorTrend === 'decreasing' ? '↓' : '↕';
        caseNotes.push(`Sensor byte[${sensor.byteIndex}]: ${trend} range ${sensor.min}–${sensor.max}`);
      }
    }

    for (const pattern of caseMultiBytePatterns) {
      if (pattern.pattern === 'counter16' || pattern.pattern === 'counter32') {
        const bits = pattern.pattern === 'counter16' ? 16 : 32;
        const rollover = pattern.rolloverDetected ? ' +rollover' : '';
        caseNotes.push(`${bits}b counter byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}] ${pattern.endianness}${rollover}`);
      } else if (pattern.pattern === 'sensor16') {
        const correlation = pattern.correlatedRollover ? ' +correlated' : '';
        const rangeInfo = (pattern.minValue !== undefined && pattern.maxValue !== undefined)
          ? ` ${pattern.minValue}–${pattern.maxValue}`
          : '';
        caseNotes.push(`16b sensor byte[${pattern.startByte}:${pattern.startByte + 1}] ${pattern.endianness}${rangeInfo}${correlation}`);
      } else if (pattern.pattern === 'sensor32') {
        const slowUpper = pattern.slowUpperBytes ? ' +slow-upper' : '';
        const correlation = pattern.correlatedRollover ? ' +correlated' : '';
        const rangeInfo = (pattern.minValue !== undefined && pattern.maxValue !== undefined)
          ? ` ${pattern.minValue}–${pattern.maxValue}`
          : '';
        caseNotes.push(`32b sensor byte[${pattern.startByte}:${pattern.startByte + 3}] ${pattern.endianness}${rangeInfo}${slowUpper}${correlation}`);
      } else if (pattern.pattern === 'text') {
        const sample = pattern.sampleText ? ` "${pattern.sampleText}"` : '';
        caseNotes.push(`Text byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]${sample}`);
      }
    }

    muxCaseAnalyses.push({
      muxValue,
      sampleCount: casePayloads.length,
      byteStats: caseByteStats,
      multiBytePatterns: caseMultiBytePatterns,
      notes: caseNotes,
    });

    // Merge into overall stats (for summary)
    if (allByteStats.length === 0) {
      allByteStats.push(...caseByteStats);
    }
    allMultiBytePatterns.push(...caseMultiBytePatterns);
  }

  // Add summary note about cases
  const caseSummaries: string[] = [];
  for (const caseAnalysis of muxCaseAnalyses) {
    const valueStr = formatMuxValue(caseAnalysis.muxValue, muxResult.isTwoByte);
    const counterCount = caseAnalysis.byteStats.filter(s => s.role === 'counter').length;
    const staticCount = caseAnalysis.byteStats.filter(s => s.role === 'static').length;
    if (counterCount > 0 || staticCount > 0) {
      caseSummaries.push(`Case ${valueStr}: ${counterCount} counter, ${staticCount} static`);
    }
  }
  if (caseSummaries.length > 0 && caseSummaries.length <= 4) {
    notes.push(...caseSummaries);
  }

  // Infer endianness from all multi-byte patterns across mux cases and add to notes
  const inferredEndianness = inferEndiannessFromPatterns(allMultiBytePatterns);
  if (inferredEndianness) {
    const endiannessLabel = inferredEndianness === 'mixed' ? 'Mixed endianness' :
      inferredEndianness === 'little' ? 'Little-endian' : 'Big-endian';
    notes.unshift(`${endiannessLabel} (inferred from ${allMultiBytePatterns.filter(p => p.endianness).length} multi-byte pattern(s))`);
  }

  return {
    frameId,
    sampleCount: payloads.length,
    byteStats: allByteStats,
    multiBytePatterns: allMultiBytePatterns,
    notes,
    analyzedFromByte: startByte,
    analyzedToByteExclusive: frameLength,
    isBurstFrame,
    isMuxFrame: true,
    muxInfo,
    muxCaseAnalyses,
    hasVaryingLength,
    lengthRange,
    isIdentical,
    identicalPayload,
    inferredEndianness,
  };
}

/**
 * Analyze a single byte position across all frames
 */
function analyzeBytePosition(frames: number[][], byteIdx: number): ByteStats {
  const values: number[] = [];
  const uniqueValues = new Set<number>();

  for (const frame of frames) {
    if (byteIdx < frame.length) {
      const value = frame[byteIdx];
      values.push(value);
      uniqueValues.add(value);
    }
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  // Classify the byte role
  let role: ByteRole = 'unknown';
  let staticValue: number | undefined;
  let isCounter = false;
  let counterDirection: 'up' | 'down' | undefined;
  let counterStep: number | undefined;
  let rolloverDetected = false;
  let isLoopingCounter = false;
  let loopingRange: { min: number; max: number } | undefined;
  let loopingModulo: number | undefined;
  let isSensor = false;
  let sensorTrend: 'increasing' | 'decreasing' | 'mixed' | undefined;
  let trendStrength: number | undefined;

  if (uniqueValues.size === 1) {
    // Static byte - never changes
    role = 'static';
    staticValue = values[0];
  } else if (uniqueValues.size >= 2) {
    // First check for looping counter (small range cycling, e.g., 0-15)
    // This check comes first because looping counters have few unique values
    // and might otherwise be misclassified
    const loopingResult = detectLoopingCounter(values);
    if (loopingResult.isLoopingCounter) {
      role = 'counter';
      isCounter = true;
      isLoopingCounter = true;
      counterDirection = loopingResult.direction;
      counterStep = loopingResult.step;
      loopingRange = loopingResult.range;
      loopingModulo = loopingResult.modulo;
      rolloverDetected = true; // Looping counters always roll over
    } else if (uniqueValues.size >= 3) {
      // Check if it's a regular counter (strict: consistent step, 0-255 range)
      const counterResult = detectCounter(values);
      if (counterResult.isCounter) {
        role = 'counter';
        isCounter = true;
        counterDirection = counterResult.direction;
        counterStep = counterResult.step;
        rolloverDetected = counterResult.rolloverDetected;
      } else {
        // Check if it's a sensor (looser: trending values, variable step)
        const sensorResult = detectSensor(values);
        if (sensorResult.isSensor) {
          role = 'sensor';
          isSensor = true;
          sensorTrend = sensorResult.trend;
          trendStrength = sensorResult.trendStrength;
          rolloverDetected = sensorResult.rolloverDetected;
        } else if (uniqueValues.size >= frames.length * 0.1) {
          // If it has many unique values but isn't a counter or sensor, it's likely a value
          role = 'value';
        }
      }
    } else {
      // 2 unique values - could be a flag or slowly changing value
      role = 'value';
    }
  }

  return {
    byteIndex: byteIdx,
    min,
    max,
    uniqueValues,
    role,
    staticValue,
    isCounter,
    counterDirection,
    counterStep,
    rolloverDetected,
    isLoopingCounter,
    loopingRange,
    loopingModulo,
    isSensor,
    sensorTrend,
    trendStrength,
  };
}

/**
 * Detect if a sequence of byte values represents a counter
 */
function detectCounter(values: number[]): {
  isCounter: boolean;
  direction?: 'up' | 'down';
  step?: number;
  rolloverDetected: boolean;
} {
  if (values.length < 3) {
    return { isCounter: false, rolloverDetected: false };
  }

  // Calculate deltas between consecutive values
  const deltas: number[] = [];
  let rolloverCount = 0;

  for (let i = 1; i < values.length; i++) {
    let delta = values[i] - values[i - 1];

    // Detect rollover (wrap around at 255->0 or 0->255)
    if (delta < -200) {
      // Likely rollover from 255 to small value (incrementing counter)
      delta = values[i] + (256 - values[i - 1]);
      rolloverCount++;
    } else if (delta > 200) {
      // Likely rollover from small value to 255 (decrementing counter)
      delta = values[i] - (256 + values[i - 1]);
      rolloverCount++;
    }

    deltas.push(delta);
  }

  // A counter should have mostly consistent deltas
  const deltaCounts = new Map<number, number>();
  for (const d of deltas) {
    deltaCounts.set(d, (deltaCounts.get(d) || 0) + 1);
  }

  // Find most common delta
  let mostCommonDelta = 0;
  let mostCommonCount = 0;
  for (const [delta, count] of deltaCounts) {
    if (count > mostCommonCount) {
      mostCommonDelta = delta;
      mostCommonCount = count;
    }
  }

  // If 80%+ of deltas are the same (or close), it's likely a counter
  const consistency = mostCommonCount / deltas.length;
  if (consistency >= 0.8 && mostCommonDelta !== 0) {
    return {
      isCounter: true,
      direction: mostCommonDelta > 0 ? 'up' : 'down',
      step: Math.abs(mostCommonDelta),
      rolloverDetected: rolloverCount > 0,
    };
  }

  return { isCounter: false, rolloverDetected: false };
}

/**
 * Detect if a sequence of byte values represents a sensor (trending values with variable step).
 * Unlike counters, sensors don't require consistent step sizes - they just need to show
 * a clear trend (mostly increasing or mostly decreasing).
 *
 * Example: DA -> D9 -> D8 is detected as a decreasing sensor even with only 3 samples.
 */
function detectSensor(values: number[]): {
  isSensor: boolean;
  trend?: 'increasing' | 'decreasing' | 'mixed';
  trendStrength?: number;
  rolloverDetected: boolean;
} {
  if (values.length < 3) {
    return { isSensor: false, rolloverDetected: false };
  }

  // Count transitions: increasing, decreasing, or unchanged
  let increasing = 0;
  let decreasing = 0;
  let unchanged = 0;
  let rolloverCount = 0;

  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    let delta = curr - prev;

    // Detect potential rollover at boundaries
    if (delta < -200) {
      // Could be rollover from 255 to low value (incrementing)
      delta = curr + (256 - prev);
      rolloverCount++;
    } else if (delta > 200) {
      // Could be rollover from low value to 255 (decrementing)
      delta = curr - (256 + prev);
      rolloverCount++;
    }

    if (delta > 0) {
      increasing++;
    } else if (delta < 0) {
      decreasing++;
    } else {
      unchanged++;
    }
  }

  const totalTransitions = increasing + decreasing;
  if (totalTransitions === 0) {
    return { isSensor: false, rolloverDetected: false };
  }

  // Calculate trend strength (how much of a directional bias exists)
  const incRatio = increasing / totalTransitions;
  const decRatio = decreasing / totalTransitions;

  // A sensor should have at least 60% of transitions in one direction
  // This is looser than counter's 80% consistency requirement
  const SENSOR_THRESHOLD = 0.60;

  if (incRatio >= SENSOR_THRESHOLD) {
    return {
      isSensor: true,
      trend: 'increasing',
      trendStrength: incRatio,
      rolloverDetected: rolloverCount > 0,
    };
  } else if (decRatio >= SENSOR_THRESHOLD) {
    return {
      isSensor: true,
      trend: 'decreasing',
      trendStrength: decRatio,
      rolloverDetected: rolloverCount > 0,
    };
  }

  // If there's significant activity but no clear trend, it might still be a sensor
  // with mixed behavior (oscillating sensor). Require at least 3 unique values.
  const uniqueValues = new Set(values);
  if (uniqueValues.size >= 3 && totalTransitions >= values.length * 0.5) {
    return {
      isSensor: true,
      trend: 'mixed',
      trendStrength: Math.max(incRatio, decRatio),
      rolloverDetected: rolloverCount > 0,
    };
  }

  return { isSensor: false, rolloverDetected: false };
}

/**
 * Detect if a sequence of byte values represents a looping counter.
 * A looping counter cycles through a limited range repeatedly, like:
 * - 0, 1, 2, 3, 0, 1, 2, 3, ... (modulo 4)
 * - 0, 1, 2, ..., 9, 0, 1, 2, ... (modulo 10)
 * - 0, 1, 2, ..., 14, 0, 1, 2, ... (modulo 15, common in CAN)
 *
 * This differs from a regular counter that rolls over at 255:
 * - Looping counters have a small, consistent range (typically < 16 values)
 * - They wrap around at a specific value, not at byte boundaries
 *
 * @param values - Array of byte values in sequence order
 * @returns Detection result with looping counter details
 */
function detectLoopingCounter(values: number[]): {
  isLoopingCounter: boolean;
  direction?: 'up' | 'down';
  step?: number;
  range?: { min: number; max: number };
  modulo?: number;
} {
  if (values.length < 5) {
    return { isLoopingCounter: false };
  }

  const uniqueValues = new Set(values);
  const uniqueCount = uniqueValues.size;

  // Looping counters typically have a small, fixed set of values (2-16)
  // If there are too many unique values, it's not a looping counter
  if (uniqueCount < 2 || uniqueCount > 16) {
    return { isLoopingCounter: false };
  }

  // Get the range of values
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min + 1;

  // Check if all values in the range are present (complete cycle)
  // This is a strong indicator of a looping counter
  const hasAllValues = range === uniqueCount;

  // Calculate deltas, accounting for wrap-around
  const deltas: number[] = [];
  let wrapCount = 0;

  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    let delta = curr - prev;

    // Detect wrap-around: going from max to min (incrementing) or min to max (decrementing)
    if (prev === max && curr === min) {
      // Wrap from max to min (incrementing counter)
      delta = 1; // Treat as +1 step
      wrapCount++;
    } else if (prev === min && curr === max) {
      // Wrap from min to max (decrementing counter)
      delta = -1; // Treat as -1 step
      wrapCount++;
    }

    deltas.push(delta);
  }

  // Need at least one wrap-around to confirm it's a looping counter
  // For short sequences, we're more lenient
  const minWrapCount = values.length >= 50 ? 2 : 1;
  if (wrapCount < minWrapCount) {
    return { isLoopingCounter: false };
  }

  // Check for consistent deltas (like regular counter detection)
  const deltaCounts = new Map<number, number>();
  for (const d of deltas) {
    deltaCounts.set(d, (deltaCounts.get(d) || 0) + 1);
  }

  // Find most common delta
  let mostCommonDelta = 0;
  let mostCommonCount = 0;
  for (const [delta, count] of deltaCounts) {
    if (count > mostCommonCount) {
      mostCommonDelta = delta;
      mostCommonCount = count;
    }
  }

  // Require 80%+ consistency in deltas (same as regular counter)
  const consistency = mostCommonCount / deltas.length;
  if (consistency < 0.8 || mostCommonDelta === 0) {
    return { isLoopingCounter: false };
  }

  // Additional validation: if it's a complete range and wraps consistently, it's a looping counter
  if (hasAllValues && wrapCount >= minWrapCount) {
    return {
      isLoopingCounter: true,
      direction: mostCommonDelta > 0 ? 'up' : 'down',
      step: Math.abs(mostCommonDelta),
      range: { min, max },
      modulo: range,
    };
  }

  // Even without complete range, if we see consistent wrapping behavior, accept it
  // This handles cases where some values might be missing from the sample
  const expectedWraps = Math.floor(values.length / range);
  if (wrapCount >= expectedWraps * 0.5 && wrapCount >= minWrapCount) {
    return {
      isLoopingCounter: true,
      direction: mostCommonDelta > 0 ? 'up' : 'down',
      step: Math.abs(mostCommonDelta),
      range: { min, max },
      modulo: range,
    };
  }

  return { isLoopingCounter: false };
}

/**
 * Detect if a byte is "slow-changing" - has very few unique values relative to sample count.
 * This is used to identify upper bytes of multi-byte sensors where the high bytes
 * change very rarely (only when the lower bytes roll over).
 *
 * A byte is considered slow-changing if it has between 2-20 unique values
 * out of a large sample set (at least 1000 samples).
 *
 * @param uniqueValues - Set of unique values observed for this byte
 * @param sampleCount - Total number of samples analyzed
 * @returns true if this byte appears to be slow-changing
 */
function isSlowChangingByte(uniqueValues: Set<number>, sampleCount: number): boolean {
  // Need enough samples to make a determination
  if (sampleCount < 1000) return false;

  const uniqueCount = uniqueValues.size;

  // Must have at least 2 values (not static) but no more than 20
  // This threshold catches cases like 0x00, 0x01, 0x02 for upper bytes
  // that only increment on rollover of lower bytes
  if (uniqueCount < 2 || uniqueCount > 20) return false;

  // The ratio of unique values to samples should be very low
  // For 3M samples, 2-20 unique values gives ratio < 0.00001
  const ratio = uniqueCount / sampleCount;
  return ratio < 0.001; // Less than 0.1% unique values
}

/**
 * Detect multi-byte patterns (16-bit or 32-bit counters/values)
 */
function detectMultiBytePatterns(
  frames: number[][],
  byteStats: ByteStats[]
): MultiBytePattern[] {
  const patterns: MultiBytePattern[] = [];
  const usedBytes = new Set<number>();

  // Look for adjacent counter/value/sensor bytes that might form multi-byte values
  for (let i = 0; i < byteStats.length - 1; i++) {
    const currentByte = byteStats[i];
    const nextByte = byteStats[i + 1];

    if (usedBytes.has(currentByte.byteIndex)) continue;

    const eligibleRoles: ByteRole[] = ['counter', 'value', 'sensor', 'unknown'];

    // Check for 16-bit counter pattern
    if (
      eligibleRoles.includes(currentByte.role) &&
      eligibleRoles.includes(nextByte.role)
    ) {
      const result = check16BitCounter(frames, currentByte.byteIndex);
      if (result) {
        patterns.push(result);
        usedBytes.add(currentByte.byteIndex);
        usedBytes.add(nextByte.byteIndex);
        i++;
        continue;
      }

      // Check for correlated rollover (multi-byte sensor detection)
      const rolloverResult = checkRolloverCorrelation(frames, currentByte.byteIndex);
      if (rolloverResult) {
        patterns.push(rolloverResult);
        usedBytes.add(currentByte.byteIndex);
        usedBytes.add(nextByte.byteIndex);
        i++;
        continue;
      }

      // Check for 32-bit sensor with slow-changing upper bytes
      // This detects sensor32 where upper 2 bytes appear static/nearly-static
      // because they only change on rollover of the lower 16 bits
      const sensor32Result = checkSensor32WithSlowUpperBytes(frames, currentByte.byteIndex, byteStats);
      if (sensor32Result) {
        patterns.push(sensor32Result);
        for (let j = 0; j < 4; j++) {
          usedBytes.add(currentByte.byteIndex + j);
        }
        i += 3; // Skip the next 3 bytes (we consumed 4 total)
        continue;
      }
    }
  }

  // Check for ASCII text patterns (sequences of printable characters)
  const textPattern = detectTextPattern(frames, byteStats, usedBytes);
  if (textPattern) {
    patterns.push(textPattern);
    for (let i = textPattern.startByte; i < textPattern.startByte + textPattern.length; i++) {
      usedBytes.add(i);
    }
  }

  return patterns;
}

/**
 * Check if a byte value is printable ASCII (0x20-0x7E) or common control chars (tab, newline, carriage return)
 */
function isPrintableAscii(value: number): boolean {
  return (value >= 0x20 && value <= 0x7E) || value === 0x09 || value === 0x0A || value === 0x0D;
}

/**
 * Detect sequences of bytes that consistently contain printable ASCII characters.
 * Returns the longest text pattern found, or null if none.
 */
function detectTextPattern(
  frames: number[][],
  byteStats: ByteStats[],
  usedBytes: Set<number>
): MultiBytePattern | null {
  if (frames.length < 3) return null;

  // For each byte position, check if it's consistently printable ASCII across all frames
  const isPrintableAtPosition: boolean[] = [];

  for (const byteStat of byteStats) {
    if (usedBytes.has(byteStat.byteIndex)) {
      isPrintableAtPosition.push(false);
      continue;
    }

    // Check if this byte is printable ASCII in at least 90% of frames
    let printableCount = 0;
    for (const frame of frames) {
      if (byteStat.byteIndex < frame.length && isPrintableAscii(frame[byteStat.byteIndex])) {
        printableCount++;
      }
    }

    const printableRatio = printableCount / frames.length;
    isPrintableAtPosition.push(printableRatio >= 0.9);
  }

  // Find the longest consecutive run of printable positions (minimum 2 bytes)
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (let i = 0; i < isPrintableAtPosition.length; i++) {
    if (isPrintableAtPosition[i]) {
      if (currentStart === -1) {
        currentStart = i;
        currentLength = 1;
      } else {
        currentLength++;
      }
    } else {
      if (currentLength > bestLength && currentLength >= 2) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      currentStart = -1;
      currentLength = 0;
    }
  }

  // Check final run
  if (currentLength > bestLength && currentLength >= 2) {
    bestStart = currentStart;
    bestLength = currentLength;
  }

  if (bestLength < 2) return null;

  // Get the actual byte index from the byteStats
  const startByteIndex = byteStats[bestStart].byteIndex;

  // Extract sample text from the first frame
  let sampleText = '';
  if (frames.length > 0) {
    const firstFrame = frames[0];
    for (let i = startByteIndex; i < startByteIndex + bestLength && i < firstFrame.length; i++) {
      const byte = firstFrame[i];
      if (isPrintableAscii(byte)) {
        sampleText += String.fromCharCode(byte);
      } else {
        sampleText += '.';
      }
    }
  }

  return {
    startByte: startByteIndex,
    length: bestLength,
    pattern: 'text',
    sampleText,
  };
}

/**
 * Check if two adjacent bytes form a 16-bit counter
 */
function check16BitCounter(
  frames: number[][],
  byteIdx: number
): MultiBytePattern | null {
  if (frames.length < 3) return null;

  // Try little-endian interpretation
  const valuesLE: number[] = [];
  for (const frame of frames) {
    if (byteIdx + 1 < frame.length) {
      valuesLE.push(frame[byteIdx] | (frame[byteIdx + 1] << 8));
    }
  }

  const counterResultLE = detectCounter16(valuesLE);
  if (counterResultLE.isCounter) {
    return {
      startByte: byteIdx,
      length: 2,
      pattern: 'counter16',
      endianness: 'little',
      rolloverDetected: counterResultLE.rolloverDetected,
    };
  }

  // Try big-endian interpretation
  const valuesBE: number[] = [];
  for (const frame of frames) {
    if (byteIdx + 1 < frame.length) {
      valuesBE.push((frame[byteIdx] << 8) | frame[byteIdx + 1]);
    }
  }

  const counterResultBE = detectCounter16(valuesBE);
  if (counterResultBE.isCounter) {
    return {
      startByte: byteIdx,
      length: 2,
      pattern: 'counter16',
      endianness: 'big',
      rolloverDetected: counterResultBE.rolloverDetected,
    };
  }

  return null;
}

/**
 * Detect if a sequence of 16-bit values represents a counter
 */
function detectCounter16(values: number[]): {
  isCounter: boolean;
  rolloverDetected: boolean;
} {
  if (values.length < 3) {
    return { isCounter: false, rolloverDetected: false };
  }

  const deltas: number[] = [];
  let rolloverCount = 0;

  for (let i = 1; i < values.length; i++) {
    let delta = values[i] - values[i - 1];

    // Detect rollover for 16-bit values
    if (delta < -60000) {
      delta = values[i] + (65536 - values[i - 1]);
      rolloverCount++;
    } else if (delta > 60000) {
      delta = values[i] - (65536 + values[i - 1]);
      rolloverCount++;
    }

    deltas.push(delta);
  }

  // Check for consistent deltas
  const deltaCounts = new Map<number, number>();
  for (const d of deltas) {
    deltaCounts.set(d, (deltaCounts.get(d) || 0) + 1);
  }

  let mostCommonCount = 0;
  let mostCommonDelta = 0;
  for (const [delta, count] of deltaCounts) {
    if (count > mostCommonCount) {
      mostCommonDelta = delta;
      mostCommonCount = count;
    }
  }

  const consistency = mostCommonCount / deltas.length;
  if (consistency >= 0.8 && mostCommonDelta !== 0) {
    return { isCounter: true, rolloverDetected: rolloverCount > 0 };
  }

  return { isCounter: false, rolloverDetected: false };
}

/**
 * Detect if two adjacent bytes form a multi-byte sensor value based on rollover correlation.
 *
 * When byte N hits a boundary (00 or FF) and byte N+1 changes at the same time,
 * it suggests they are part of the same multi-byte value.
 *
 * Example: If byte[1] goes from 01 -> 00 -> FF and byte[2] increments/decrements
 * at the same transitions, they're likely a 16-bit value.
 */
function checkRolloverCorrelation(
  frames: number[][],
  byteIdx: number
): MultiBytePattern | null {
  if (frames.length < 5) return null; // Need enough samples to detect correlation

  // Track when low byte hits boundaries and whether high byte changes
  let correlatedTransitions = 0;
  let boundaryHits = 0;

  // Check little-endian first (low byte at byteIdx, high byte at byteIdx+1)
  // Also track min/max for the 16-bit value
  let minValueLE = 0xFFFF;
  let maxValueLE = 0;

  for (let i = 0; i < frames.length; i++) {
    const currFrame = frames[i];
    if (byteIdx + 1 >= currFrame.length) continue;

    // Compute 16-bit value (little-endian: low byte first)
    const value16 = currFrame[byteIdx] | (currFrame[byteIdx + 1] << 8);
    if (value16 < minValueLE) minValueLE = value16;
    if (value16 > maxValueLE) maxValueLE = value16;

    if (i === 0) continue; // Need previous frame for correlation check

    const prevFrame = frames[i - 1];
    const prevLow = prevFrame[byteIdx];
    const currLow = currFrame[byteIdx];
    const prevHigh = prevFrame[byteIdx + 1];
    const currHigh = currFrame[byteIdx + 1];

    // Check if low byte crossed a boundary
    const lowDelta = currLow - prevLow;
    const crossedBoundary =
      (prevLow >= 250 && currLow <= 5) ||   // Rolled over from high to low (incrementing)
      (prevLow <= 5 && currLow >= 250);      // Rolled over from low to high (decrementing)

    if (crossedBoundary) {
      boundaryHits++;
      // Check if high byte also changed
      if (currHigh !== prevHigh) {
        // Verify the direction makes sense
        const highDelta = currHigh - prevHigh;
        // For incrementing: low goes 255->0, high should increment
        // For decrementing: low goes 0->255, high should decrement
        const expectedHighChange = lowDelta < -200 ? 1 : (lowDelta > 200 ? -1 : 0);
        if (Math.sign(highDelta) === expectedHighChange) {
          correlatedTransitions++;
        }
      }
    }
  }

  // If we found boundary crossings and most had correlated high byte changes
  if (boundaryHits >= 1 && correlatedTransitions >= 1) {
    return {
      startByte: byteIdx,
      length: 2,
      pattern: 'sensor16',
      endianness: 'little',
      rolloverDetected: true,
      correlatedRollover: true,
      minValue: minValueLE,
      maxValue: maxValueLE,
    };
  }

  // Check big-endian (high byte at byteIdx, low byte at byteIdx+1)
  boundaryHits = 0;
  correlatedTransitions = 0;
  let minValueBE = 0xFFFF;
  let maxValueBE = 0;

  for (let i = 0; i < frames.length; i++) {
    const currFrame = frames[i];
    if (byteIdx + 1 >= currFrame.length) continue;

    // Compute 16-bit value (big-endian: high byte first)
    const value16 = (currFrame[byteIdx] << 8) | currFrame[byteIdx + 1];
    if (value16 < minValueBE) minValueBE = value16;
    if (value16 > maxValueBE) maxValueBE = value16;

    if (i === 0) continue;

    const prevFrame = frames[i - 1];
    const prevHigh = prevFrame[byteIdx];
    const currHigh = currFrame[byteIdx];
    const prevLow = prevFrame[byteIdx + 1];
    const currLow = currFrame[byteIdx + 1];

    const lowDelta = currLow - prevLow;
    const crossedBoundary =
      (prevLow >= 250 && currLow <= 5) ||
      (prevLow <= 5 && currLow >= 250);

    if (crossedBoundary) {
      boundaryHits++;
      if (currHigh !== prevHigh) {
        const highDelta = currHigh - prevHigh;
        const expectedHighChange = lowDelta < -200 ? 1 : (lowDelta > 200 ? -1 : 0);
        if (Math.sign(highDelta) === expectedHighChange) {
          correlatedTransitions++;
        }
      }
    }
  }

  if (boundaryHits >= 1 && correlatedTransitions >= 1) {
    return {
      startByte: byteIdx,
      length: 2,
      pattern: 'sensor16',
      endianness: 'big',
      rolloverDetected: true,
      correlatedRollover: true,
      minValue: minValueBE,
      maxValue: maxValueBE,
    };
  }

  return null;
}

/**
 * Detect 32-bit sensors where the upper 2 bytes are "slow-changing" (appear almost static).
 *
 * This handles the case where a sensor16 is actually the lower 16 bits of a sensor32,
 * but the upper bytes change so rarely (only on rollover of lower 16 bits) that they
 * appear static or nearly static in the analysis.
 *
 * The function checks:
 * 1. If the bytes at byteIdx and byteIdx+1 form a sensor16 pattern
 * 2. If the bytes at byteIdx+2 and byteIdx+3 are "slow-changing" (2-20 unique values)
 * 3. If the upper bytes change correlate with rollovers of the lower 16 bits
 *
 * @param frames - Array of frame payloads
 * @param byteIdx - Starting byte index to check (will check 4 bytes from here)
 * @param byteStats - Pre-computed byte statistics
 * @returns MultiBytePattern for sensor32 if detected, null otherwise
 */
function checkSensor32WithSlowUpperBytes(
  frames: number[][],
  byteIdx: number,
  byteStats: ByteStats[]
): MultiBytePattern | null {
  // Need at least 4 bytes and enough samples
  if (frames.length < 1000) return null;
  if (byteIdx + 3 >= (frames[0]?.length ?? 0)) return null;

  // Find the byte stats for bytes 2 and 3 (potential upper bytes)
  const byte2Stats = byteStats.find(s => s.byteIndex === byteIdx + 2);
  const byte3Stats = byteStats.find(s => s.byteIndex === byteIdx + 3);

  if (!byte2Stats || !byte3Stats) return null;

  // Check if upper bytes are slow-changing or static
  const byte2SlowOrStatic = byte2Stats.role === 'static' ||
    isSlowChangingByte(byte2Stats.uniqueValues, frames.length);
  const byte3SlowOrStatic = byte3Stats.role === 'static' ||
    isSlowChangingByte(byte3Stats.uniqueValues, frames.length);

  // At least one upper byte must be slow-changing (not both static)
  // If both are static, it's likely just a sensor16 + padding
  if (!byte2SlowOrStatic || !byte3SlowOrStatic) return null;
  if (byte2Stats.role === 'static' && byte3Stats.role === 'static') return null;

  // Now check if the lower 2 bytes form a sensor-like pattern
  // Try both endiannesses for the 32-bit value
  const result = checkSensor32Correlation(frames, byteIdx);
  if (result) {
    return result;
  }

  return null;
}

/**
 * Check if 4 bytes form a 32-bit sensor with correlated rollover behavior.
 * The upper 16 bits should change when the lower 16 bits roll over.
 */
function checkSensor32Correlation(
  frames: number[][],
  byteIdx: number
): MultiBytePattern | null {
  if (frames.length < 1000) return null;

  // Try little-endian first (bytes 0-1 are low word, bytes 2-3 are high word)
  let minValue32 = 0xFFFFFFFF;
  let maxValue32 = 0;
  let boundaryHits = 0;
  let correlatedTransitions = 0;

  for (let i = 0; i < frames.length; i++) {
    const currFrame = frames[i];
    if (byteIdx + 3 >= currFrame.length) continue;

    // Compute 32-bit value (little-endian)
    const low16 = currFrame[byteIdx] | (currFrame[byteIdx + 1] << 8);
    const high16 = currFrame[byteIdx + 2] | (currFrame[byteIdx + 3] << 8);
    const value32 = low16 | (high16 << 16);

    if (value32 < minValue32) minValue32 = value32;
    if (value32 > maxValue32) maxValue32 = value32;

    if (i === 0) continue;

    const prevFrame = frames[i - 1];
    const prevLow16 = prevFrame[byteIdx] | (prevFrame[byteIdx + 1] << 8);
    const prevHigh16 = prevFrame[byteIdx + 2] | (prevFrame[byteIdx + 3] << 8);

    // Check if low word crossed a boundary (rollover)
    const lowDelta = low16 - prevLow16;
    const crossedBoundary =
      (prevLow16 >= 65000 && low16 <= 500) ||   // Rolled over from high to low
      (prevLow16 <= 500 && low16 >= 65000);      // Rolled over from low to high

    if (crossedBoundary) {
      boundaryHits++;
      // Check if high word also changed
      if (high16 !== prevHigh16) {
        const highDelta = high16 - prevHigh16;
        // For incrementing: low goes 65535->0, high should increment
        // For decrementing: low goes 0->65535, high should decrement
        const expectedHighChange = lowDelta < -60000 ? 1 : (lowDelta > 60000 ? -1 : 0);
        if (Math.sign(highDelta) === expectedHighChange) {
          correlatedTransitions++;
        }
      }
    }
  }

  // Require at least 1 boundary hit with correlation to confirm sensor32
  if (boundaryHits >= 1 && correlatedTransitions >= 1) {
    return {
      startByte: byteIdx,
      length: 4,
      pattern: 'sensor32',
      endianness: 'little',
      rolloverDetected: true,
      correlatedRollover: true,
      slowUpperBytes: true,
      minValue: minValue32,
      maxValue: maxValue32,
    };
  }

  // Try big-endian (bytes 0-1 are high word, bytes 2-3 are low word)
  minValue32 = 0xFFFFFFFF;
  maxValue32 = 0;
  boundaryHits = 0;
  correlatedTransitions = 0;

  for (let i = 0; i < frames.length; i++) {
    const currFrame = frames[i];
    if (byteIdx + 3 >= currFrame.length) continue;

    // Compute 32-bit value (big-endian)
    const high16 = (currFrame[byteIdx] << 8) | currFrame[byteIdx + 1];
    const low16 = (currFrame[byteIdx + 2] << 8) | currFrame[byteIdx + 3];
    const value32 = (high16 << 16) | low16;

    if (value32 < minValue32) minValue32 = value32;
    if (value32 > maxValue32) maxValue32 = value32;

    if (i === 0) continue;

    const prevFrame = frames[i - 1];
    const prevHigh16 = (prevFrame[byteIdx] << 8) | prevFrame[byteIdx + 1];
    const prevLow16 = (prevFrame[byteIdx + 2] << 8) | prevFrame[byteIdx + 3];

    const lowDelta = low16 - prevLow16;
    const crossedBoundary =
      (prevLow16 >= 65000 && low16 <= 500) ||
      (prevLow16 <= 500 && low16 >= 65000);

    if (crossedBoundary) {
      boundaryHits++;
      if (high16 !== prevHigh16) {
        const highDelta = high16 - prevHigh16;
        const expectedHighChange = lowDelta < -60000 ? 1 : (lowDelta > 60000 ? -1 : 0);
        if (Math.sign(highDelta) === expectedHighChange) {
          correlatedTransitions++;
        }
      }
    }
  }

  if (boundaryHits >= 1 && correlatedTransitions >= 1) {
    return {
      startByte: byteIdx,
      length: 4,
      pattern: 'sensor32',
      endianness: 'big',
      rolloverDetected: true,
      correlatedRollover: true,
      slowUpperBytes: true,
      minValue: minValue32,
      maxValue: maxValue32,
    };
  }

  return null;
}

// ============================================================================
// Helper function to merge notes into existing frame knowledge
// ============================================================================

/**
 * Add notes to a frame's existing notes, avoiding duplicates
 */
export function addNotesToFrame(existingNotes: string[], newNotes: string[]): string[] {
  const noteSet = new Set(existingNotes);
  for (const note of newNotes) {
    noteSet.add(note);
  }
  return Array.from(noteSet);
}

/**
 * Infer overall endianness from detected multi-byte patterns.
 * Returns 'little', 'big', 'mixed', or undefined if no patterns found.
 */
function inferEndiannessFromPatterns(
  patterns: MultiBytePattern[]
): 'little' | 'big' | 'mixed' | undefined {
  const endianPatterns = patterns.filter(
    p => p.endianness && (p.pattern === 'counter16' || p.pattern === 'counter32' ||
      p.pattern === 'sensor16' || p.pattern === 'sensor32')
  );

  if (endianPatterns.length === 0) return undefined;

  let littleCount = 0;
  let bigCount = 0;

  for (const p of endianPatterns) {
    if (p.endianness === 'little') littleCount++;
    else if (p.endianness === 'big') bigCount++;
  }

  if (littleCount > 0 && bigCount > 0) return 'mixed';
  if (littleCount > 0) return 'little';
  if (bigCount > 0) return 'big';
  return undefined;
}

// ============================================================================
// Mirror Frame Detection
// ============================================================================

/**
 * A group of frame IDs that have identical payloads that change in unison.
 * This detects when multiple different frame IDs are transmitting the same data.
 */
export type MirrorGroup = {
  frameIds: number[];          // The frame IDs in this mirror group (sorted)
  sampleCount: number;         // Number of matching payload pairs found
  matchPercentage: number;     // What percentage of payloads matched (0-100)
  samplePayload?: number[];    // An example payload from the group
};

/**
 * Input type for mirror detection - maps frame ID to its timestamped payloads
 */
export type TimestampedPayload = {
  timestamp: number;  // Microseconds
  payload: number[];
};

/**
 * Detect mirror frames - different frame IDs that contain identical payloads
 * and change together over time.
 *
 * Algorithm:
 * 1. For each pair of frame IDs, compare their payloads at similar timestamps
 * 2. If payloads match frequently (>80% of the time), they're mirrors
 * 3. Group transitive mirrors together (if A mirrors B and B mirrors C, group all three)
 *
 * @param framePayloads - Map of frame ID to array of timestamped payloads (sorted by time)
 * @param toleranceUs - How close timestamps need to be to compare payloads (default 50ms)
 * @returns Array of mirror groups found
 */
export function detectMirrorFrames(
  framePayloads: Map<number, TimestampedPayload[]>,
  toleranceUs: number = 50000  // 50ms default
): MirrorGroup[] {
  const frameIds = Array.from(framePayloads.keys()).sort((a, b) => a - b);

  if (frameIds.length < 2) return [];

  // Track which frame ID pairs are mirrors
  // Key format: "smallerId-largerId"
  const mirrorPairs = new Map<string, { matchCount: number; totalCount: number; samplePayload?: number[] }>();

  // Compare each pair of frame IDs
  for (let i = 0; i < frameIds.length; i++) {
    for (let j = i + 1; j < frameIds.length; j++) {
      const idA = frameIds[i];
      const idB = frameIds[j];
      const payloadsA = framePayloads.get(idA)!;
      const payloadsB = framePayloads.get(idB)!;

      // Skip if either has too few samples
      if (payloadsA.length < 3 || payloadsB.length < 3) continue;

      const result = comparePayloadSequences(payloadsA, payloadsB, toleranceUs);

      if (result.matchCount > 0) {
        const pairKey = `${idA}-${idB}`;
        mirrorPairs.set(pairKey, {
          matchCount: result.matchCount,
          totalCount: result.totalCount,
          samplePayload: result.samplePayload,
        });
      }
    }
  }

  // Filter to only pairs with >80% match rate
  const confirmedMirrors = new Map<string, { matchCount: number; totalCount: number; samplePayload?: number[] }>();
  for (const [pairKey, stats] of mirrorPairs) {
    const matchPercentage = (stats.matchCount / stats.totalCount) * 100;
    if (matchPercentage >= 80) {
      confirmedMirrors.set(pairKey, stats);
    }
  }

  if (confirmedMirrors.size === 0) return [];

  // Build groups using union-find for transitive relationships
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  };
  const union = (x: number, y: number) => {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent.set(px, py);
    }
  };

  // Union all confirmed mirror pairs
  for (const pairKey of confirmedMirrors.keys()) {
    const [idA, idB] = pairKey.split('-').map(Number);
    union(idA, idB);
  }

  // Group frame IDs by their root parent
  const groups = new Map<number, number[]>();
  for (const pairKey of confirmedMirrors.keys()) {
    const [idA, idB] = pairKey.split('-').map(Number);
    const root = find(idA);  // Both have same root after union
    if (!groups.has(root)) groups.set(root, []);
    const group = groups.get(root)!;
    if (!group.includes(idA)) group.push(idA);
    if (!group.includes(idB)) group.push(idB);
  }

  // Build result with statistics
  const result: MirrorGroup[] = [];
  for (const [_root, memberIds] of groups) {
    memberIds.sort((a, b) => a - b);

    // Calculate aggregate stats from all pairs in this group
    let totalMatchCount = 0;
    let totalTotalCount = 0;
    let samplePayload: number[] | undefined;

    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        const pairKey = `${memberIds[i]}-${memberIds[j]}`;
        const stats = confirmedMirrors.get(pairKey);
        if (stats) {
          totalMatchCount += stats.matchCount;
          totalTotalCount += stats.totalCount;
          if (!samplePayload && stats.samplePayload) {
            samplePayload = stats.samplePayload;
          }
        }
      }
    }

    result.push({
      frameIds: memberIds,
      sampleCount: totalMatchCount,
      matchPercentage: totalTotalCount > 0 ? Math.round((totalMatchCount / totalTotalCount) * 100) : 0,
      samplePayload,
    });
  }

  // Sort by number of members (largest groups first)
  result.sort((a, b) => b.frameIds.length - a.frameIds.length);

  return result;
}

/**
 * Compare two payload sequences to see if they match at similar timestamps.
 * Uses a sliding window approach to find temporally close payloads.
 */
function comparePayloadSequences(
  payloadsA: TimestampedPayload[],
  payloadsB: TimestampedPayload[],
  toleranceUs: number
): { matchCount: number; totalCount: number; samplePayload?: number[] } {
  let matchCount = 0;
  let totalCount = 0;
  let samplePayload: number[] | undefined;

  // For each payload in A, find the closest payload in B within tolerance
  let bIndex = 0;
  for (const a of payloadsA) {
    // Advance bIndex to find payloads close in time
    while (bIndex < payloadsB.length && payloadsB[bIndex].timestamp < a.timestamp - toleranceUs) {
      bIndex++;
    }

    // Check payloads within the tolerance window
    for (let i = bIndex; i < payloadsB.length && payloadsB[i].timestamp <= a.timestamp + toleranceUs; i++) {
      const b = payloadsB[i];

      // Compare payloads
      totalCount++;
      if (payloadsMatch(a.payload, b.payload)) {
        matchCount++;
        if (!samplePayload) {
          samplePayload = [...a.payload];
        }
      }
    }
  }

  return { matchCount, totalCount, samplePayload };
}

/**
 * Check if two payloads are identical
 */
function payloadsMatch(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
