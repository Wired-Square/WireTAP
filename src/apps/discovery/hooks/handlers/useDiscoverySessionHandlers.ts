// ui/src/apps/discovery/hooks/handlers/useDiscoverySessionHandlers.ts
//
// Session-related handlers for Discovery: IO profile change and buffer switching.
// Delegates session orchestration to useIOSessionManager methods; only adds Discovery-specific logic
// (buffer cleanup).
// Note: Dialog handlers (start/stop load, join, skip) are centralised in useIOSourcePickerHandlers.
// Note: Playback handlers (play/pause/stop/step) are in useDiscoveryPlaybackHandlers.

import { useCallback } from "react";
import { getCaptureFrameInfo, setActiveCapture, type CaptureMetadata } from "../../../../api/capture";
import { isCaptureProfileId, type LoadOptions } from "../../../../hooks/useIOSessionManager";
import { useCaptureSession } from "../../../../hooks/useCaptureSession";

export interface UseDiscoverySessionHandlersParams {
  // Session actions
  selectProfile: (profileId: string | null) => void;
  watchSource: (profileIds: string[], options: LoadOptions) => Promise<void>;

  // Store actions
  updateCurrentTime?: (timeSeconds: number) => void;
  setCurrentFrameIndex?: (index: number) => void;
  setMaxBuffer?: (count: number) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAnalysisResults: () => void;
  enableBufferMode: (count: number) => void;
  disableBufferMode: () => void;
  setFrameInfoFromBuffer: (frameInfo: any[]) => void;
  clearSerialBytes: (preserveCount?: boolean) => void;
  resetFraming: () => void;
  setBackendByteCount: (count: number) => void;
  addSerialBytes: (entries: { byte: number; timestampUs: number }[]) => void;

  // Buffer state
  setCaptureMetadata: (meta: CaptureMetadata | null) => void;
}

export function useDiscoverySessionHandlers({
  selectProfile,
  watchSource,
  updateCurrentTime,
  setCurrentFrameIndex,
  setMaxBuffer,
  clearBuffer,
  clearFramePicker,
  clearAnalysisResults,
  enableBufferMode,
  disableBufferMode,
  setFrameInfoFromBuffer,
  clearSerialBytes,
  resetFraming,
  setBackendByteCount,
  addSerialBytes: _addSerialBytes,
  setCaptureMetadata,
}: UseDiscoverySessionHandlersParams) {
  void _addSerialBytes; // Reserved for future bytes mode support

  // Centralized buffer session handler with Discovery-specific callbacks
  const { switchToCapture } = useCaptureSession({
    setCaptureMetadata,
    updateCurrentTime: updateCurrentTime ?? (() => {}),
    setCurrentFrameIndex: setCurrentFrameIndex ?? (() => {}),
    // Clear previous state before switching
    onBeforeSwitch: () => {
      clearBuffer();
      clearFramePicker();
      clearAnalysisResults();
      disableBufferMode();
      clearSerialBytes();
      resetFraming();
      setBackendByteCount(0);
    },
    // Load frame info after metadata is loaded
    onAfterSwitch: async (meta) => {
      if (!meta || meta.count === 0) return;

      const isFramesMode = meta.kind === "frames";
      const isBytesMode = meta.kind === "bytes";

      if (isBytesMode) {
        // Bytes mode is handled elsewhere for Discovery
        return;
      }

      if (isFramesMode) {
        // Set active buffer so getCaptureFrameInfo reads from the correct buffer
        await setActiveCapture(meta.id);
        enableBufferMode(meta.count);
        setMaxBuffer?.(meta.count);
        try {
          const frameInfoList = await getCaptureFrameInfo(meta.id);
          setFrameInfoFromBuffer(frameInfoList);
        } catch (e) {
          console.error("[DiscoverySessionHandlers] Failed to load frame info:", e);
        }
      }
    },
  });

  // Handle IO profile change - manager handles common logic, app handles buffer/non-buffer cleanup
  const handleIoProfileChange = useCallback(async (profileId: string | null) => {
    console.log(`[DiscoverySessionHandlers] handleIoProfileChange called - profileId=${profileId}`);

    // Check if switching to a buffer session
    if (isCaptureProfileId(profileId)) {
      // Create a proper session for the capture so it appears in the session manager
      // and has playback controls. watchSource calls onBeforeWatch (clears state),
      // creates a CaptureSource session, and sets sourceProfileId to the capture ID.
      await watchSource([profileId!], { speed: 1 });
      // Load capture metadata and enable capture UI (frame picker, pagination)
      await switchToCapture(profileId!);
    } else {
      // Manager handles: clear multi-bus, set profile, default speed
      selectProfile(profileId);
      // Clear state when switching to non-buffer profile
      clearAnalysisResults();
      clearBuffer();
      clearFramePicker();
      disableBufferMode();
      clearSerialBytes();
      resetFraming();
      setBackendByteCount(0);
    }
  }, [
    selectProfile,
    watchSource,
    switchToCapture,
    clearAnalysisResults,
    clearBuffer,
    clearFramePicker,
    disableBufferMode,
    clearSerialBytes,
    resetFraming,
    setBackendByteCount,
  ]);

  // Note: Dialog handlers (start/stop load, join, skip, multi-select) are now provided
  // by the centralised useIOSourcePickerHandlers hook in Discovery.tsx.
  // Note: Playback handlers (play/pause/stop/step) are in useDiscoveryPlaybackHandlers.

  return {
    handleIoProfileChange,
  };
}

export type DiscoverySessionHandlers = ReturnType<typeof useDiscoverySessionHandlers>;
