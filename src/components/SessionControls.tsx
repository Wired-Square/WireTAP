// src/components/SessionControls.tsx
//
// Shared session control components for top bars.
// Handles reader display, stop/resume/detach/rejoin controls.

import { Star, FileText, Square, Unplug, Plug, Play, GitMerge, Bookmark } from "lucide-react";
import { iconSm } from "../styles/spacing";
import type { IOProfile } from "../types/common";
import type { BufferMetadata } from "../api/buffer";
import { isBufferProfileId } from "../hooks/useIOSessionManager";
import {
  buttonBase,
  dangerButtonBase,
  warningButtonBase,
  successButtonBase,
  successIconButton,
} from "../styles/buttonStyles";

// ============================================================================
// Reader Button - displays current reader with appropriate icon
// ============================================================================

export interface ReaderButtonProps {
  /** Current IO profile/session ID */
  ioProfile: string | null;
  /** Available IO profiles */
  ioProfiles: IOProfile[];
  /** Whether multi-bus mode is active */
  multiBusMode?: boolean;
  /** Profile IDs when in multi-bus mode (for display count) */
  multiBusProfiles?: string[];
  /** Buffer metadata (for buffer display name) */
  bufferMetadata?: BufferMetadata | null;
  /** Default read profile ID (for star icon) */
  defaultReadProfileId?: string | null;
  /** Click handler to open reader picker */
  onClick: () => void;
  /** Whether button should be disabled (e.g., while streaming) */
  disabled?: boolean;
}

export function ReaderButton({
  ioProfile,
  ioProfiles,
  multiBusMode = false,
  multiBusProfiles = [],
  bufferMetadata,
  defaultReadProfileId,
  onClick,
  disabled = false,
}: ReaderButtonProps) {
  const isBufferProfile = isBufferProfileId(ioProfile);
  const selectedProfile = ioProfiles.find((p) => p.id === ioProfile);

  // Show as multi-bus if either:
  // 1. multiBusMode is true (creating multi-bus session), OR
  // 2. multiBusProfiles has entries (joined an existing multi-source session)
  const showAsMultiBus = multiBusMode || multiBusProfiles.length > 0;

  // Determine display name
  let displayName: string;
  if (showAsMultiBus) {
    displayName = `Multi-Bus (${multiBusProfiles.length})`;
  } else if (isBufferProfile) {
    displayName = `Buffer: ${bufferMetadata?.name || "Buffer"}`;
  } else if (selectedProfile) {
    displayName = selectedProfile.name;
  } else if (ioProfile) {
    // No matching profile - show the session ID (e.g., "postgres_8852db")
    displayName = ioProfile;
  } else {
    displayName = "No reader";
  }

  const isDefaultReader = !isBufferProfile && !showAsMultiBus && selectedProfile?.id === defaultReadProfileId;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={buttonBase}
      title="Select IO Reader"
    >
      {showAsMultiBus ? (
        <GitMerge className={`${iconSm} text-purple-500 flex-shrink-0`} />
      ) : isBufferProfile ? (
        <FileText className={`${iconSm} text-blue-500 flex-shrink-0`} />
      ) : isDefaultReader ? (
        <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
      ) : null}
      <span className="max-w-40 truncate">{displayName}</span>
    </button>
  );
}

// ============================================================================
// Session Action Buttons - stop, resume, detach, rejoin
// ============================================================================

export interface SessionActionButtonsProps {
  /** Whether the session is actively streaming */
  isStreaming: boolean;
  /** Whether the session is stopped but can be resumed */
  isStopped?: boolean;
  /** Whether we've detached from the session */
  isDetached?: boolean;
  /** Number of apps connected to this session */
  joinerCount?: number;
  /** Whether the IO source supports time range filtering (shows bookmark button) */
  supportsTimeRange?: boolean;
  /** Stop the session */
  onStop?: () => void;
  /** Resume a stopped session */
  onResume?: () => void;
  /** Detach from a shared session without stopping */
  onDetach?: () => void;
  /** Rejoin after detaching */
  onRejoin?: () => void;
  /** Open bookmark picker (for time range sources) */
  onOpenBookmarkPicker?: () => void;
}

export function SessionActionButtons({
  isStreaming,
  isStopped = false,
  isDetached = false,
  joinerCount = 1,
  supportsTimeRange = false,
  onStop,
  onResume,
  onDetach,
  onRejoin,
  onOpenBookmarkPicker,
}: SessionActionButtonsProps) {
  return (
    <>
      {/* Bookmark button - shown when source supports time range */}
      {supportsTimeRange && onOpenBookmarkPicker && (
        <button
          onClick={onOpenBookmarkPicker}
          className={buttonBase}
          title="Load saved time bookmark"
        >
          <Bookmark className={iconSm} />
        </button>
      )}

      {/* Stop button - only shown when actively streaming */}
      {isStreaming && onStop && (
        <button
          onClick={onStop}
          className={dangerButtonBase}
          title="Stop IO Stream"
        >
          <Square className={iconSm} />
        </button>
      )}

      {/* Resume button - shown when session is stopped but profile is selected */}
      {isStopped && !isDetached && onResume && (
        <button
          onClick={onResume}
          className={successIconButton}
          title="Resume IO Stream"
        >
          <Play className={iconSm} />
        </button>
      )}

      {/* Detach button - only shown when streaming and multiple apps are connected */}
      {isStreaming && joinerCount > 1 && onDetach && (
        <button
          onClick={onDetach}
          className={warningButtonBase}
          title="Detach from shared session (keeps streaming for other apps)"
        >
          <Unplug className={iconSm} />
        </button>
      )}

      {/* Rejoin button - shown when detached from a session */}
      {isDetached && onRejoin && (
        <button
          onClick={onRejoin}
          className={successButtonBase}
          title="Rejoin Session"
        >
          <Plug className={iconSm} />
          <span>Rejoin</span>
        </button>
      )}
    </>
  );
}

