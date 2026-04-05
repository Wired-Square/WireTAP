// ui/src/hooks/useMenuSessionControl.ts
// Centralised hook for session-control event handling and menu state reporting.
// Replaces duplicated patterns across Decoder, Discovery, Transmit, Query, and Graph.
//
// Listens directly for native menu events (menu-session-*) — no MainLayout relay needed.
// Only the focused panel responds to each event.

import { useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useFocusStore } from "../stores/focusStore";
import {
  updateMenuState,
  updateBookmarksMenu,
  type BookmarkMenuInfo,
} from "../api/menu";
import { getFavoritesForProfile } from "../utils/favorites";
import { isCaptureProfileId } from "./useIOSessionManager";
import type { IOCapabilities } from "../api/io";

/** Callback map for session-control actions dispatched from the native menu. */
export interface SessionControlCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onStopAll?: () => void;
  onClear?: () => void;
  onPicker?: () => void;
  onLeave?: () => void;
  onJumpToBookmark?: (bookmarkId: string) => Promise<void>;
  /** Called when "Save Bookmark…" is triggered from the menu. */
  onBookmarkSave?: () => void;
}

/** Session state values reported to the native menu for enable/disable logic. */
export interface MenuReportState {
  profileName: string | null;
  isStreaming: boolean;
  isPaused: boolean;
  capabilities: IOCapabilities | null;
  joinerCount: number;
}

/** Optional bookmark support configuration. */
export interface BookmarkConfig {
  /** Profile ID used for bookmark lookups (sourceProfileId || ioProfile). */
  profileId: string | null;
}

export interface UseMenuSessionControlOptions {
  /** Panel ID this hook is associated with (e.g. "decoder", "graph"). */
  panelId: string;
  /** Current session state — reported to the native menu when this panel is focused. */
  sessionState: MenuReportState;
  /** Callbacks for session-control actions from the menu. */
  callbacks: SessionControlCallbacks;
  /** If provided, bookmark menu is populated when this panel is focused. */
  bookmarks?: BookmarkConfig;
}

/**
 * Centralised hook that handles:
 * 1. Reporting session state to the native menu when focused
 * 2. Listening for native menu events and dispatching to callbacks
 * 3. Reporting bookmarks to the native menu when focused (optional)
 *
 * Uses a single ref updated every render to avoid stale closures —
 * the event listener is registered once and reads from the ref.
 */
export function useMenuSessionControl({
  panelId,
  sessionState,
  callbacks,
  bookmarks,
}: UseMenuSessionControlOptions) {
  const isFocused = useFocusStore((s) => s.focusedPanelId === panelId);

  // Single ref holding all mutable state — updated every render, read by event handlers
  const stateRef = useRef({ sessionState, callbacks, bookmarks, isFocused });
  stateRef.current = { sessionState, callbacks, bookmarks, isFocused };

  // ── Menu state reporting (when focused) ──
  useEffect(() => {
    if (!isFocused) return;
    const { profileName, isStreaming, isPaused, capabilities, joinerCount } =
      sessionState;

    // Show "Capture" instead of the original device name when in capture replay mode
    const effectiveProfileName =
      capabilities?.traits.temporal_mode === "buffer" ? "Capture" : profileName;

    const bookmarksEnabled =
      !!bookmarks &&
      (capabilities?.traits.temporal_mode === "timeline" ||
        capabilities?.traits.temporal_mode === "buffer");

    updateMenuState({
      hasSession: true,
      profileName: effectiveProfileName,
      isStreaming,
      isPaused,
      canPause: capabilities?.can_pause ?? false,
      joinerCount: joinerCount ?? 1,
      hasBookmarks: bookmarksEnabled,
    });
  }, [
    isFocused,
    sessionState.profileName,
    sessionState.isStreaming,
    sessionState.isPaused,
    sessionState.capabilities,
    sessionState.joinerCount,
  ]);

  // ── Bookmark menu reporting (when focused) ──
  useEffect(() => {
    if (!isFocused || !bookmarks) return;
    const profileId = bookmarks.profileId;

    const update = async () => {
      if (profileId && !isCaptureProfileId(profileId)) {
        const favs = await getFavoritesForProfile(profileId);
        const items: BookmarkMenuInfo[] = favs.map((b) => ({
          id: b.id,
          name: b.name,
        }));
        await updateBookmarksMenu(items);
      } else {
        await updateBookmarksMenu([]);
      }
    };
    update();
  }, [isFocused, bookmarks?.profileId]);

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
      const unJump = await currentWindow.listen<string>("menu-jump-to-bookmark", async (event) => {
        if (guard() && event.payload) {
          await cb().onJumpToBookmark?.(event.payload);
        }
      });
      const unSave = await currentWindow.listen("menu-bookmark-save", () => {
        if (guard()) cb().onBookmarkSave?.();
      });

      return () => {
        unPlay();
        unPause();
        unStop();
        unDetach();
        unStopAll();
        unClear();
        unPicker();
        unJump();
        unSave();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, []);
}
