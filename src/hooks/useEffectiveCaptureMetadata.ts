// src/hooks/useEffectiveCaptureMetadata.ts
//
// Centralised hook for merging session capture info with local capture metadata.
// Ensures apps in the same session see the same timeline range.

import { useMemo } from "react";
import type { CaptureMetadata } from "../api/capture";

interface SessionCaptureInfo {
  /** Capture start time from session (microseconds) */
  captureStartTimeUs: number | null;
  /** Capture end time from session (microseconds) */
  captureEndTimeUs: number | null;
  /** Capture frame/byte count from session */
  captureCount: number;
  /** Capture display name from session (takes priority over local metadata) */
  captureName?: string | null;
  /** Capture persistent flag from session (takes priority over local metadata) */
  capturePersistent?: boolean;
}

/**
 * Merges session capture info with local capture metadata.
 *
 * Session values take priority for time range and count (for cross-app sync).
 * Local metadata provides additional fields like `id` and `capture_kind`.
 *
 * @param sessionCapture - Capture info from useIOSession/useIOSessionManager
 * @param localMetadata - Local CaptureMetadata (e.g., from getCaptureMetadata())
 * @returns Merged CaptureMetadata or null if no data available
 */
export function useEffectiveCaptureMetadata(
  sessionCapture: SessionCaptureInfo,
  localMetadata: CaptureMetadata | null
): CaptureMetadata | null {
  return useMemo(() => {
    // Return null if we have neither session nor local data
    if (!localMetadata && !sessionCapture.captureStartTimeUs) {
      return null;
    }

    // Need a real capture ID to be useful — without one, downstream code
    // incorrectly enters capture-first mode with an empty string ID
    const id = localMetadata?.id;
    if (!id) {
      return null;
    }

    // Merge session values with local metadata, preferring session for sync
    return {
      id,
      kind: localMetadata?.kind ?? "frames",
      name: sessionCapture.captureName ?? localMetadata?.name ?? "",
      // Prefer session values for cross-app timeline sync
      start_time_us: sessionCapture.captureStartTimeUs ?? localMetadata?.start_time_us,
      end_time_us: sessionCapture.captureEndTimeUs ?? localMetadata?.end_time_us,
      count: sessionCapture.captureCount || localMetadata?.count || 0,
      created_at: localMetadata?.created_at ?? 0,
      is_streaming: localMetadata?.is_streaming ?? false,
      owning_session_id: localMetadata?.owning_session_id ?? null,
      persistent: sessionCapture.capturePersistent ?? localMetadata?.persistent ?? false,
      buses: localMetadata?.buses ?? [],
    } as CaptureMetadata;
  }, [
    sessionCapture.captureStartTimeUs,
    sessionCapture.captureEndTimeUs,
    sessionCapture.captureCount,
    sessionCapture.captureName,
    sessionCapture.capturePersistent,
    localMetadata,
  ]);
}
