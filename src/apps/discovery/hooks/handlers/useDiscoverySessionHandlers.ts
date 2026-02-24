// ui/src/apps/discovery/hooks/handlers/useDiscoverySessionHandlers.ts
//
// Session-related handlers for Discovery: IO profile change and buffer switching.
// Delegates session orchestration to useIOSessionManager methods; only adds Discovery-specific logic
// (buffer cleanup).
// Note: Dialog handlers (start/stop ingest, join, skip) are centralised in useIOPickerHandlers.
// Note: Playback handlers (play/pause/stop/step) are in useDiscoveryPlaybackHandlers.

import { useCallback } from "react";
import { getBufferFrameInfo, setActiveBuffer, type BufferMetadata } from "../../../../api/buffer";
import { isBufferProfileId, type IngestOptions } from "../../../../hooks/useIOSessionManager";
import { useBufferSession } from "../../../../hooks/useBufferSession";

export interface UseDiscoverySessionHandlersParams {
  // Session actions
  selectProfile: (profileId: string | null) => void;
  watchSingleSource: (profileId: string, options: IngestOptions) => Promise<void>;

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
  setBufferMetadata: (meta: BufferMetadata | null) => void;
}

export function useDiscoverySessionHandlers({
  selectProfile,
  watchSingleSource,
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
  setBufferMetadata,
}: UseDiscoverySessionHandlersParams) {
  void _addSerialBytes; // Reserved for future bytes mode support

  // Centralized buffer session handler with Discovery-specific callbacks
  const { switchToBuffer } = useBufferSession({
    setBufferMetadata,
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

      const isFramesMode = meta.buffer_type === "frames";
      const isBytesMode = meta.buffer_type === "bytes";

      if (isBytesMode) {
        // Bytes mode is handled elsewhere for Discovery
        return;
      }

      if (isFramesMode) {
        // Set active buffer so getBufferFrameInfo reads from the correct buffer
        await setActiveBuffer(meta.id);
        enableBufferMode(meta.count);
        setMaxBuffer?.(meta.count);
        try {
          const frameInfoList = await getBufferFrameInfo();
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

    // Check if switching to a buffer session (buf_1, buf_2, etc. or legacy __imported_buffer__)
    if (isBufferProfileId(profileId)) {
      // Create a proper session for the buffer so it appears in the session manager
      // and has playback/timeline controls. watchSingleSource calls onBeforeWatch (clears state),
      // creates a BufferReader session, and sets sourceProfileId to the buffer ID.
      await watchSingleSource(profileId!, { speed: 1 });
      // Load buffer metadata and enable buffer UI (frame picker, pagination)
      await switchToBuffer(profileId!);
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
    watchSingleSource,
    switchToBuffer,
    clearAnalysisResults,
    clearBuffer,
    clearFramePicker,
    disableBufferMode,
    clearSerialBytes,
    resetFraming,
    setBackendByteCount,
  ]);

  // Note: Dialog handlers (start/stop ingest, join, skip, multi-select) are now provided
  // by the centralised useIOPickerHandlers hook in Discovery.tsx.
  // Note: Playback handlers (play/pause/stop/step) are in useDiscoveryPlaybackHandlers.

  return {
    handleIoProfileChange,
  };
}

export type DiscoverySessionHandlers = ReturnType<typeof useDiscoverySessionHandlers>;
