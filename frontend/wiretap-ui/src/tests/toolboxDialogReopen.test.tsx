// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

const { useDiscoveryToolboxStore } = await import("../stores/discoveryToolboxStore");
const { default: ToolboxDialog } = await import("../dialogs/ToolboxDialog");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const options = () => [...document.querySelectorAll('[role="option"]')];

describe("the Discovery tools dialog", () => {
  it("reopens on every tool after one was picked, with the pick kept", async () => {
    useDiscoveryToolboxStore.getState().setActiveView("message-order");
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<ToolboxDialog onClose={() => {}} selectedCount={2} frameCount={10} />));
    expect(options().length).toBeGreaterThan(1);
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
    act(() => root.unmount());
  });
});
