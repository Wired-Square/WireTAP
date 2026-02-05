// src/hooks/useEffectiveBufferMetadata.ts
//
// Centralised hook for merging session buffer info with local buffer metadata.
// Ensures apps in the same session see the same timeline range.

import { useMemo } from "react";
import type { BufferMetadata } from "../api/buffer";

interface SessionBufferInfo {
  /** Buffer start time from session (microseconds) */
  bufferStartTimeUs: number | null;
  /** Buffer end time from session (microseconds) */
  bufferEndTimeUs: number | null;
  /** Buffer frame/byte count from session */
  bufferCount: number;
}

/**
 * Merges session buffer info with local buffer metadata.
 *
 * Session values take priority for time range and count (for cross-app sync).
 * Local metadata provides additional fields like `id` and `buffer_type`.
 *
 * @param sessionBuffer - Buffer info from useIOSession/useIOSessionManager
 * @param localMetadata - Local BufferMetadata (e.g., from getBufferMetadata())
 * @returns Merged BufferMetadata or null if no data available
 */
export function useEffectiveBufferMetadata(
  sessionBuffer: SessionBufferInfo,
  localMetadata: BufferMetadata | null
): BufferMetadata | null {
  return useMemo(() => {
    // Return null if we have neither session nor local data
    if (!localMetadata && !sessionBuffer.bufferStartTimeUs) {
      return null;
    }

    // Merge session values with local metadata, preferring session for sync
    return {
      id: localMetadata?.id ?? "",
      buffer_type: localMetadata?.buffer_type ?? "frames",
      name: localMetadata?.name ?? "",
      // Prefer session values for cross-app timeline sync
      start_time_us: sessionBuffer.bufferStartTimeUs ?? localMetadata?.start_time_us,
      end_time_us: sessionBuffer.bufferEndTimeUs ?? localMetadata?.end_time_us,
      count: sessionBuffer.bufferCount || localMetadata?.count || 0,
      created_at: localMetadata?.created_at ?? 0,
      is_streaming: localMetadata?.is_streaming ?? false,
      owning_session_id: localMetadata?.owning_session_id ?? null,
    } as BufferMetadata;
  }, [
    sessionBuffer.bufferStartTimeUs,
    sessionBuffer.bufferEndTimeUs,
    sessionBuffer.bufferCount,
    localMetadata,
  ]);
}
