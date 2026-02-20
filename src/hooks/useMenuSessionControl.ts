// ui/src/hooks/useMenuSessionControl.ts
// Centralised hook for session-control event handling and menu state reporting.
// Replaces duplicated patterns across Decoder, Discovery, Transmit, Query, and Graph.

import { useEffect, useRef } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useFocusStore } from "../stores/focusStore";
import {
  updateMenuSessionState,
  updateMenuFocusState,
  updateBookmarksMenu,
  type BookmarkMenuInfo,
} from "../api/menu";
import { getFavoritesForProfile } from "../utils/favorites";
import { isBufferProfileId } from "./useIOSessionManager";
import type { IOCapabilities } from "../api/io";

/** Callback map for session-control actions dispatched from the native menu. */
export interface SessionControlCallbacks {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onStopAll?: () => void;
  onClear?: () => void;
  onPicker?: () => void;
  onDetach?: () => void;
  onJumpToBookmark?: (bookmarkId: string) => Promise<void>;
  /** Called when "Save Bookmark…" is triggered from the menu. Discovery-specific. */
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
 * 1. Listening for `session-control` events and dispatching to callbacks
 * 2. Reporting session state to the native menu when focused
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
    updateMenuSessionState({
      profileName,
      isStreaming,
      isPaused,
      canPause: capabilities?.can_pause ?? false,
      joinerCount: joinerCount ?? 1,
    });

    // Update bookmark menu availability — only enable for timeline sources
    const bookmarksEnabled = !!bookmarks && capabilities?.is_realtime === false;
    updateMenuFocusState(true, bookmarksEnabled);
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
      if (profileId && !isBufferProfileId(profileId)) {
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

  // ── Session-control + bookmark-save event listeners (registered once) ──
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();

    const setupListeners = async () => {
      // Session control events from menu (only respond when targeted at this panel)
      const unlistenControl = await currentWindow.listen<{
        action: string;
        targetPanelId: string | null;
        windowLabel?: string;
        bookmarkId?: string;
      }>("session-control", async (event) => {
        const { action, targetPanelId, windowLabel, bookmarkId } =
          event.payload;
        if (windowLabel && windowLabel !== currentWindow.label) return;
        if (targetPanelId !== panelId) return;

        const { callbacks: cb } = stateRef.current;

        switch (action) {
          case "play":
            cb.onPlay?.();
            break;
          case "pause":
            cb.onPause?.();
            break;
          case "stop":
            cb.onStop?.();
            break;
          case "stopAll":
            cb.onStopAll?.();
            break;
          case "clear":
            cb.onClear?.();
            break;
          case "picker":
            cb.onPicker?.();
            break;
          case "detach":
            cb.onDetach?.();
            break;
          case "jump-to-bookmark":
            if (bookmarkId) await cb.onJumpToBookmark?.(bookmarkId);
            break;
        }
      });

      // Save bookmark event (broadcast to window, only respond when focused)
      const unlistenBookmark = await currentWindow.listen(
        "menu-bookmark-save",
        () => {
          const { isFocused: focused, callbacks: cb } = stateRef.current;
          if (focused) {
            cb.onBookmarkSave?.();
          }
        },
      );

      return () => {
        unlistenControl();
        unlistenBookmark();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, [panelId]);
}
