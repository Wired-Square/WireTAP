// ui/src/api/menu.ts
// Tauri API wrappers for native menu state management

import { invoke } from "@tauri-apps/api/core";
import type { NativeMenuLabels } from "../generated/NativeMenuLabels";

export interface MenuState {
  hasSession: boolean;
  profileName: string | null;
  isStreaming: boolean;
  isPaused: boolean;
  canPause: boolean;
  joinerCount: number;
  hasEvents: boolean;
}

export interface EventMenuInfo {
  id: string;
  label: string;
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
    hasEvents: state.hasEvents,
  });
}

/** Update the Events > Jump to Event submenu with the focused session's events. */
export async function updateEventsMenu(events: EventMenuInfo[]): Promise<void> {
  return invoke("update_events_menu", { events });
}

/** Relabel the native menu bar in the frontend's language. */
export async function setNativeMenuLabels(labels: NativeMenuLabels): Promise<void> {
  return invoke("set_native_menu_labels", { labels });
}
