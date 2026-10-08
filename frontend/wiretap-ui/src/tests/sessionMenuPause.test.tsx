// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { IOSessionControls } from "../components/SessionControls";
import { useSessionStore, type Session } from "../stores/sessionStore";
import type { IOCapabilities } from "../generated/IOCapabilities";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SESSION_ID = "f_live";

function openMenu(canPause: boolean): HTMLElement[] {
  useSessionStore.setState({
    sessions: {
      [SESSION_ID]: {
        id: SESSION_ID,
        originProfileIds: [],
        busStatuses: [],
        sourceProfileIds: [],
        capabilities: { can_pause: canPause, available_buses: [] } as unknown as IOCapabilities,
      } as unknown as Session,
    },
  });
  act(() =>
    root.render(
      <IOSessionControls
        ioProfile={SESSION_ID}
        ioProfiles={[]}
        sessionId={SESSION_ID}
        ioState="running"
        onOpenIoSessionPicker={() => {}}
        isStreaming
        onPause={() => {}}
      />,
    ),
  );
  act(() => host.querySelector("button")!.click());
  return [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
}

const menuItemsFor = (canPause: boolean) => openMenu(canPause).map((item) => item.textContent ?? "");

let host: HTMLDivElement;
let root: Root;

describe("the session menu", () => {
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const mount = () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  };

  it("a session that cannot pause is not offered Pause", () => {
    mount();
    expect(menuItemsFor(false)).not.toContain("Pause");
  });

  it("a session that cannot pause is not told to pause to change source", () => {
    mount();
    const changeSource = openMenu(false).find((item) => item.textContent === "Change source")!;
    expect(changeSource.title).not.toMatch(/pause/i);
  });

  it("a session that can pause is offered Pause", () => {
    mount();
    expect(menuItemsFor(true)).toContain("Pause");
  });
});
