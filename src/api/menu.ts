// ui/src/api/menu.ts
// Tauri API wrappers for native menu state management

import { invoke } from "@tauri-apps/api/core";

export interface MenuState {
  hasSession: boolean;
  profileName: string | null;
  isStreaming: boolean;
  isPaused: boolean;
  canPause: boolean;
  joinerCount: number;
  hasBookmarks: boolean;
}

export interface BookmarkMenuInfo {
  id: string;
  name: string;
}

/** Update all Session menu items based on the focused app's session state and capabilities. */
export async function updateMenuState(state: MenuState): Promise<void> {
  return invoke("update_menu_state", {
    hasSession: state.hasSession,
    profileName: state.profileName,
    isStreaming: state.isStreaming,
    isPaused: state.isPaused,
    canPause: state.canPause,
    joinerCount: state.joinerCount,
    hasBookmarks: state.hasBookmarks,
  });
}

/** Update the Bookmarks > Jump to Bookmark submenu with bookmarks for the current profile. */
export async function updateBookmarksMenu(bookmarks: BookmarkMenuInfo[]): Promise<void> {
  return invoke("update_bookmarks_menu", { bookmarks });
}
