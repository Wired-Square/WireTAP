// src/components/SessionControls.tsx
//
// Shared session control components for top bars.
// Handles reader display, stop/resume/leave controls.

import { Star, FileText, Square, Play, GitMerge, Bookmark, LogOut } from "lucide-react";
import { iconSm } from "../styles/spacing";
import type { IOProfile } from "../types/common";
import type { BufferMetadata } from "../api/buffer";
import { isBufferProfileId } from "../hooks/useIOSessionManager";
import {
  buttonBase,
  dangerButtonBase,
  warningButtonBase,
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
  /** Profile IDs when in multi-bus mode (for display count) */
  multiBusProfiles?: string[];
  /** Buffer metadata (for buffer display name) */
  bufferMetadata?: BufferMetadata | null;
  /** Default read profile ID (for star icon) */
  defaultReadProfileId?: string | null;
  /** Current session ID (e.g., "f_abc123") - displayed in nav bar */
  sessionId?: string | null;
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;
  /** Click handler to open reader picker */
  onClick: () => void;
  /** Whether button should be disabled (e.g., while streaming) */
  disabled?: boolean;
}

export function ReaderButton({
  ioProfile,
  ioProfiles,
  multiBusProfiles = [],
  bufferMetadata: _bufferMetadata,
  defaultReadProfileId,
  sessionId,
  ioState,
  onClick,
  disabled = false,
}: ReaderButtonProps) {
  const isBufferProfile = isBufferProfileId(ioProfile);
  const selectedProfile = ioProfiles.find((p) => p.id === ioProfile);

  // Show as multi-bus when multiBusProfiles has entries
  // BUT: never show as multi-bus when viewing a buffer (buffer takes precedence)
  const showAsMultiBus = !isBufferProfile && multiBusProfiles.length > 0;

  // Determine display name (buffer takes precedence over multi-bus)
  let displayName: string;
  // Track whether sessionId is already shown in displayName (to avoid duplication)
  let sessionIdInDisplayName = false;
  if (isBufferProfile) {
    // Buffer: just show the buffer ID (e.g., "buf_123")
    displayName = ioProfile || "Buffer";
    sessionIdInDisplayName = true; // buffer ID is the session ID
  } else if (showAsMultiBus) {
    // Multi-bus: show sessionId with profile count (e.g., "f_abc123 (2)")
    displayName = sessionId
      ? `${sessionId} (${multiBusProfiles.length})`
      : `Multi-Bus (${multiBusProfiles.length})`;
    sessionIdInDisplayName = !!sessionId;
  } else if (selectedProfile) {
    displayName = selectedProfile.name;
  } else if (ioProfile) {
    // No matching profile - show the session ID (e.g., "t_8852db")
    displayName = ioProfile;
  } else {
    displayName = "No reader";
  }

  const isDefaultReader = !isBufferProfile && !showAsMultiBus && selectedProfile?.id === defaultReadProfileId;

  // Determine status dot colour based on ioState
  const getStatusColour = (): string | null => {
    if (!ioState || !ioProfile) return null;
    if (ioState === "running") return "bg-green-500";
    if (ioState === "paused") return "bg-yellow-500";
    if (ioState === "stopped") return "bg-[color:var(--text-muted)]";
    if (ioState === "starting") return "bg-blue-500 animate-pulse";
    if (ioState.startsWith("Error")) return "bg-red-500";
    return null;
  };
  const statusColour = getStatusColour();

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
      {statusColour && (
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColour}`}
          title={ioState ?? undefined}
        />
      )}
      <span className="max-w-40 truncate">{displayName}</span>
      {sessionId && !sessionIdInDisplayName && (
        <span className="text-[color:var(--text-muted)] text-xs font-mono">{sessionId}</span>
      )}
    </button>
  );
}

// ============================================================================
// Session Action Buttons - stop, resume, leave
// ============================================================================

export interface SessionActionButtonsProps {
  /** Whether the session is actively streaming */
  isStreaming: boolean;
  /** Whether the session is stopped but can be resumed */
  isStopped?: boolean;
  /** Whether the IO source supports time range filtering (shows bookmark button) */
  supportsTimeRange?: boolean;
  /** Whether we're connected to a live session (not a buffer) - enables Leave button */
  isLiveSession?: boolean;
  /** Stop the session */
  onStop?: () => void;
  /** Resume a stopped session */
  onResume?: () => void;
  /** Leave the session (last to leave triggers auto-destroy) */
  onLeave?: () => void;
  /** Open bookmark picker (for time range sources) */
  onOpenBookmarkPicker?: () => void;
}

export function SessionActionButtons({
  isStreaming,
  isStopped = false,
  supportsTimeRange = false,
  isLiveSession = false,
  onStop,
  onResume,
  onLeave,
  onOpenBookmarkPicker,
}: SessionActionButtonsProps) {
  // Show Leave for live sessions
  const showSessionManagement = isLiveSession;

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
      {isStopped && onResume && (
        <button
          onClick={onResume}
          className={successIconButton}
          title="Resume IO Stream"
        >
          <Play className={iconSm} />
        </button>
      )}

      {/* Leave button - shown when joined to a live session */}
      {showSessionManagement && onLeave && (
        <button
          onClick={onLeave}
          className={warningButtonBase}
          title="Leave session"
        >
          <LogOut className={iconSm} />
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
  /** Profile IDs when in multi-bus mode */
  multiBusProfiles?: string[];
  /** Buffer metadata (for buffer display name) */
  bufferMetadata?: BufferMetadata | null;
  /** Default read profile ID (for star icon) */
  defaultReadProfileId?: string | null;
  /** Current session ID (e.g., "f_abc123") - displayed in nav bar */
  sessionId?: string | null;
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;
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
  /** Whether the IO source supports time range filtering */
  supportsTimeRange?: boolean;
  /** Stop the session */
  onStop?: () => void;
  /** Resume a stopped session */
  onResume?: () => void;
  /** Leave the session (last to leave triggers auto-destroy) */
  onLeave?: () => void;
  /** Open bookmark picker (for time range sources) */
  onOpenBookmarkPicker?: () => void;
  /** Hide session action buttons (for buffer mode where playback controls are elsewhere) */
  hideSessionControls?: boolean;
}

/**
 * Combined IO session controls component.
 * Includes reader button, speed picker button, and session action buttons (stop/resume/leave/bookmark).
 * Use this instead of separate ReaderButton + SessionActionButtons for consistent layout.
 */
export function IOSessionControls({
  // Reader props
  ioProfile,
  ioProfiles,
  multiBusProfiles = [],
  bufferMetadata,
  defaultReadProfileId,
  sessionId,
  ioState,
  onOpenIoReaderPicker,
  // Speed props
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  // Session action props
  isStreaming,
  isStopped = false,
  supportsTimeRange = false,
  onStop,
  onResume,
  onLeave,
  onOpenBookmarkPicker,
  hideSessionControls = false,
}: IOSessionControlsProps) {
  // Auto-hide session controls when in buffer mode (playback controls are in the toolbar instead)
  const isBufferMode = isBufferProfileId(ioProfile);
  const shouldHideControls = hideSessionControls || isBufferMode;
  // Live session = we have an ioProfile that's not a buffer
  const isLiveSession = ioProfile !== null && !isBufferMode;

  return (
    <>
      {/* IO Reader Selection */}
      <ReaderButton
        ioProfile={ioProfile}
        ioProfiles={ioProfiles}
        multiBusProfiles={multiBusProfiles}
        bufferMetadata={bufferMetadata}
        defaultReadProfileId={defaultReadProfileId}
        sessionId={sessionId}
        ioState={ioState}
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

      {/* Session control buttons (bookmark, stop, resume, leave) - hidden in buffer mode */}
      {!shouldHideControls && (
        <SessionActionButtons
          isStreaming={isStreaming}
          isStopped={isStopped}
          supportsTimeRange={supportsTimeRange}
          isLiveSession={isLiveSession}
          onStop={onStop}
          onResume={onResume}
          onLeave={onLeave}
          onOpenBookmarkPicker={onOpenBookmarkPicker}
        />
      )}
    </>
  );
}
