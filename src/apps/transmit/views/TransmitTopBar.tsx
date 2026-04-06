// ui/src/apps/transmit/views/TransmitTopBar.tsx
//
// Top toolbar for the Transmit app with IO picker button and session controls.
// Uses shared AppTopBar component for consistent layout.

import { Send, GitMerge } from "lucide-react";
import { flexRowGap2 } from "../../../styles/spacing";
import type { IOProfile } from "../../../types/common";
import AppTopBar from "../../../components/AppTopBar";
import { textDataSecondary } from "../../../styles/colourTokens";

interface Props {
  // IO profiles
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;
  /** Current session ID (e.g., "f_abc123") */
  sessionId?: string | null;

  // Multi-bus mode
  multiBusProfiles?: string[];

  // Session state
  isStreaming: boolean;
  isPaused?: boolean;
  isStopped?: boolean;
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;

  // Session capabilities
  capabilities?: {
    protocols: string[];
    available_buses: number[];
  } | null;

  // Speed (for recorded sources)
  speed?: number;
  supportsSpeed?: boolean;
  onOpenSpeedPicker?: () => void;

  // Bookmark (for time range sources)
  supportsTimeRange?: boolean;
  onOpenBookmarkPicker?: () => void;

  // Frame counts (for tooltip)
  uniqueFrameCount?: number;
  totalFrameCount?: number;

  // Handlers
  onOpenIoPicker: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onLeave?: () => void;

  // Loading/error state
  isLoading?: boolean;
  error?: string | null;
}

export default function TransmitTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  sessionId,
  multiBusProfiles = [],
  isStreaming,
  isPaused = false,
  isStopped = false,
  ioState,
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  supportsTimeRange = false,
  onOpenBookmarkPicker,
  capabilities,
  uniqueFrameCount,
  totalFrameCount,
  onOpenIoPicker,
  onPlay,
  onPause,
  onLeave,
  isLoading = false,
  error = null,
}: Props) {
  // Show as multi-bus when multiBusProfiles has entries
  const showAsMultiBus = multiBusProfiles.length > 0;

  return (
    <AppTopBar
      icon={Send}
      iconColour="text-red-500"
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusProfiles,
        defaultReadProfileId,
        sessionId,
        ioState,
        frameCount: uniqueFrameCount,
        totalFrameCount,
        onOpenIoSessionPicker: onOpenIoPicker,
        speed,
        supportsSpeed,
        onOpenSpeedPicker,
        supportsTimeRange,
        onOpenBookmarkPicker,
        isStreaming,
        isPaused,
        isStopped,
        onPlay,
        onPause,
        onLeave,
      }}
      actions={
        <>
          {/* Loading indicator */}
          {isLoading && (
            <span className={`text-xs ${textDataSecondary}`}>Loading...</span>
          )}

          {/* Connection error */}
          {error && (
            <span className="text-xs text-red-400 max-w-[300px] truncate">
              {error}
            </span>
          )}
        </>
      }
    >
      {/* Capability badges */}
      {capabilities && (
        <div className={flexRowGap2}>
          {showAsMultiBus && (
            <span className="text-xs px-2 py-0.5 rounded bg-purple-600/30 text-purple-400 flex items-center gap-1">
              <GitMerge size={10} />
              Multi-Source
            </span>
          )}
          {capabilities.protocols.includes("canfd") && (
            <span className="text-xs px-2 py-0.5 rounded bg-green-600/30 text-green-400">
              FD
            </span>
          )}
          {capabilities.available_buses.length > 1 && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-600/30 text-amber-400">
              Multi-Bus
            </span>
          )}
        </div>
      )}

    </AppTopBar>
  );
}
