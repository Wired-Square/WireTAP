// ui/src/api/menu.ts
// Tauri API wrappers for native menu state management

import { invoke } from "@tauri-apps/api/core";

export interface MenuSessionState {
  profileName: string | null;
  isStreaming: boolean;
  isPaused: boolean;
  canPause: boolean;
  joinerCount: number;
}

export interface BookmarkMenuInfo {
  id: string;
  name: string;
}

/** Update Session menu item enabled states based on the focused app's session state. */
export async function updateMenuSessionState(state: MenuSessionState): Promise<void> {
  return invoke("update_menu_session_state", {
    profileName: state.profileName,
    isStreaming: state.isStreaming,
    isPaused: state.isPaused,
    canPause: state.canPause,
    joinerCount: state.joinerCount,
  });
}

/** Update the Bookmarks > Jump to Bookmark submenu with bookmarks for the current profile. */
export async function updateBookmarksMenu(bookmarks: BookmarkMenuInfo[]): Promise<void> {
  return invoke("update_bookmarks_menu", { bookmarks });
}

/** Update menu item availability based on whether the focused app supports sessions/bookmarks. */
export async function updateMenuFocusState(hasSession: boolean, hasBookmarks: boolean): Promise<void> {
  return invoke("update_menu_focus_state", { hasSession, hasBookmarks });
}
