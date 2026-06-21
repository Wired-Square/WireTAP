// src/components/SessionControls.tsx
//
// Shared session control components for top bars.
// Renders a fixed-width session chip plus a kebab (⋮) menu holding the session
// details and all actions (play/pause, speed, bookmark, rename, pin, clear,
// disconnect). The chip width never changes as session state changes.

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Star, FileText, Play, Pause, Gauge, Bookmark, LogOut, Pencil, Pin, PinOff, Trash2, ArrowRightLeft, Power } from "lucide-react";
import { iconSm } from "../styles/spacing";
import type { IOProfile } from "../types/common";
import type { CaptureMetadata } from "../api/capture";
import type { BusSourceInfo } from "../utils/busFormat";
import { isCaptureProfileId } from "../hooks/useIOSessionManager";
import { buttonBase } from "../styles/buttonStyles";
import { menuClasses, menuItem, menuDivider } from "../styles/menuStyles";
import { getIOKindLabel } from "../utils/ioKindLabel";
import { destroyReaderSession } from "../api/io";

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
  /** Current IO state (running, stopped, paused, error) - drives the status dot */
  ioState?: string | null;
  /** Click handler (opens the session menu, or the picker when no source) */
  onClick: () => void;
  /** Ref forwarded to the underlying button (used as the menu anchor) */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Native tooltip text */
  title?: string;
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
  onClick,
  buttonRef,
  title,
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

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      className={buttonBase}
      title={title}
    >
      {/* Capture / default-reader type icon (no icon for multi-bus or plain sources) */}
      {isCaptureProfile ? (
        <FileText className={`${iconSm} text-blue-500 flex-shrink-0`} />
      ) : isDefaultReader ? (
        <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
      ) : null}
      {statusColour && (
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColour}`} />
      )}
      <span className="max-w-40 truncate">{displayName}</span>
      {sessionId && !sessionIdInDisplayName && (
        <span className="text-[color:var(--text-muted)] text-xs font-mono">{sessionId}</span>
      )}
    </button>
  );
}

// ============================================================================
// Session details - derives the rows shown at the top of the kebab menu
// ============================================================================

interface SessionDetails {
  statusLabel: { label: string; colour: string } | null;
  typeLabel: string;
  interfaceEntries: { label: string; kind: string }[];
}

function getSessionDetails({
  ioProfile,
  ioProfiles,
  multiBusProfiles,
  ioState,
  outputBusToSource,
  isCaptureMode,
}: {
  ioProfile: string | null;
  ioProfiles: IOProfile[];
  multiBusProfiles: string[];
  ioState?: string | null;
  outputBusToSource?: Map<number, BusSourceInfo>;
  isCaptureMode: boolean;
}): SessionDetails {
  const selectedProfile = ioProfiles.find((p) => p.id === ioProfile);
  const showAsMultiBus = !isCaptureMode && multiBusProfiles.length > 0;

  let statusLabel: SessionDetails["statusLabel"] = null;
  if (ioState && ioProfile) {
    if (ioState === "running")       statusLabel = { label: "Running",  colour: "text-[color:var(--status-success-text)]" };
    else if (ioState === "paused")   statusLabel = { label: "Paused",   colour: "text-[color:var(--status-warning-text)]" };
    else if (ioState === "stopped")  statusLabel = { label: "Stopped",  colour: "text-[color:var(--text-muted)]" };
    else if (ioState === "starting") statusLabel = { label: "Starting", colour: "text-[color:var(--status-info-text)]" };
    else if (ioState.startsWith("Error")) statusLabel = { label: ioState, colour: "text-[color:var(--status-danger-text)]" };
    else statusLabel = { label: ioState, colour: "text-[color:var(--text-secondary)]" };
  }

  let typeLabel: string;
  if (isCaptureMode) typeLabel = "Capture";
  else if (showAsMultiBus) typeLabel = "Realtime";
  else if (selectedProfile?.kind) typeLabel = getIOKindLabel(selectedProfile.kind);
  else typeLabel = "Unknown";

  let interfaceEntries: SessionDetails["interfaceEntries"] = [];
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

  return { statusLabel, typeLabel, interfaceEntries };
}

// ============================================================================
// IO Session Controls - session chip + kebab menu (details + all actions)
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
  /** Number of unique frame IDs (shown in menu details) */
  frameCount?: number;
  /** Total number of frames seen (shown in menu details when available) */
  totalFrameCount?: number;
  /** Bus-to-source mapping for multi-bus details display */
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
  /** Called when user clicks clear/delete. If absent, item is hidden. */
  onClearCapture?: () => void;
  /** Whether the app has data that can be cleared (controls disabled state) */
  hasData?: boolean;
}

/**
 * Combined IO session controls: a fixed-width session chip plus a kebab (⋮)
 * menu. The chip opens the session picker; the kebab holds the session details
 * and every action (play/pause, speed, bookmark, rename, pin, clear, disconnect).
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
  const { t } = useTranslation("common");
  const isCaptureMode = isCaptureModeProp ?? isCaptureProfileId(ioProfile);
  const hasSource = ioProfile !== null;

  // --- Rename popover state ---
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

  const cancelRename = () => setIsRenaming(false);

  // --- Kebab menu state (click-to-open, portal-rendered, viewport-clamped) ---
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRectRef = useRef<DOMRect | null>(null);

  const handleButtonClick = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    if (buttonRef.current) {
      buttonRectRef.current = buttonRef.current.getBoundingClientRect();
      setMenuStyle({ visibility: "hidden" }); // reset until measured
    }
    setMenuOpen(true);
  }, [menuOpen]);

  // Close on any click outside the button or the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [menuOpen]);

  // After the portal menu mounts, measure it and position within the viewport.
  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current || !buttonRectRef.current) return;
    const menu = menuRef.current;
    const btnRect = buttonRectRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const gap = 2;

    // Vertical: prefer below button, flip above if it won't fit
    let top = btnRect.bottom + gap;
    if (top + mh > vh) top = btnRect.top - gap - mh;
    top = Math.max(4, Math.min(top, vh - mh - 4));

    // Horizontal: align left edge to button left edge, clamp to viewport
    let left = btnRect.left;
    if (left + mw > vw - 4) left = vw - 4 - mw;
    if (left < 4) left = 4;

    setMenuStyle({ top, left, visibility: "visible" });
  }, [menuOpen]);

  /** Run a menu action then dismiss the menu. */
  const runAndClose = (fn?: () => void) => () => {
    fn?.();
    setMenuOpen(false);
  };

  // --- Details + action visibility ---
  const { statusLabel, typeLabel, interfaceEntries } = getSessionDetails({
    ioProfile,
    ioProfiles,
    multiBusProfiles,
    ioState,
    outputBusToSource,
    isCaptureMode,
  });

  const showPlay = (isPaused || isStopped) && !!onPlay;
  const showPause = isStreaming && !isPaused && !!onPause;
  const showSpeed = hasSource && !!onOpenSpeedPicker;
  const showBookmark = supportsTimeRange && !!onOpenBookmarkPicker;
  const showRename = !!captureMetadata?.id && !!onRenameCapture;
  const showPin = !!captureMetadata?.id && !!onToggleCapturePin;
  const showClear = !!onClearCapture && !!ioProfile && !(isCaptureMode && capturePersistent);
  const showLeave = hasSource && !!onLeave;
  const changeSourceDisabled = isStreaming && !isCaptureMode;
  // Backend session id for the hard-reset action (effective id, falling back to profile).
  const destroyId = sessionId ?? ioProfile;

  const speedLabel = speed === 1 ? "1x" : `${speed}x`;
  const detailRow = "flex items-center justify-between gap-3 mb-1";
  const detailKey = "text-[color:var(--text-muted)]";
  const detailVal = "font-medium text-[color:var(--text-primary)]";

  return (
    <div className="relative shrink-0">
      {/* Session chip — click opens the session menu (or the picker when no source) */}
      <SessionButton
        ioProfile={ioProfile}
        ioProfiles={ioProfiles}
        multiBusProfiles={multiBusProfiles}
        captureMetadata={captureMetadata}
        defaultReadProfileId={defaultReadProfileId}
        sessionId={sessionId}
        ioState={ioState}
        onClick={hasSource ? handleButtonClick : onOpenIoSessionPicker}
        buttonRef={buttonRef}
        title={hasSource ? "Session menu" : "Select source"}
        isCaptureMode={isCaptureMode}
      />

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
            placeholder={t("session.captureName")}
          />
        </div>
      )}

      {/* Dropdown menu — rendered in a portal to escape overflow clipping */}
      {menuOpen && createPortal(
        <div ref={menuRef} className={`${menuClasses} max-w-[280px]`} style={menuStyle}>
          {/* Details */}
          <div className="px-3 py-2 text-xs cursor-default">
            {statusLabel && (
              <div className={detailRow}>
                <span className={detailKey}>State</span>
                <span className={`font-medium ${statusLabel.colour}`}>{statusLabel.label}</span>
              </div>
            )}
            <div className={detailRow}>
              <span className={detailKey}>Type</span>
              <span className={detailVal}>{typeLabel}</span>
            </div>
            {captureMetadata?.id && (
              <div className={detailRow}>
                <span className={detailKey}>Capture</span>
                <span className={`${detailVal} truncate max-w-[160px]`}>
                  {captureMetadata.name || captureMetadata.id}
                </span>
              </div>
            )}
            {totalFrameCount != null && (
              <div className={detailRow}>
                <span className={detailKey}>Frames</span>
                <span className={detailVal}>{totalFrameCount.toLocaleString()}</span>
              </div>
            )}
            {frameCount != null && (
              <div className={detailRow}>
                <span className={detailKey}>{totalFrameCount != null ? "Unique" : "Frames"}</span>
                <span className={detailVal}>{frameCount.toLocaleString()}</span>
              </div>
            )}
            {interfaceEntries.length > 0 && (
              <div className="flex items-start justify-between gap-3 mt-1 pt-1 border-t border-[color:var(--border-default)]">
                <span className={`${detailKey} shrink-0`}>
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

          <div className={menuDivider} />

          {/* Change source */}
          <button
            onClick={runAndClose(onOpenIoSessionPicker)}
            disabled={changeSourceDisabled}
            className={menuItem}
            title={changeSourceDisabled ? "Pause or disconnect to change source" : undefined}
          >
            <ArrowRightLeft className={iconSm} />
            Change source
          </button>

          {/* Playback / capture actions */}
          {showPlay && (
            <button onClick={runAndClose(onPlay)} className={menuItem}>
              <Play className={iconSm} />
              {isStopped ? t("session.resumeIo") : t("playback.play")}
            </button>
          )}
          {showPause && (
            <button onClick={runAndClose(onPause)} className={menuItem}>
              <Pause className={iconSm} />
              {t("playback.pause")}
            </button>
          )}
          {showSpeed && (
            <button
              onClick={supportsSpeed ? runAndClose(onOpenSpeedPicker) : undefined}
              disabled={!supportsSpeed}
              className={menuItem}
              title={supportsSpeed ? undefined : "Speed control (available for captures)"}
            >
              <Gauge className={iconSm} />
              <span className="flex-1 text-left">Speed</span>
              <span className="text-[color:var(--text-muted)]">{speedLabel}</span>
            </button>
          )}
          {showBookmark && (
            <button onClick={runAndClose(onOpenBookmarkPicker)} className={menuItem}>
              <Bookmark className={iconSm} />
              {t("session.loadBookmark")}
            </button>
          )}
          {showRename && (
            <button onClick={() => { startRename(); setMenuOpen(false); }} className={menuItem}>
              <Pencil className={iconSm} />
              {t("session.renameCapture")}
            </button>
          )}
          {showPin && (
            <button onClick={runAndClose(onToggleCapturePin)} className={menuItem}>
              {capturePersistent ? <Pin className={iconSm} /> : <PinOff className={iconSm} />}
              {capturePersistent ? t("session.unpinCapture") : t("session.pinCapture")}
            </button>
          )}
          {showClear && (
            <button
              onClick={runAndClose(onClearCapture)}
              disabled={!hasData}
              className={`${menuItem} text-red-400 ${hasData ? "hover:!bg-red-500/10" : ""}`}
              title={isCaptureMode ? "Delete capture" : "Clear capture and start fresh"}
            >
              <Trash2 className={iconSm} />
              {isCaptureMode ? "Delete capture" : "Clear capture and start fresh"}
            </button>
          )}

          {/* Disconnect + hard reset */}
          {(showLeave || destroyId) && <div className={menuDivider} />}
          {showLeave && (
            <button onClick={runAndClose(onLeave)} className={`${menuItem} text-amber-500 hover:!bg-amber-500/10`}>
              <LogOut className={iconSm} />
              {isCaptureMode ? "Disconnect" : "Stop & review capture"}
            </button>
          )}
          {destroyId && (
            <button
              onClick={runAndClose(() => {
                // reset=true → backend marks the destroyed event so the app
                // resets to "No source" rather than the orphaned capture.
                destroyReaderSession(destroyId, true).catch(() => {});
              })}
              className={`${menuItem} text-red-400 hover:!bg-red-500/10`}
              title="Destroy this session in the backend and reset to No source"
            >
              <Power className={iconSm} />
              Destroy session
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
