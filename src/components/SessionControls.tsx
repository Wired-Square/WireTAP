// src/components/SessionControls.tsx
//
// Shared session control components for top bars.
// Handles reader display, stop/resume/leave controls.

import { useState, useRef, useEffect } from "react";
import { Star, FileText, Square, Play, GitMerge, Bookmark, LogOut, Pencil, Pin, PinOff } from "lucide-react";
import { iconSm, iconXs } from "../styles/spacing";
import type { IOProfile } from "../types/common";
import type { BufferMetadata } from "../api/buffer";
import { isBufferProfileId } from "../hooks/useIOSessionManager";
import {
  buttonBase,
  dangerButtonBase,
  warningButtonBase,
  successIconButton,
} from "../styles/buttonStyles";
import { getIOKindLabel } from "../utils/ioKindLabel";

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
  /** Number of unique frame IDs (shown in tooltip) */
  frameCount?: number;
  /** Total number of frames seen (shown in tooltip when available) */
  totalFrameCount?: number;
  /** Click handler to open reader picker */
  onClick: () => void;
  /** Whether button should be disabled (e.g., while streaming) */
  disabled?: boolean;
}

export function ReaderButton({
  ioProfile,
  ioProfiles,
  multiBusProfiles = [],
  bufferMetadata,
  defaultReadProfileId,
  sessionId,
  ioState,
  frameCount,
  totalFrameCount,
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
    // Buffer: show display name if available, otherwise buffer ID
    displayName = bufferMetadata?.name || ioProfile || "Buffer";
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
    // No matching profile - ioProfile is the session ID (e.g., "t_8852db")
    displayName = ioProfile;
    sessionIdInDisplayName = true; // Don't show sessionId separately
  } else {
    displayName = "No source";
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

  // --- Tooltip data (only when a session is configured) ---
  const showTooltip = ioProfile !== null;

  const getStatusLabel = (): { label: string; colour: string } | null => {
    if (!ioState || !ioProfile) return null;
    if (ioState === "running")  return { label: "Running",  colour: "text-[color:var(--status-success-text)]" };
    if (ioState === "paused")   return { label: "Paused",   colour: "text-[color:var(--status-warning-text)]" };
    if (ioState === "stopped")  return { label: "Stopped",  colour: "text-[color:var(--text-muted)]" };
    if (ioState === "starting") return { label: "Starting", colour: "text-[color:var(--status-info-text)]" };
    if (ioState.startsWith("Error")) return { label: ioState, colour: "text-[color:var(--status-danger-text)]" };
    return { label: ioState, colour: "text-[color:var(--text-secondary)]" };
  };
  const statusLabel = getStatusLabel();

  let typeLabel: string;
  if (isBufferProfile) {
    typeLabel = "Buffer";
  } else if (showAsMultiBus) {
    typeLabel = "Multi-Source";
  } else if (selectedProfile?.kind) {
    typeLabel = getIOKindLabel(selectedProfile.kind);
  } else {
    typeLabel = "Unknown";
  }

  let sourceNames: string[];
  if (showAsMultiBus) {
    sourceNames = multiBusProfiles.map(
      (pid) => ioProfiles.find((p) => p.id === pid)?.name ?? pid
    );
  } else if (selectedProfile) {
    sourceNames = [selectedProfile.name];
  } else if (isBufferProfile) {
    sourceNames = [ioProfile ?? "Buffer"];
  } else {
    sourceNames = [];
  }

  return (
    <div className="relative group shrink-0">
      <button
        onClick={onClick}
        disabled={disabled}
        className={buttonBase}
        title={showTooltip ? undefined : "Select source"}
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
          />
        )}
        <span className="max-w-40 truncate">{displayName}</span>
        {sessionId && !sessionIdInDisplayName && (
          <span className="text-[color:var(--text-muted)] text-xs font-mono">{sessionId}</span>
        )}
      </button>

      {/* Session preview tooltip */}
      {showTooltip && (
        <div
          className={[
            "absolute left-1/2 -translate-x-1/2 top-full mt-2",
            "min-w-[180px] max-w-[260px]",
            "px-3 py-2 rounded-lg border shadow-xl z-50",
            "bg-[var(--bg-surface)] border-[color:var(--border-default)]",
            "text-xs",
            "opacity-0 invisible group-hover:opacity-100 group-hover:visible",
            "transition-all duration-200 delay-300",
            "pointer-events-none",
          ].join(" ")}
        >
          {/* Arrow */}
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-[var(--bg-surface)] border-l border-t border-[color:var(--border-default)]" />

          {/* State */}
          {statusLabel && (
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-[color:var(--text-muted)]">State</span>
              <span className={`font-medium ${statusLabel.colour}`}>{statusLabel.label}</span>
            </div>
          )}

          {/* Type */}
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="text-[color:var(--text-muted)]">Type</span>
            <span className="font-medium text-[color:var(--text-primary)]">{typeLabel}</span>
          </div>

          {/* Frame counts */}
          {totalFrameCount != null && (
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-[color:var(--text-muted)]">Frames</span>
              <span className="font-medium text-[color:var(--text-primary)]">{totalFrameCount.toLocaleString()}</span>
            </div>
          )}
          {frameCount != null && (
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-[color:var(--text-muted)]">{totalFrameCount != null ? "Unique" : "Frames"}</span>
              <span className="font-medium text-[color:var(--text-primary)]">{frameCount.toLocaleString()}</span>
            </div>
          )}

          {/* Sources */}
          {sourceNames.length > 0 && (
            <div className="flex items-start justify-between gap-3">
              <span className="text-[color:var(--text-muted)] shrink-0">
                {sourceNames.length > 1 ? "Sources" : "Source"}
              </span>
              <div className="flex flex-col items-end">
                {sourceNames.map((name, i) => (
                  <span key={i} className="text-[color:var(--text-primary)] truncate max-w-[160px]">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
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
  /** Number of unique frame IDs (shown in tooltip) */
  frameCount?: number;
  /** Total number of frames seen (shown in tooltip when available) */
  totalFrameCount?: number;
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

  // Buffer action props (shown when viewing a buffer)
  /** Whether the current buffer is persistent (pinned) */
  bufferPersistent?: boolean;
  /** Called when user toggles buffer pin */
  onToggleBufferPin?: () => void;
  /** Called when user renames the buffer */
  onRenameBuffer?: (newName: string) => void;
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
  frameCount,
  totalFrameCount,
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
  // Buffer action props
  bufferPersistent = false,
  onToggleBufferPin,
  onRenameBuffer,
}: IOSessionControlsProps) {
  // Auto-hide session controls when in buffer mode (playback controls are in the toolbar instead)
  const isBufferMode = isBufferProfileId(ioProfile);
  const shouldHideControls = hideSessionControls || isBufferMode;
  // Live session = we have an ioProfile that's not a buffer
  const isLiveSession = ioProfile !== null && !isBufferMode;

  // Rename popover state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(bufferMetadata?.name || ioProfile || "");
    setIsRenaming(true);
  };

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && onRenameBuffer) {
      onRenameBuffer(trimmed);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setIsRenaming(false);
  };

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
        frameCount={frameCount}
        totalFrameCount={totalFrameCount}
        onClick={onOpenIoReaderPicker}
        disabled={isStreaming && !isBufferMode}
      />

      {/* Buffer actions - pin and rename (shown when viewing a buffer) */}
      {isBufferMode && bufferMetadata?.id && (
        <div className="relative flex items-center gap-0.5">
          {onRenameBuffer && (
            <button
              onClick={startRename}
              className="p-1 rounded transition-colors hover:bg-[var(--hover-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
              title="Rename buffer"
            >
              <Pencil className={iconXs} />
            </button>
          )}
          {onToggleBufferPin && (
            <button
              onClick={onToggleBufferPin}
              className={`p-1 rounded transition-colors hover:bg-[var(--hover-bg)] ${
                bufferPersistent
                  ? "text-[color:var(--status-warning-text)]"
                  : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
              }`}
              title={bufferPersistent ? "Unpin buffer (will be cleared on restart)" : "Pin buffer (survives restart)"}
            >
              {bufferPersistent ? <Pin className={iconXs} /> : <PinOff className={iconXs} />}
            </button>
          )}
          {/* Rename popover */}
          {isRenaming && (
            <div className="absolute left-0 top-full mt-1 z-50 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg shadow-xl p-2">
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") cancelRename();
                }}
                className="w-48 px-2 py-1 text-sm bg-transparent border border-[color:var(--status-info-text)] rounded outline-none text-[color:var(--text-primary)]"
                placeholder="Buffer name"
              />
            </div>
          )}
        </div>
      )}

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
