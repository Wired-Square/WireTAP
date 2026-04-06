// src/components/SessionControls.tsx
//
// Shared session control components for top bars.
// Handles reader display, play/pause/leave controls, speed, and capture metadata.

import { useState, useRef, useEffect, useCallback } from "react";
import { Star, FileText, Play, Pause, GitMerge, Bookmark, LogOut, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { iconSm, iconXs } from "../styles/spacing";
import type { IOProfile } from "../types/common";
import type { CaptureMetadata } from "../api/capture";
import type { BusSourceInfo } from "../utils/busFormat";
import { isCaptureProfileId } from "../hooks/useIOSessionManager";
import {
  buttonBase,
  warningButtonBase,
  successIconButton,
} from "../styles/buttonStyles";
import { getIOKindLabel } from "../utils/ioKindLabel";

// ============================================================================
// Session Button - displays current source with appropriate icon
// ============================================================================

export interface SessionButtonProps {
  /** Current IO profile/session ID */
  ioProfile: string | null;
  /** Available IO profiles */
  ioProfiles: IOProfile[];
  /** Profile IDs when in multi-bus mode (for display count) */
  multiBusProfiles?: string[];
  /** Capture metadata (for capture display name) */
  captureMetadata?: CaptureMetadata | null;
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
  /** Bus-to-source mapping for multi-bus tooltip display */
  outputBusToSource?: Map<number, BusSourceInfo>;
  /** Click handler to open session picker */
  onClick: () => void;
  /** Whether button should be disabled (e.g., while streaming) */
  disabled?: boolean;
  /** Whether the session is in capture replay mode */
  isCaptureMode?: boolean;
}

export function SessionButton({
  ioProfile,
  ioProfiles,
  multiBusProfiles = [],
  captureMetadata,
  defaultReadProfileId,
  sessionId,
  ioState,
  frameCount,
  totalFrameCount,
  outputBusToSource,
  onClick,
  disabled = false,
  isCaptureMode: isCaptureModeProp,
}: SessionButtonProps) {
  const isCaptureProfile = isCaptureModeProp ?? isCaptureProfileId(ioProfile);
  const selectedProfile = ioProfiles.find((p) => p.id === ioProfile);

  // Show as multi-bus when multiBusProfiles has entries
  // BUT: never show as multi-bus when viewing a capture (capture takes precedence)
  const showAsMultiBus = !isCaptureProfile && multiBusProfiles.length > 0;

  // Determine display name (capture takes precedence over multi-bus)
  let displayName: string;
  // Track whether sessionId is already shown in displayName (to avoid duplication)
  let sessionIdInDisplayName = false;
  if (isCaptureProfile) {
    // Capture: show label if set, then capture ID, then fallback
    displayName = captureMetadata?.name || captureMetadata?.id || "Capture";
    sessionIdInDisplayName = true;
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

  const isDefaultReader = !isCaptureProfile && !showAsMultiBus && selectedProfile?.id === defaultReadProfileId;

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
  if (isCaptureProfile) {
    typeLabel = "Capture";
  } else if (showAsMultiBus) {
    typeLabel = "Realtime";
  } else if (selectedProfile?.kind) {
    typeLabel = getIOKindLabel(selectedProfile.kind);
  } else {
    typeLabel = "Unknown";
  }

  // Build interface entries for tooltip (shown last)
  let interfaceEntries: { label: string; kind: string }[] = [];
  if (outputBusToSource && outputBusToSource.size > 0) {
    // Multi-bus: show bus-mapped interface info
    interfaceEntries = Array.from(outputBusToSource.entries())
      .sort(([a], [b]) => a - b)
      .map(([bus, info]) => {
        const profile = ioProfiles.find((p) => p.name === info.profileName);
        const kind = profile?.kind ? getIOKindLabel(profile.kind) : "";
        return { label: `bus${bus}: ${info.profileName}`, kind };
      });
  } else if (selectedProfile) {
    const kind = selectedProfile.kind ? getIOKindLabel(selectedProfile.kind) : "";
    interfaceEntries = [{ label: selectedProfile.name, kind }];
  }

  // Tooltip boundary clamping — adjust left offset so the tooltip stays on-screen
  const tooltipRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltipOffset, setTooltipOffset] = useState(0);
  const [arrowOffset, setArrowOffset] = useState("50%");

  const clampTooltip = useCallback(() => {
    const tip = tooltipRef.current;
    const container = containerRef.current;
    if (!tip || !container) return;

    const containerRect = container.getBoundingClientRect();
    const tipWidth = tip.offsetWidth;
    const margin = 8;

    // Default: centered on the button
    const centeredLeft = containerRect.left + containerRect.width / 2 - tipWidth / 2;
    let offset = 0;

    if (centeredLeft < margin) {
      // Clipping left edge
      offset = margin - centeredLeft;
    } else if (centeredLeft + tipWidth > window.innerWidth - margin) {
      // Clipping right edge
      offset = (window.innerWidth - margin) - (centeredLeft + tipWidth);
    }

    setTooltipOffset(offset);
    // Move arrow to stay centered over button
    const arrowPos = tipWidth / 2 - offset;
    setArrowOffset(`${arrowPos}px`);
  }, []);

  return (
    <div className="relative group shrink-0" ref={containerRef} onMouseEnter={clampTooltip}>
      <button
        onClick={onClick}
        disabled={disabled}
        className={buttonBase}
        title={showTooltip ? undefined : "Select source"}
      >
        {showAsMultiBus ? (
          <GitMerge className={`${iconSm} text-purple-500 flex-shrink-0`} />
        ) : isCaptureProfile ? (
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
          ref={tooltipRef}
          style={{ transform: `translateX(calc(-50% + ${tooltipOffset}px))` }}
          className={[
            "absolute left-1/2 top-full mt-2",
            "min-w-[180px] max-w-[280px]",
            "px-3 py-2 rounded-lg border shadow-xl z-50",
            "bg-[var(--bg-surface)] border-[color:var(--border-default)]",
            "text-xs",
            "opacity-0 invisible group-hover:opacity-100 group-hover:visible",
            "transition-all duration-200 delay-300",
            "pointer-events-none",
          ].join(" ")}
        >
          {/* Arrow */}
          <div
            style={{ left: arrowOffset }}
            className="absolute -top-1 -translate-x-1/2 w-2 h-2 rotate-45 bg-[var(--bg-surface)] border-l border-t border-[color:var(--border-default)]"
          />

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

          {/* Capture label */}
          {captureMetadata?.id && (
            <div className="flex items-center justify-between gap-3 mb-1">
              <span className="text-[color:var(--text-muted)]">Capture</span>
              <span className="font-medium text-[color:var(--text-primary)] truncate max-w-[160px]">
                {captureMetadata.name || captureMetadata.id}
              </span>
            </div>
          )}

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

          {/* Interfaces (shown last, one per bus) */}
          {interfaceEntries.length > 0 && (
            <div className="flex items-start justify-between gap-3 mt-1 pt-1 border-t border-[color:var(--border-default)]">
              <span className="text-[color:var(--text-muted)] shrink-0">
                {interfaceEntries.length > 1 ? "Interfaces" : "Interface"}
              </span>
              <div className="flex flex-col items-end">
                {interfaceEntries.map((entry, i) => (
                  <span key={i} className="text-[color:var(--text-primary)] truncate max-w-[170px]">
                    {entry.label}{entry.kind ? ` (${entry.kind})` : ""}
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
// Session Action Buttons - play, pause, leave
// ============================================================================

export interface SessionActionButtonsProps {
  /** Whether the session is actively streaming (running or paused) */
  isStreaming: boolean;
  /** Whether the session is paused */
  isPaused?: boolean;
  /** Whether the session is stopped but can be resumed */
  isStopped?: boolean;
  /** Whether the IO source supports time range filtering (shows bookmark button) */
  supportsTimeRange?: boolean;
  /** Whether we have an active source (enables Leave button) */
  hasSource?: boolean;
  /** Whether we're in capture mode (affects leave tooltip) */
  isCaptureMode?: boolean;
  /** Play/resume the session */
  onPlay?: () => void;
  /** Pause the session */
  onPause?: () => void;
  /** Leave the session */
  onLeave?: () => void;
  /** Open bookmark picker (for time range sources) */
  onOpenBookmarkPicker?: () => void;
}

export function SessionActionButtons({
  isStreaming,
  isPaused = false,
  isStopped = false,
  supportsTimeRange = false,
  hasSource = false,
  isCaptureMode = false,
  onPlay,
  onPause,
  onLeave,
  onOpenBookmarkPicker,
}: SessionActionButtonsProps) {
  // Show Play when paused or stopped
  const showPlay = (isPaused || isStopped) && onPlay;
  // Show Pause when running (streaming but not paused)
  const showPause = isStreaming && !isPaused && onPause;

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

      {/* Play button - shown when paused or stopped */}
      {showPlay && (
        <button
          onClick={onPlay}
          className={successIconButton}
          title={isStopped ? "Resume IO stream" : "Play"}
        >
          <Play className={iconSm} />
        </button>
      )}

      {/* Pause button - shown when running */}
      {showPause && (
        <button
          onClick={onPause}
          className={buttonBase}
          title="Pause"
        >
          <Pause className={iconSm} />
        </button>
      )}

      {/* Leave button - always shown when a source is connected */}
      {hasSource && onLeave && (
        <button
          onClick={onLeave}
          className={warningButtonBase}
          title={isCaptureMode ? "Disconnect" : "Stop & review capture"}
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
  /** Capture metadata (for capture display name) */
  captureMetadata?: CaptureMetadata | null;
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
  /** Bus-to-source mapping for multi-bus tooltip display */
  outputBusToSource?: Map<number, BusSourceInfo>;
  /** Click handler to open session picker */
  onOpenIoSessionPicker: () => void;

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
  /** Whether the session is paused */
  isPaused?: boolean;
  /** Whether the session is stopped but can be resumed */
  isStopped?: boolean;
  /** Whether the IO source supports time range filtering */
  supportsTimeRange?: boolean;
  /** Play/resume the session */
  onPlay?: () => void;
  /** Pause the session */
  onPause?: () => void;
  /** Leave the session */
  onLeave?: () => void;
  /** Open bookmark picker (for time range sources) */
  onOpenBookmarkPicker?: () => void;

  // Capture action props (shown when capture metadata is available)
  /** Whether the session is in capture replay mode (viewing stored capture data) */
  isCaptureMode?: boolean;
  /** Whether the current capture is persistent (pinned) */
  capturePersistent?: boolean;
  /** Called when user toggles capture pin */
  onToggleCapturePin?: () => void;
  /** Called when user renames the capture */
  onRenameCapture?: (newName: string) => void;

  // Clear capture props
  /** Called when user clicks the clear/trash button. If absent, button is hidden. */
  onClearCapture?: () => void;
  /** Whether the app has data that can be cleared (controls disabled state) */
  hasData?: boolean;
}

/**
 * Combined IO session controls component.
 * Includes reader button, speed picker button, and session action buttons (play/pause/leave/bookmark).
 * Use this instead of separate SessionButton + SessionActionButtons for consistent layout.
 */
export function IOSessionControls({
  // Reader props
  ioProfile,
  ioProfiles,
  multiBusProfiles = [],
  captureMetadata,
  defaultReadProfileId,
  sessionId,
  ioState,
  frameCount,
  totalFrameCount,
  outputBusToSource,
  onOpenIoSessionPicker,
  // Speed props
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  // Session action props
  isStreaming,
  isPaused = false,
  isStopped = false,
  supportsTimeRange = false,
  onPlay,
  onPause,
  onLeave,
  onOpenBookmarkPicker,
  // Capture action props
  isCaptureMode: isCaptureModeProp,
  capturePersistent = false,
  onToggleCapturePin,
  onRenameCapture,
  // Clear capture props
  onClearCapture,
  hasData = false,
}: IOSessionControlsProps) {
  const isCaptureMode = isCaptureModeProp ?? isCaptureProfileId(ioProfile);
  const hasSource = ioProfile !== null;

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
    setRenameValue(captureMetadata?.name || ioProfile || "");
    setIsRenaming(true);
  };

  const commitRename = () => {
    if (!isRenaming) return; // Guard against double-fire from blur after Enter/Escape
    const trimmed = renameValue.trim();
    const currentName = captureMetadata?.name || "";
    if (trimmed && trimmed !== currentName && onRenameCapture) {
      onRenameCapture(trimmed);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setIsRenaming(false);
  };

  return (
    <>
      {/* IO Session Selection */}
      <SessionButton
        ioProfile={ioProfile}
        ioProfiles={ioProfiles}
        multiBusProfiles={multiBusProfiles}
        captureMetadata={captureMetadata}
        defaultReadProfileId={defaultReadProfileId}
        sessionId={sessionId}
        ioState={ioState}
        frameCount={frameCount}
        totalFrameCount={totalFrameCount}
        outputBusToSource={outputBusToSource}
        onClick={onOpenIoSessionPicker}
        disabled={isStreaming && !isCaptureMode}
        isCaptureMode={isCaptureMode}
      />

      {/* Capture actions - pin and rename (shown when capture metadata is available) */}
      {captureMetadata?.id && (
        <div className="relative flex items-center gap-0.5">
          {onRenameCapture && (
            <button
              onClick={startRename}
              className="p-1 rounded transition-colors hover:bg-[var(--hover-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
              title="Rename capture"
            >
              <Pencil className={iconXs} />
            </button>
          )}
          {onToggleCapturePin && (
            <button
              onClick={onToggleCapturePin}
              className={`p-1 rounded transition-colors hover:bg-[var(--hover-bg)] ${
                capturePersistent
                  ? "text-[color:var(--status-warning-text)]"
                  : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
              }`}
              title={capturePersistent ? "Unpin capture (will be cleared on restart)" : "Pin capture (survives restart)"}
            >
              {capturePersistent ? <Pin className={iconXs} /> : <PinOff className={iconXs} />}
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
                placeholder="Capture name"
              />
            </div>
          )}
        </div>
      )}

      {/* Clear capture button — hidden for persistent captures */}
      {onClearCapture && ioProfile && !(isCaptureMode && capturePersistent) && (
        <button
          onClick={onClearCapture}
          disabled={!hasData}
          className="p-1 rounded transition-colors hover:bg-[var(--hover-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] enabled:hover:!bg-red-600 enabled:hover:!text-white disabled:opacity-30 disabled:cursor-not-allowed"
          title={isCaptureMode ? "Delete capture" : "Clear capture and start fresh"}
        >
          <Trash2 className={iconXs} />
        </button>
      )}

      {/* Speed button - always visible when source connected, greyed out for realtime */}
      {hasSource && onOpenSpeedPicker && (
        <button
          onClick={supportsSpeed ? onOpenSpeedPicker : undefined}
          disabled={!supportsSpeed}
          className={`${buttonBase} ${!supportsSpeed ? "opacity-40 cursor-default" : ""}`}
          title={supportsSpeed ? "Set playback speed" : "Speed control (available for captures)"}
        >
          <span>{speed === 0 ? "0x" : speed === 1 ? "1x" : `${speed}x`}</span>
        </button>
      )}

      {/* Session control buttons (play, pause, leave, bookmark) - always visible */}
      <SessionActionButtons
        isStreaming={isStreaming}
        isPaused={isPaused}
        isStopped={isStopped}
        supportsTimeRange={supportsTimeRange}
        hasSource={hasSource}
        isCaptureMode={isCaptureMode}
        onPlay={onPlay}
        onPause={onPause}
        onLeave={onLeave}
        onOpenBookmarkPicker={onOpenBookmarkPicker}
      />
    </>
  );
}
