// src/hooks/useIngestSession.ts
//
// Shared hook for ingest session management.
// Handles event listener setup/cleanup, session lifecycle, and error handling.
// Apps provide their own completion handler for app-specific logic.

import { useCallback, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  createIOSession,
  startReaderSession,
  stopReaderSession,
  destroyReaderSession,
  updateReaderSpeed,
  type StreamEndedPayload,
} from "../api/io";
import { INGEST_SESSION_ID } from "../dialogs/io-reader-picker/utils";

// Re-export for convenience
export { INGEST_SESSION_ID };
export type { StreamEndedPayload };

export interface IngestSessionOptions {
  profileId: string;
  speed?: number;
  startTime?: string;
  endTime?: string;
  maxFrames?: number;
  frameIdStartByte?: number;
  frameIdBytes?: number;
  sourceAddressStartByte?: number;
  sourceAddressBytes?: number;
  sourceAddressBigEndian?: boolean;
  minFrameLength?: number;
}

export interface UseIngestSessionOptions {
  /** Called when ingest completes (stream ends) */
  onComplete: (payload: StreamEndedPayload) => Promise<void>;
  /** Called before session is started (optional - for pre-start cleanup like clearing buffers) */
  onBeforeStart?: () => Promise<void>;
}

export interface UseIngestSessionResult {
  /** Whether an ingest is currently in progress */
  isIngesting: boolean;
  /** Profile ID being ingested (null if not ingesting) */
  ingestProfileId: string | null;
  /** Number of frames ingested so far */
  ingestFrameCount: number;
  /** Error message if ingest failed */
  ingestError: string | null;
  /** Start ingesting from a profile */
  startIngest: (options: IngestSessionOptions) => Promise<void>;
  /** Stop the current ingest */
  stopIngest: () => Promise<void>;
  /** Clear the error state */
  clearIngestError: () => void;
}

export function useIngestSession({
  onComplete,
  onBeforeStart,
}: UseIngestSessionOptions): UseIngestSessionResult {
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestProfileId, setIngestProfileId] = useState<string | null>(null);
  const [ingestFrameCount, setIngestFrameCount] = useState(0);
  const [ingestError, setIngestError] = useState<string | null>(null);

  // Store unlisten functions for cleanup
  const unlistenRefs = useRef<Array<() => void>>([]);

  // Cleanup helper
  const cleanupListeners = useCallback(() => {
    unlistenRefs.current.forEach((unlisten) => unlisten());
    unlistenRefs.current = [];
  }, []);

  // Handle ingest completion
  const handleComplete = useCallback(
    async (payload: StreamEndedPayload) => {
      setIsIngesting(false);
      setIngestProfileId(null);

      // Cleanup listeners
      cleanupListeners();

      // Destroy the ingest session
      try {
        await destroyReaderSession(INGEST_SESSION_ID);
      } catch (e) {
        console.error("Failed to destroy ingest session:", e);
      }

      // Call app-specific completion handler
      await onComplete(payload);
    },
    [cleanupListeners, onComplete]
  );

  // Start ingesting
  const startIngest = useCallback(
    async (options: IngestSessionOptions) => {
      setIngestError(null);
      setIngestFrameCount(0);

      try {
        // Call pre-start hook if provided (e.g., clear buffer)
        if (onBeforeStart) {
          await onBeforeStart();
        }

        // Set up event listeners for the ingest session
        const unlistenStreamEnded = await listen<StreamEndedPayload>(
          `stream-ended:${INGEST_SESSION_ID}`,
          (event) => handleComplete(event.payload)
        );
        const unlistenError = await listen<string>(
          `session-error:${INGEST_SESSION_ID}`,
          (event) => {
            setIngestError(event.payload);
          }
        );
        const unlistenFrames = await listen<{ frames: unknown[] } | unknown[]>(
          `frame-message:${INGEST_SESSION_ID}`,
          (event) => {
            // Handle both legacy array format and new FrameBatchPayload format
            const frames = Array.isArray(event.payload) ? event.payload : event.payload.frames;
            setIngestFrameCount((prev) => prev + frames.length);
          }
        );

        unlistenRefs.current = [
          unlistenStreamEnded,
          unlistenError,
          unlistenFrames,
        ];

        // Create the reader session
        await createIOSession({
          sessionId: INGEST_SESSION_ID,
          profileId: options.profileId,
          speed: options.speed ?? 0, // Default to max speed
          startTime: options.startTime,
          endTime: options.endTime,
          limit: options.maxFrames,
          frameIdStartByte: options.frameIdStartByte,
          frameIdBytes: options.frameIdBytes,
          sourceAddressStartByte: options.sourceAddressStartByte,
          sourceAddressBytes: options.sourceAddressBytes,
          sourceAddressBigEndian: options.sourceAddressBigEndian,
          minFrameLength: options.minFrameLength,
        });

        // Apply speed setting if non-zero
        if (options.speed && options.speed > 0) {
          await updateReaderSpeed(INGEST_SESSION_ID, options.speed);
        }

        // Start the session
        await startReaderSession(INGEST_SESSION_ID);

        setIsIngesting(true);
        setIngestProfileId(options.profileId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setIngestError(msg);
        // Cleanup on error
        cleanupListeners();
      }
    },
    [handleComplete, onBeforeStart, cleanupListeners]
  );

  // Stop ingesting
  const stopIngest = useCallback(async () => {
    try {
      await stopReaderSession(INGEST_SESSION_ID);
      // The stream-ended event will handle the rest
    } catch (e) {
      console.error("Failed to stop ingest:", e);
      // Force cleanup
      setIsIngesting(false);
      setIngestProfileId(null);
      cleanupListeners();
    }
  }, [cleanupListeners]);

  // Clear error
  const clearIngestError = useCallback(() => {
    setIngestError(null);
  }, []);

  return {
    isIngesting,
    ingestProfileId,
    ingestFrameCount,
    ingestError,
    startIngest,
    stopIngest,
    clearIngestError,
  };
}
