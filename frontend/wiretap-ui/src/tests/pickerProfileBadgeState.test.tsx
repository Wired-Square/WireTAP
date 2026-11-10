// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import type { IOStateType } from "../api/io";
import { servedTable } from "./fixtures/profileTraits";

const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
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

async function badgeOf(...states: IOStateType[]) {
  useSessionStore.setState({ sessions: holding(...states) } as never);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<IoSourcePickerDialog isOpen onClose={() => {}} ioProfiles={[gvret]} selectedId={null} onSelect={() => {}} />),
  );
  const row = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes(gvret.name));
  const text = row?.textContent ?? "";
  act(() => root.unmount());
  return text;
}

describe("the picker's badge for a profile several sessions hold", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reads live while any of them runs, and stopped only when all have stopped", async () => {
    const mixed = await badgeOf("stopped", "running", "running");
    expect(mixed).toContain("Live");
    expect(mixed).not.toContain("Stopped");
    expect(await badgeOf("stopped", "stopped")).toContain("Stopped");
  });
});
