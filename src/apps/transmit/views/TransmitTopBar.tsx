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
  multiBusMode?: boolean;
  multiBusProfiles?: string[];

  // Session state
  isStreaming: boolean;
  isStopped?: boolean;
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;

  // Session capabilities
  capabilities?: {
    can_transmit: boolean;
    can_transmit_serial: boolean;
    supports_canfd: boolean;
    available_buses: number[];
  } | null;

  // Speed (for timeline sources)
  speed?: number;
  supportsSpeed?: boolean;
  onOpenSpeedPicker?: () => void;

  // Bookmark (for time range sources)
  supportsTimeRange?: boolean;
  onOpenBookmarkPicker?: () => void;

  // Handlers
  onOpenIoPicker: () => void;
  onStop?: () => void;
  onResume?: () => void;
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
  multiBusMode = false,
  multiBusProfiles = [],
  isStreaming,
  isStopped = false,
  ioState,
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  supportsTimeRange = false,
  onOpenBookmarkPicker,
  capabilities,
  onOpenIoPicker,
  onStop,
  onResume,
  onLeave,
  isLoading = false,
  error = null,
}: Props) {
  // Show as multi-bus if either:
  // 1. multiBusMode is true (creating multi-bus session), OR
  // 2. multiBusProfiles has entries (joined an existing multi-source session)
  const showAsMultiBus = multiBusMode || multiBusProfiles.length > 0;

  return (
    <AppTopBar
      icon={Send}
      iconColour="text-red-500"
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusMode,
        multiBusProfiles,
        defaultReadProfileId,
        sessionId,
        ioState,
        onOpenIoReaderPicker: onOpenIoPicker,
        speed,
        supportsSpeed,
        onOpenSpeedPicker,
        supportsTimeRange,
        onOpenBookmarkPicker,
        isStreaming,
        isStopped,
        onStop,
        onResume,
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
          {capabilities.supports_canfd && (
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
