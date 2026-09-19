// src/components/SessionControls.tsx
//
// Shared session control components for top bars.
// Renders a fixed-width session chip plus a kebab (⋮) menu holding the session
// details and all actions (play/pause, speed, bookmark, rename, pin, clear,
// disconnect). The chip width never changes as session state changes.

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Star, FileText, Play, Pause, Gauge, Bookmark, LogOut, Pencil, Pin, PinOff, Trash2, ArrowRightLeft, Power, Square, Settings2 } from "lucide-react";
import { iconSm, roundedDefault } from "../styles/spacing";
import type { IOProfile } from "../types/common";
import type { CaptureMetadata } from "../api/capture";
import type { BusSourceInfo } from "../utils/busFormat";
import { isCaptureProfileId } from "../hooks/useIOSessionManager";
import { getIOKindLabel } from "../utils/ioKindLabel";
import { useSessionStore } from "../stores/sessionStore";
import { useDeviceEditorStore } from "../stores/deviceEditorStore";
import { Button } from "./Button";
import { Input } from "./forms";
import { Menu, MenuItem, MenuSeparator, Popover, usePopover } from "./Menu";

// ============================================================================
// Activity dot - status dot that emits a sonar ripple whose cadence scales with
// the live frame-arrival rate (faster frames -> faster ripples; static when the
// session isn't running or the bus goes quiet).
// ============================================================================

/** Map a smoothed frames/sec rate to a ripple period (ms). Log-scaled because CAN
 *  rates span ~10-10000 fps; returns 0 when too slow to bother animating. */
function ripplePeriodMs(rate: number): number {
  const MIN = 3, MAX = 3000, SLOW = 1300, FAST = 320;
  if (rate < MIN) return 0;
  const t = Math.min(1, (Math.log(rate) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN)));
  return SLOW + (FAST - SLOW) * t;
}

interface ActivityDotProps {
  sessionId?: string | null;
  /** Colour class(es) for the dot (carries animate-pulse for "starting"). */
  colourClass: string;
  /** Only ripple while the session is actively streaming. */
  active: boolean;
}

/** Status dot with a frame-rate-scaled sonar ripple. Isolated so only it re-renders
 *  as the live frame count ticks — not the whole SessionButton. */
