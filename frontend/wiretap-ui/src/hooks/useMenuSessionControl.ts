// ui/src/hooks/useMenuSessionControl.ts
// Centralised hook for session-control event handling and menu state reporting.
// Replaces duplicated patterns across Decoder, Discovery, Transmit, Query, and Dashboard.
//
// Listens directly for native menu events (menu-session-*) — no MainLayout relay needed.
// Only the focused panel responds to each event.

import { useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useFocusStore } from "../stores/focusStore";
import { updateMenuState, updateEventsMenu } from "../api/menu";
import type { IOCapabilities } from "../api/io";
import type { CaptureEvent, EventOwner } from "../api/captureEvents";
import { eventLabel } from "../utils/captureEvents";
import { NO_EVENTS } from "./useCaptureEvents";

/** Callback map for session-control actions dispatched from the native menu. */
export interface SessionControlCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onStopAll?: () => void;
  onClear?: () => void;
  onPicker?: () => void;
  onImportFromFile?: () => void;
  onLeave?: () => void;
  onJumpToEvent?: (eventId: string) => Promise<void> | void;
  /** Called when "Add Event…" is triggered from the menu. */
  onEventAdd?: () => void;
}

/** Session state values reported to the native menu for enable/disable logic. */
export interface MenuReportState {
  profileName: string | null;
  isStreaming: boolean;
  isPaused: boolean;
  capabilities: IOCapabilities | null;
  joinerCount: number;
}

/** Optional events support configuration. */
export interface EventsMenuConfig {
  /** Who holds the session's events; null disables the Events menu. */
  owner: EventOwner | null;
  /** Listed under Jump to Event when the session can seek or re-window. */
  events: CaptureEvent[];
}

export interface UseMenuSessionControlOptions {
  /** Panel ID this hook is associated with (e.g. "decoder", "dashboard"). */
  panelId: string;
  /** Current session state — reported to the native menu when this panel is focused. */
  sessionState: MenuReportState;
  /** Callbacks for session-control actions from the menu. */
  callbacks: SessionControlCallbacks;
  /** If provided, the Events menu is enabled and populated when this panel is focused. */
  events?: EventsMenuConfig;
}

/**
 * Centralised hook that handles:
 * 1. Reporting session state to the native menu when focused
 * 2. Listening for native menu events and dispatching to callbacks
 * 3. Reporting events to the native menu when focused (optional)
 *
 * Uses a single ref updated every render to avoid stale closures —
 * the event listener is registered once and reads from the ref.
 */
export function useMenuSessionControl({
  panelId,
  sessionState,
  callbacks,
  events,
}: UseMenuSessionControlOptions) {
  const isFocused = useFocusStore((s) => s.focusedPanelId === panelId);

  // Single ref holding all mutable state — updated every render, read by event handlers
  const stateRef = useRef({ sessionState, callbacks, isFocused });
  stateRef.current = { sessionState, callbacks, isFocused };
  const hasEvents = !!events?.owner;

  // ── Menu state reporting (when focused) ──
  useEffect(() => {
    if (!isFocused) return;
    const { profileName, isStreaming, isPaused, capabilities, joinerCount } =
      sessionState;

    // Show "Capture" instead of the original device name when in capture replay mode
    const effectiveProfileName =
      capabilities?.traits.temporal_mode === "capture" ? "Capture" : profileName;

    updateMenuState({
      hasSession: true,
      profileName: effectiveProfileName,
      isStreaming,
      isPaused,
      canPause: capabilities?.can_pause ?? false,
      joinerCount: joinerCount ?? 1,
      hasEvents,
    });
  }, [
    isFocused,
    sessionState.profileName,
    sessionState.isStreaming,
    sessionState.isPaused,
    sessionState.capabilities,
    sessionState.joinerCount,
    hasEvents,
  ]);

  // ── Jump to Event submenu (when focused) ──
  const menuEvents = events?.events ?? NO_EVENTS;
  const canJump = !!sessionState.capabilities?.supports_seek || !!sessionState.capabilities?.supports_time_range;
  useEffect(() => {
    if (!isFocused) return;
    updateEventsMenu(canJump ? menuEvents.map((e) => ({ id: e.id, label: eventLabel(e) })) : []);
  }, [isFocused, canJump, menuEvents]);

  // ── Native menu event listeners (registered once) ──
  // Each listener checks isFocused so only the active panel responds.
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();

    const setupListeners = async () => {
      const guard = () => stateRef.current.isFocused;
      const cb = () => stateRef.current.callbacks;

      const unPlay = await currentWindow.listen("menu-session-play", () => {
        if (guard()) cb().onPlay?.();
      });
      const unPause = await currentWindow.listen("menu-session-pause", () => {
        if (guard()) cb().onPause?.();
      });
      const unStop = await currentWindow.listen("menu-session-stop", () => {
        if (guard()) cb().onStop?.();
      });
      const unDetach = await currentWindow.listen("menu-session-detach", () => {
        if (guard()) cb().onLeave?.();
      });
      const unStopAll = await currentWindow.listen("menu-session-stop-all", () => {
        if (guard()) cb().onStopAll?.();
      });
      const unClear = await currentWindow.listen("menu-session-clear", () => {
        if (guard()) cb().onClear?.();
      });
      const unPicker = await currentWindow.listen("menu-session-picker", () => {
        if (guard()) cb().onPicker?.();
      });
      const unImportFile = await currentWindow.listen("menu-session-import-file", () => {
        if (guard()) cb().onImportFromFile?.();
      });
      const unJump = await currentWindow.listen<string>("menu-jump-to-event", async (event) => {
        if (guard() && event.payload) {
          await cb().onJumpToEvent?.(event.payload);
        }
      });
      const unAdd = await currentWindow.listen("menu-event-add", () => {
        if (guard()) cb().onEventAdd?.();
      });

      return () => {
        unPlay();
        unPause();
        unStop();
        unDetach();
        unStopAll();
        unClear();
        unPicker();
        unImportFile();
        unJump();
        unAdd();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, []);
}
