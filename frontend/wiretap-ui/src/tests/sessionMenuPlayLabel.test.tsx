// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { IOSessionControls } from "../components/SessionControls";
import { useSessionStore, type Session } from "../stores/sessionStore";
import type { SessionSourceKind } from "../generated/SessionSourceKind";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SESSION_ID = "c_import";

let host: HTMLDivElement;
let root: Root;

function stoppedMenuItems(sourceKind: SessionSourceKind): string[] {
  useSessionStore.setState({
    sessions: {
      [SESSION_ID]: { id: SESSION_ID, sourceKind, originProfileIds: [], busStatuses: [], sourceProfileIds: [] } as unknown as Session,
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <IOSessionControls
        ioProfile={SESSION_ID}
        ioProfiles={[]}
        sessionId={SESSION_ID}
        ioState="stopped"
        onOpenIoSessionPicker={() => {}}
        isStreaming={false}
        isStopped
        onPlay={() => {}}
      />,
    ),
  );
  act(() => host.querySelector("button")!.click());
  return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].map((item) => item.textContent ?? "");
}

describe("the session menu's play item while stopped", () => {
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("reads Play on a session opened on a capture, which has no IO to resume", () => {
    const items = stoppedMenuItems("capture");
    expect(items).toContain("Play");
    expect(items).not.toContain("Resume IO stream");
  });

  it("offers to resume the IO stream on a stopped device session", () => {
    expect(stoppedMenuItems("device")).toContain("Resume IO stream");
  });
});
