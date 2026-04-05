// ui/src/hooks/useCaptureSession.ts
//
// Centralized capture session handling for all apps (Discovery, Decoder, etc.)
// Provides a simple, consistent way to switch between captures.

import { useCallback } from "react";
import { getCaptureMetadataById, type CaptureMetadata } from "../api/capture";
import { isCaptureProfileId } from "./useIOSessionManager";
import { tlog } from "../api/settings";

export interface CaptureSessionParams {
  // Required: capture metadata setter
  setCaptureMetadata: (meta: CaptureMetadata | null) => void;

  // Required: playback state setters
  updateCurrentTime: (timeSeconds: number) => void;
  setCurrentFrameIndex: (index: number) => void;

  // Optional: additional actions to run before fetching metadata
  onBeforeSwitch?: () => void;

  // Optional: additional actions to run after metadata is loaded
  onAfterSwitch?: (meta: CaptureMetadata | null) => void;
}

export interface CaptureSwitchResult {
  success: boolean;
  metadata: CaptureMetadata | null;
}

/**
 * Hook for centralized capture session handling.
 * Provides a simple, consistent way to switch between captures across all apps.
 *
 * Core functionality:
 * 1. Validates the profile ID is a capture
 * 2. Fetches capture metadata
 * 3. Resets playback position to start
 *
 * Apps can provide optional callbacks for additional setup/cleanup.
 */
export function useCaptureSession({
  setCaptureMetadata,
  updateCurrentTime,
  setCurrentFrameIndex,
  onBeforeSwitch,
  onAfterSwitch,
}: CaptureSessionParams) {
  /**
   * Switch to a capture session by ID.
   * Fetches metadata and resets playback position.
   */
  const switchToCapture = useCallback(
    async (profileId: string): Promise<CaptureSwitchResult> => {
      if (!isCaptureProfileId(profileId)) {
        return { success: false, metadata: null };
      }

      tlog.debug(`[CaptureSession] Switching to capture: ${profileId}`);

      // Run optional pre-switch actions (e.g., clearing previous state)
      onBeforeSwitch?.();

      // Fetch metadata for this specific capture
      const meta = await getCaptureMetadataById(profileId);

      tlog.debug(
        `[CaptureSession] Got metadata: id=${meta?.id}, count=${meta?.count}, kind=${meta?.kind}`
      );

      // Update capture metadata
      setCaptureMetadata(meta);

      // Reset playback position to start of capture
      setCurrentFrameIndex(0);
      if (meta?.start_time_us != null) {
        updateCurrentTime(meta.start_time_us / 1_000_000);
      } else {
        updateCurrentTime(0);
      }

      // Run optional post-switch actions (e.g., loading frame info)
      onAfterSwitch?.(meta);

      tlog.debug(`[CaptureSession] Capture switch complete`);
      return { success: true, metadata: meta };
    },
    [setCaptureMetadata, updateCurrentTime, setCurrentFrameIndex, onBeforeSwitch, onAfterSwitch]
  );

  return {
    switchToCapture,
  };
}
