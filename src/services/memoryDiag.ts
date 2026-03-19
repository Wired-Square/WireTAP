// Memory diagnostic counters — query from browser console via window.__memDiag
// Shows bytes flowing through each stage of the frame pipeline to find the amplification point.

interface StageCounts {
  calls: number;
  totalBytes: number;
  lastResetAt: number;
}

const stages: Record<string, StageCounts> = {};

function getStage(name: string): StageCounts {
  if (!stages[name]) {
    stages[name] = { calls: 0, totalBytes: 0, lastResetAt: Date.now() };
  }
  return stages[name];
}

export function trackAlloc(stage: string, bytes: number): void {
  const s = getStage(stage);
  s.calls++;
  s.totalBytes += bytes;
}

export function report(): Record<string, { calls: number; totalBytes: number; bytesPerSec: number; callsPerSec: number }> {
  const now = Date.now();
  const result: Record<string, { calls: number; totalBytes: number; bytesPerSec: number; callsPerSec: number }> = {};
  for (const [name, s] of Object.entries(stages)) {
    const elapsed = (now - s.lastResetAt) / 1000;
    result[name] = {
      calls: s.calls,
      totalBytes: s.totalBytes,
      bytesPerSec: elapsed > 0 ? Math.round(s.totalBytes / elapsed) : 0,
      callsPerSec: elapsed > 0 ? Math.round((s.calls / elapsed) * 10) / 10 : 0,
    };
  }
  return result;
}

export function reset(): void {
  for (const s of Object.values(stages)) {
    s.calls = 0;
    s.totalBytes = 0;
    s.lastResetAt = Date.now();
  }
}

// Expose on window for console access
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__memDiag = { report, reset, stages };
}
