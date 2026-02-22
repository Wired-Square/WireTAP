// ui/src/hooks/useBufferSession.ts
//
// Centralized buffer session handling for all apps (Discovery, Decoder, etc.)
// Provides a simple, consistent way to switch between buffers.

import { useCallback } from "react";
import { getBufferMetadataById, type BufferMetadata } from "../api/buffer";
import { isBufferProfileId } from "./useIOSessionManager";
import { tlog } from "../api/settings";

export interface BufferSessionParams {
  // Required: buffer metadata setter
  setBufferMetadata: (meta: BufferMetadata | null) => void;

  // Required: playback state setters
  updateCurrentTime: (timeSeconds: number) => void;
  setCurrentFrameIndex: (index: number) => void;

  // Optional: additional actions to run before fetching metadata
  onBeforeSwitch?: () => void;

  // Optional: additional actions to run after metadata is loaded
  onAfterSwitch?: (meta: BufferMetadata | null) => void;
}

export interface BufferSwitchResult {
  success: boolean;
  metadata: BufferMetadata | null;
}

/**
 * Hook for centralized buffer session handling.
 * Provides a simple, consistent way to switch between buffers across all apps.
 *
 * Core functionality:
 * 1. Validates the profile ID is a buffer
 * 2. Fetches buffer metadata
 * 3. Resets playback position to start
 *
 * Apps can provide optional callbacks for additional setup/cleanup.
 */
export function useBufferSession({
  setBufferMetadata,
  updateCurrentTime,
  setCurrentFrameIndex,
  onBeforeSwitch,
  onAfterSwitch,
}: BufferSessionParams) {
  /**
   * Switch to a buffer session by ID.
   * Fetches metadata and resets playback position.
   */
  const switchToBuffer = useCallback(
    async (profileId: string): Promise<BufferSwitchResult> => {
      if (!isBufferProfileId(profileId)) {
        return { success: false, metadata: null };
      }

      tlog.debug(`[BufferSession] Switching to buffer: ${profileId}`);

      // Run optional pre-switch actions (e.g., clearing previous state)
      onBeforeSwitch?.();

      // Fetch metadata for this specific buffer
      const meta = await getBufferMetadataById(profileId);

      tlog.debug(
        `[BufferSession] Got metadata: id=${meta?.id}, count=${meta?.count}, type=${meta?.buffer_type}`
      );

      // Update buffer metadata
      setBufferMetadata(meta);

      // Reset playback position to start of buffer
      setCurrentFrameIndex(0);
      if (meta?.start_time_us != null) {
        updateCurrentTime(meta.start_time_us / 1_000_000);
      } else {
        updateCurrentTime(0);
      }

      // Run optional post-switch actions (e.g., loading frame info)
      onAfterSwitch?.(meta);

      tlog.debug(`[BufferSession] Buffer switch complete`);
      return { success: true, metadata: meta };
    },
    [setBufferMetadata, updateCurrentTime, setCurrentFrameIndex, onBeforeSwitch, onAfterSwitch]
  );

  return {
    switchToBuffer,
  };
}