function ActivityDot({ sessionId, colourClass, active }: ActivityDotProps) {
  const frameCount = useSessionStore((s) =>
    sessionId ? (s.sessions[sessionId]?.frameCount ?? 0) : 0,
  );

  const [periodMs, setPeriodMs] = useState(0);
  const prevCountRef = useRef(frameCount);
  const prevTimeRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      setPeriodMs(0);
      prevTimeRef.current = 0;
      return;
    }

    const now = performance.now();
    const delta = frameCount - prevCountRef.current;
    prevCountRef.current = frameCount;
    // Skip the first sample after going active (no prior timestamp to rate against).
    if (prevTimeRef.current && delta > 0) {
      setPeriodMs(ripplePeriodMs(delta / ((now - prevTimeRef.current) / 1000)));
    }
    prevTimeRef.current = now;

    // Re-arm idle decay: if no further frames arrive, stop rippling.
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setPeriodMs(0), 1500);
    return () => clearTimeout(idleTimerRef.current ?? undefined);
  }, [frameCount, active]);

  if (!active || periodMs <= 0) {
    return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${colourClass}`} />;
  }

  return (
    <span className="relative inline-flex flex-shrink-0 w-2 h-2">
      <span
        className={`activity-ripple absolute inset-0 rounded-full ${colourClass}`}
        style={{ animationDuration: `${periodMs}ms` }}
      />
      <span className={`relative w-2 h-2 rounded-full ${colourClass}`} />
    </span>
  );
}

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
  } else if (sessionId) {
    // A joined session the store has let go of names itself while it streams.
    displayName = sessionId;
    sessionIdInDisplayName = true;
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
    <Button
      ref={buttonRef}
      onClick={onClick}
      title={title}
    >
      {/* Capture / default-reader type icon (no icon for multi-bus or plain sources) */}
      {isCaptureProfile ? (
        <FileText className={`${iconSm} text-blue-500 flex-shrink-0`} />
      ) : isDefaultReader ? (
        <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
      ) : null}
      {statusColour && (
        <ActivityDot sessionId={sessionId} colourClass={statusColour} active={ioState === "running"} />
      )}
      <span className="max-w-40 truncate">{displayName}</span>
      {sessionId && !sessionIdInDisplayName && (
        <span className="text-[color:var(--text-muted)] text-xs font-mono">{sessionId}</span>
      )}
    </Button>
  );
}

// ============================================================================
// Session details - derives the rows shown at the top of the kebab menu
// ============================================================================

interface SessionDetails {
  statusLabel: { label: string; colour: string } | null;
  typeLabel: string;
  interfaceEntries: { label: string; kind: string; profileId: string }[];
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
        const profile = ioProfiles.find((p) => p.id === info.profileId);
        return {
          label: `bus${bus}: ${info.profileName}`,
          kind: profile?.kind ? getIOKindLabel(profile.kind) : "",
          profileId: info.profileId,
        };
      });
  } else if (selectedProfile) {
    const kind = selectedProfile.kind ? getIOKindLabel(selectedProfile.kind) : "";
    interfaceEntries = [
      { label: selectedProfile.name, kind, profileId: selectedProfile.id },
    ];
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
  /** Leave the session — this app detaches and reviews a capture snapshot; others keep streaming. */
  onLeave?: () => void;
  /** Stop the shared session — ALL connected apps switch to reviewing the capture. */
  onStop?: () => void;
  /** Destroy the session — ALL connected apps return to "No source". */
  onDestroy?: () => void;
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
  onStop,
  onDestroy,
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
    if (!isRenaming) return;
    const trimmed = renameValue.trim();
    const currentName = captureMetadata?.name || "";
    if (trimmed && trimmed !== currentName && onRenameCapture) {
      onRenameCapture(trimmed);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => setIsRenaming(false);

  const menu = usePopover();
  // Reconfiguring a device is app-agnostic — the backend does the work — so the
  // menu opens the shared dialog directly rather than routing through the app.
  const openDeviceSettings = useDeviceEditorStore((s) => s.open);

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
  const showStop = hasSource && !isCaptureMode && !!onStop;
  const showDestroy = hasSource && !!onDestroy;
  const changeSourceDisabled = isStreaming && !isCaptureMode;

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
        onClick={hasSource ? menu.toggle : onOpenIoSessionPicker}
        buttonRef={menu.trigger.ref}
        title={hasSource ? "Session menu" : "Select source"}
        isCaptureMode={isCaptureMode}
      />

      {/* Rename popover: a click outside commits, as a blur did; Escape cancels */}
      <Popover open={isRenaming} onClose={commitRename} anchorRef={menu.trigger.ref} className="p-2">
        <Input
          ref={renameInputRef}
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          className="w-48"
          placeholder={t("session.captureName")}
        />
      </Popover>

      <Menu {...menu.popover} className="max-w-[280px]">
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
                <span className={`${detailKey} shrink-0 pt-1`}>
                  {interfaceEntries.length > 1 ? "Interfaces" : "Interface"}
                </span>
                <div className="flex flex-col items-stretch gap-0.5 min-w-0">
                  {/* Each interface opens its own settings, so a multi-bus
                      session needs no "which device?" step. */}
                  {interfaceEntries.map((entry) => (
                    <button
                      key={entry.profileId}
                      onClick={() => {
                        menu.close();
                        openDeviceSettings(entry.profileId, isStreaming ? sessionId ?? null : null);
                      }}
                      title={t("session.interfaceSettings", { name: entry.label })}
                      className={`group flex items-center gap-1.5 justify-end -mr-1.5 px-1.5 py-1 ${roundedDefault} hover:bg-[var(--hover-bg)] transition-colors text-right`}
                    >
                      <span className="text-[color:var(--text-primary)] truncate max-w-[170px]">
                        {entry.label}
                        {entry.kind ? ` (${entry.kind})` : ""}
                      </span>
                      <Settings2
                        className={`${iconSm} shrink-0 text-[color:var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity`}
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <MenuSeparator />

          {/* Change source */}
          <MenuItem
            onClick={onOpenIoSessionPicker}
            disabled={changeSourceDisabled}
            icon={<ArrowRightLeft />}
            title={changeSourceDisabled ? "Pause or disconnect to change source" : undefined}
          >
            Change source
          </MenuItem>

          {/* Playback / capture actions */}
          {showPlay && (
            <MenuItem onClick={onPlay} icon={<Play />}>
              {isStopped ? t("session.resumeIo") : t("playback.play")}
            </MenuItem>
          )}
          {showPause && (
            <MenuItem onClick={onPause} icon={<Pause />}>
              {t("playback.pause")}
            </MenuItem>
          )}
          {showSpeed && (
            <MenuItem
              onClick={onOpenSpeedPicker}
              disabled={!supportsSpeed}
              icon={<Gauge />}
              title={supportsSpeed ? undefined : "Speed control (available for captures)"}
            >
              <span className="flex-1">Speed</span>
              <span className="text-[color:var(--text-muted)]">{speedLabel}</span>
            </MenuItem>
          )}
          {showBookmark && (
            <MenuItem onClick={onOpenBookmarkPicker} icon={<Bookmark />}>
              {t("session.loadBookmark")}
            </MenuItem>
          )}
          {showRename && (
            <MenuItem onClick={startRename} icon={<Pencil />}>
              {t("session.renameCapture")}
            </MenuItem>
          )}
          {showPin && (
            <MenuItem onClick={onToggleCapturePin} icon={capturePersistent ? <Pin /> : <PinOff />}>
              {capturePersistent ? t("session.unpinCapture") : t("session.pinCapture")}
            </MenuItem>
          )}
          {showClear && (
            <MenuItem
              onClick={onClearCapture}
              disabled={!hasData}
              tone="danger"
              icon={<Trash2 />}
              title={isCaptureMode ? "Delete capture" : "Clear capture and start fresh"}
            >
              {isCaptureMode ? "Delete capture" : "Clear capture and start fresh"}
            </MenuItem>
          )}

          {/* Exit controls: Leave (this app) / Stop (all apps) / Destroy (all apps) */}
          {(showLeave || showStop || showDestroy) && <MenuSeparator />}
          {showLeave && (
            <MenuItem onClick={onLeave} tone="warning" icon={<LogOut />}>
              {isCaptureMode ? "Disconnect" : "Leave session"}
            </MenuItem>
          )}
          {showStop && (
            <MenuItem
              onClick={onStop}
              tone="warning"
              icon={<Square />}
              title="Stop the session for all connected apps and review the capture"
            >
              Stop session
            </MenuItem>
          )}
          {showDestroy && (
            <MenuItem
              onClick={onDestroy}
              tone="danger"
              icon={<Power />}
              title="Destroy this session and reset all connected apps to No source"
            >
              Destroy session
            </MenuItem>
          )}
      </Menu>
    </div>
  );
}