// ============================================================================
// IO Session Controls - combined reader, speed, and session controls
// ============================================================================

export interface IOSessionControlsProps {
  // Reader button props
  /** Current IO profile/session ID */
  ioProfile: string | null;
  /** Available IO profiles */
  ioProfiles: IOProfile[];
  /** Whether multi-bus mode is active */
  multiBusMode?: boolean;
  /** Profile IDs when in multi-bus mode */
  multiBusProfiles?: string[];
  /** Buffer metadata (for buffer display name) */
  bufferMetadata?: BufferMetadata | null;
  /** Default read profile ID (for star icon) */
  defaultReadProfileId?: string | null;
  /** Click handler to open reader picker */
  onOpenIoReaderPicker: () => void;

  // Speed props
  /** Current playback speed */
  speed?: number;
  /** Whether the reader supports speed control */
  supportsSpeed?: boolean;
  /** Click handler to open speed picker */
  onOpenSpeedPicker?: () => void;

  // Session action props
  /** Whether the session is actively streaming */
  isStreaming: boolean;
  /** Whether the session is stopped but can be resumed */
  isStopped?: boolean;
  /** Whether we've detached from the session */
  isDetached?: boolean;
  /** Number of apps connected to this session */
  joinerCount?: number;
  /** Whether the IO source supports time range filtering */
  supportsTimeRange?: boolean;
  /** Stop the session */
  onStop?: () => void;
  /** Resume a stopped session */
  onResume?: () => void;
  /** Detach from a shared session without stopping */
  onDetach?: () => void;
  /** Rejoin after detaching */
  onRejoin?: () => void;
  /** Open bookmark picker (for time range sources) */
  onOpenBookmarkPicker?: () => void;
  /** Hide session action buttons (for buffer mode where playback controls are elsewhere) */
  hideSessionControls?: boolean;
}

/**
 * Combined IO session controls component.
 * Includes reader button, speed picker button, and session action buttons (stop/resume/detach/rejoin/bookmark).
 * Use this instead of separate ReaderButton + SessionActionButtons for consistent layout.
 */
export function IOSessionControls({
  // Reader props
  ioProfile,
  ioProfiles,
  multiBusMode = false,
  multiBusProfiles = [],
  bufferMetadata,
  defaultReadProfileId,
  onOpenIoReaderPicker,
  // Speed props
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  // Session action props
  isStreaming,
  isStopped = false,
  isDetached = false,
  joinerCount = 1,
  supportsTimeRange = false,
  onStop,
  onResume,
  onDetach,
  onRejoin,
  onOpenBookmarkPicker,
  hideSessionControls = false,
}: IOSessionControlsProps) {
  // Auto-hide session controls when in buffer mode (playback controls are in the toolbar instead)
  const isBufferMode = isBufferProfileId(ioProfile);
  const shouldHideControls = hideSessionControls || isBufferMode;

  return (
    <>
      {/* IO Reader Selection */}
      <ReaderButton
        ioProfile={ioProfile}
        ioProfiles={ioProfiles}
        multiBusMode={multiBusMode}
        multiBusProfiles={multiBusProfiles}
        bufferMetadata={bufferMetadata}
        defaultReadProfileId={defaultReadProfileId}
        onClick={onOpenIoReaderPicker}
        disabled={isStreaming && !isBufferMode}
      />

      {/* Speed button - only show if reader supports speed and not in buffer mode */}
      {supportsSpeed && onOpenSpeedPicker && !shouldHideControls && (
        <button
          onClick={onOpenSpeedPicker}
          className={buttonBase}
          title="Set playback speed"
        >
          <span>{speed === 0 ? "0x" : speed === 1 ? "1x" : `${speed}x`}</span>
        </button>
      )}

      {/* Session control buttons (bookmark, stop, resume, detach, rejoin) - hidden in buffer mode */}
      {!shouldHideControls && (
        <SessionActionButtons
          isStreaming={isStreaming}
          isStopped={isStopped}
          isDetached={isDetached}
          joinerCount={joinerCount}
          supportsTimeRange={supportsTimeRange}
          onStop={onStop}
          onResume={onResume}
          onDetach={onDetach}
          onRejoin={onRejoin}
          onOpenBookmarkPicker={onOpenBookmarkPicker}
        />
      )}
    </>
  );
}
