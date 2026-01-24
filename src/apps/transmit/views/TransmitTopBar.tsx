// ui/src/apps/transmit/views/TransmitTopBar.tsx
//
// Top toolbar for the Transmit app with IO picker button and session controls.
// Uses shared SessionControls components for consistency with Discovery/Decoder.

import { Send, Link2, GitMerge } from "lucide-react";
import type { IOProfile } from "../../../types/common";
import { IOSessionControls } from "../../../components/SessionControls";
import FlexSeparator from "../../../components/FlexSeparator";
import {
  bgDarkToolbar,
  borderDarkView,
  textDarkMuted,
} from "../../../styles/colourTokens";

interface Props {
  // IO profiles
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;

  // Multi-bus mode
  multiBusMode?: boolean;
  multiBusProfiles?: string[];

  // Session state
  isStreaming: boolean;
  isStopped?: boolean;
  isDetached?: boolean;
  joinerCount?: number;

  // Session capabilities
  capabilities?: {
    can_transmit: boolean;
    can_transmit_serial: boolean;
    supports_canfd: boolean;
    available_buses: number[];
  } | null;

  // Handlers
  onOpenIoPicker: () => void;
  onStop?: () => void;
  onResume?: () => void;
  onDetach?: () => void;
  onRejoin?: () => void;

  // Loading/error state
  isLoading?: boolean;
  error?: string | null;
}

export default function TransmitTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  multiBusMode = false,
  multiBusProfiles = [],
  isStreaming,
  isStopped = false,
  isDetached = false,
  joinerCount = 1,
  capabilities,
  onOpenIoPicker,
  onStop,
  onResume,
  onDetach,
  onRejoin,
  isLoading = false,
  error = null,
}: Props) {
  // Show as multi-bus if either:
  // 1. multiBusMode is true (creating multi-bus session), OR
  // 2. multiBusProfiles has entries (joined an existing multi-source session)
  const showAsMultiBus = multiBusMode || multiBusProfiles.length > 0;

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2 ${bgDarkToolbar} border-b ${borderDarkView}`}
    >
      {/* Transmit icon */}
      <Send className="w-5 h-5 text-red-500 shrink-0" />

      <FlexSeparator />

      {/* IO Session Controls (reader + session actions) */}
      <IOSessionControls
        ioProfile={ioProfile}
        ioProfiles={ioProfiles}
        multiBusMode={multiBusMode}
        multiBusProfiles={multiBusProfiles}
        defaultReadProfileId={defaultReadProfileId}
        onOpenIoReaderPicker={onOpenIoPicker}
        isStreaming={isStreaming}
        isStopped={isStopped}
        isDetached={isDetached}
        joinerCount={joinerCount}
        onStop={onStop}
        onResume={onResume}
        onDetach={onDetach}
        onRejoin={onRejoin}
      />

      {/* Capability badges */}
      {capabilities && (
        <div className="flex items-center gap-2">
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

      {/* Joiner count indicator */}
      {joinerCount > 1 && (
        <div className="flex items-center gap-1 text-blue-400">
          <Link2 size={14} />
          <span className="text-xs">{joinerCount} apps connected</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Loading indicator */}
      {isLoading && (
        <span className={`text-xs ${textDarkMuted}`}>Loading...</span>
      )}

      {/* Connection error */}
      {error && (
        <span className="text-xs text-red-400 max-w-[300px] truncate">
          {error}
        </span>
      )}
    </div>
  );
}
