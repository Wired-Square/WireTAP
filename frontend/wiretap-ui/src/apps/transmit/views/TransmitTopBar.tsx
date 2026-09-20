// ui/src/apps/transmit/views/TransmitTopBar.tsx
//
// Top toolbar for the Transmit app with IO picker button and session controls.
// Uses shared AppTopBar component for consistent layout.

import { GitMerge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { flexRowGap2 } from "../../../styles/spacing";
import { Badge } from "../../../components/Badge";
import type { IOProfile } from "../../../types/common";
import AppTopBar from "../../../components/AppTopBar";
import { textSecondary } from "../../../styles/colourTokens";

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
  onStop?: () => void;
  onDestroy?: () => void;

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
  onStop,
  onDestroy,
  isLoading = false,
  error = null,
}: Props) {
  const { t } = useTranslation("transmit");
  // Show as multi-bus when multiBusProfiles has entries
  const showAsMultiBus = multiBusProfiles.length > 0;

  return (
    <AppTopBar
      app="transmit"
      frameIdFormat
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
        onStop,
        onDestroy,
      }}
      actions={
        <>
          {/* Loading indicator */}
          {isLoading && (
            <span className={`text-xs ${textSecondary}`}>{t("common:states.loading")}</span>
          )}

          {/* Connection error */}
          {error && (
            <span className="text-xs text-danger max-w-75 truncate">
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
            <Badge tone="purple">
              <GitMerge size={10} />
              {t("topBar.multiSourceLabel")}
            </Badge>
          )}
          {capabilities.protocols.includes("canfd") && (
            <Badge tone="success">{t("topBar.fdLabel")}</Badge>
          )}
          {capabilities.available_buses.length > 1 && (
            <Badge tone="warning">{t("topBar.extendedLabel")}</Badge>
          )}
        </div>
      )}

    </AppTopBar>
  );
}
