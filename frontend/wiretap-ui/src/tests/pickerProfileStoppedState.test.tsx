// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import type { IOStateType } from "../api/io";
import { servedTable } from "./fixtures/profileTraits";

const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case "probe_device":
      return { success: true, source_type: "single", is_multi_bus: false, bus_count: 1, primary_info: null, secondary_info: null, supports_fd: null, error: null };
    case "get_profile_bus_mappings":
    case "get_supported_protocols":
      return {};
    case "list_profile_traits":
      return servedTable();
    default:
      return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

await import("../i18n");
const { default: IoSourcePickerDialog } = await import("../dialogs/IoSourcePickerDialog");
const { useSessionStore } = await import("../stores/sessionStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const gvret = { id: "io_gvret", name: "Bench GVRET", kind: "gvret_tcp", connection: {} } as unknown as IOProfile;

const holding = (...states: IOStateType[]) =>
  Object.fromEntries(
    states.map((ioState, i) => [
      `f_${i}`,
      { id: `f_${i}`, profileId: gvret.id, profileName: gvret.name, lifecycleState: "connected", ioState },
    ]),
  );

async function openPickerOn(states: IOStateType[], props: { selectedId: string | null; allowMultiSelect?: boolean }) {
  invoke.mockClear();
  useSessionStore.setState({ sessions: holding(...states) } as never);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<IoSourcePickerDialog isOpen onClose={() => {}} ioProfiles={[gvret]} onSelect={() => {}} {...props} />));
  await act(async () => {});
  return root;
}

describe("the picker reads a profile several sessions hold as stopped only when all have stopped", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers Resume only when every session holding the checked profile has stopped", async () => {
    let root = await openPickerOn(["stopped", "running"], { selectedId: gvret.id });
    expect(document.body.textContent).not.toContain("Resume and Join");
    act(() => root.unmount());

    root = await openPickerOn(["stopped", "stopped"], { selectedId: gvret.id });
    expect(document.body.textContent).toContain("Resume and Join");
    act(() => root.unmount());
  });

  it("does not probe a profile while any session holding it runs", async () => {
    const root = await openPickerOn(["stopped", "running"], { selectedId: null, allowMultiSelect: true });
    const row = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes(gvret.name));
    await act(async () => row!.click());
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "probe_device")).toEqual([]);
    act(() => root.unmount());
  });
});
