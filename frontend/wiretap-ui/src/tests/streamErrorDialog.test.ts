// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { useSessionStore, closeStreamErrorFor } from "../stores/sessionStore";

const open = (sessionId?: string) =>
  useSessionStore.getState().showAppError("Stream Error", "port lost", undefined, "stream-error", sessionId);

describe("the stream error dialog", () => {
  it("closes when the session that raised it runs again", () => {
    open("s1");
    closeStreamErrorFor("s1");
    expect(useSessionStore.getState().appErrorDialog.isOpen).toBe(false);
  });

  it("stays open for another session's recovery or an error with no session", () => {
    open("s1");
    closeStreamErrorFor("s2");
    expect(useSessionStore.getState().appErrorDialog.isOpen).toBe(true);
    open();
    closeStreamErrorFor("s1");
    expect(useSessionStore.getState().appErrorDialog.isOpen).toBe(true);
  });
});
