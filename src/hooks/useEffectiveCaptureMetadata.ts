// src/hooks/useEffectiveBufferMetadata.ts
//
// Centralised hook for merging session buffer info with local buffer metadata.
// Ensures apps in the same session see the same timeline range.

import { useMemo } from "react";
import type { CaptureMetadata } from "../api/capture";

interface SessionBufferInfo {
  /** Buffer start time from session (microseconds) */
  captureStartTimeUs: number | null;
  /** Buffer end time from session (microseconds) */
  captureEndTimeUs: number | null;
  /** Buffer frame/byte count from session */
  captureCount: number;
  /** Buffer display name from session (takes priority over local metadata) */
  captureName?: string | null;
  /** Buffer persistent flag from session (takes priority over local metadata) */
  capturePersistent?: boolean;
}

/**
 * Merges session buffer info with local buffer metadata.
 *
 * Session values take priority for time range and count (for cross-app sync).
 * Local metadata provides additional fields like `id` and `buffer_type`.
 *
 * @param sessionBuffer - Buffer info from useIOSession/useIOSessionManager
 * @param localMetadata - Local CaptureMetadata (e.g., from getCaptureMetadata())
 * @returns Merged CaptureMetadata or null if no data available
 */
export function useEffectiveBufferMetadata(
  sessionBuffer: SessionBufferInfo,
  localMetadata: CaptureMetadata | null
): CaptureMetadata | null {
  return useMemo(() => {
    // Return null if we have neither session nor local data
    if (!localMetadata && !sessionBuffer.captureStartTimeUs) {
      return null;
    }

    // Need a real buffer ID to be useful — without one, downstream code
    // incorrectly enters buffer-first mode with an empty string ID
    const id = localMetadata?.id;
    if (!id) {
      return null;
    }

    // Merge session values with local metadata, preferring session for sync
    return {
      id,
      kind: localMetadata?.kind ?? "frames",
      name: sessionBuffer.captureName ?? localMetadata?.name ?? "",
      // Prefer session values for cross-app timeline sync
      start_time_us: sessionBuffer.captureStartTimeUs ?? localMetadata?.start_time_us,
      end_time_us: sessionBuffer.captureEndTimeUs ?? localMetadata?.end_time_us,
      count: sessionBuffer.captureCount || localMetadata?.count || 0,
      created_at: localMetadata?.created_at ?? 0,
      is_streaming: localMetadata?.is_streaming ?? false,
      owning_session_id: localMetadata?.owning_session_id ?? null,
      persistent: sessionBuffer.capturePersistent ?? localMetadata?.persistent ?? false,
      buses: localMetadata?.buses ?? [],
    } as CaptureMetadata;
  }, [
    sessionBuffer.captureStartTimeUs,
    sessionBuffer.captureEndTimeUs,
    sessionBuffer.captureCount,
    sessionBuffer.captureName,
    sessionBuffer.capturePersistent,
    localMetadata,
  ]);
}
