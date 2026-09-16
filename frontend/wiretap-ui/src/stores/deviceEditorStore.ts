// src/stores/deviceEditorStore.ts
//
// Which device the user is reconfiguring, if any.
//
// A global store rather than props because the asking and the answering are far
// apart: the session menu lives behind six app top bars, and the editor is
// hosted once at the app root. It holds only the request — the backend's
// `reconfigure_device` does the work, so nothing app-specific has to travel
// with it.
//
// The device is named by id, not passed by value: the dialog resolves it from
// the live profile list, so it always edits what the device is now rather than
// a copy taken when the menu was opened.

import { create } from "zustand";

export interface DeviceEditRequest {
  profileId: string;
  /** The live session to reconnect, if the device is streaming. */
  sessionId: string | null;
}

interface DeviceEditorState {
  request: DeviceEditRequest | null;
  /** Open the device settings dialog. */
  open: (profileId: string, sessionId?: string | null) => void;
  close: () => void;
}

export const useDeviceEditorStore = create<DeviceEditorState>((set) => ({
  request: null,
  open: (profileId, sessionId = null) => set({ request: { profileId, sessionId } }),
  close: () => set({ request: null }),
}));
