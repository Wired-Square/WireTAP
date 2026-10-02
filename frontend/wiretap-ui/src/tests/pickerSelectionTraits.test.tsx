// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import { servedTable } from "./fixtures/profileTraits";

const REFUSAL = "One or more sources do not support multi-source sessions";

const invoke = vi.fn(async (cmd: string, args?: { profiles?: IOProfile[] }) => {
  switch (cmd) {
    case "probe_device":
      return { success: true, source_type: "gvret_tcp", is_multi_bus: false, bus_count: 1, primary_info: null, secondary_info: null, supports_fd: null, error: null };
    case "list_orphaned_captures":
    case "list_active_sessions":
    case "get_profiles_usage":
      return [];
    case "get_profile_bus_mappings":
    case "get_supported_protocols":
      return {};
    case "list_profile_traits":
      return servedTable();
    case "validate_source_selection":
      return args?.profiles?.some((p) => p.id === "io_second") ? REFUSAL : null;
    default:
      return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { default: IoSourcePickerDialog } = await import("../dialogs/IoSourcePickerDialog");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const device = (id: string, name: string, kind: string): IOProfile =>
  ({ id, name, kind, connection: {} }) as unknown as IOProfile;

const profiles = [
  device("io_first", "First GVRET", "gvret_tcp"),
  device("io_second", "Second GVRET", "gvret_tcp"),
  device("io_archive", "Archive", "wiretap"),
];

const option = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes(text));
const optionNames = () => [...document.querySelectorAll<HTMLElement>("[role=option]")].map((el) => el.textContent ?? "");
const click = (el: HTMLElement | undefined) => act(async () => el!.click());

describe("the source picker reads Rust's traits", () => {
  let root: Root;

  beforeEach(async () => {
    invoke.mockClear();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <IoSourcePickerDialog isOpen onClose={() => {}} ioProfiles={profiles} selectedId={null} allowMultiSelect onSelect={() => {}} />,
      ),
    );
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("files a recorded kind away from the live devices", () => {
    expect(optionNames().some((n) => n.includes("First GVRET"))).toBe(true);
    expect(optionNames().some((n) => n.includes("Archive"))).toBe(false);
  });

  it("asks Rust about the whole selection, and refuses what it refuses", async () => {
    await click(option("First GVRET"));
    expect(option("First GVRET")?.getAttribute("aria-selected")).toBe("true");

    await click(option("Second GVRET"));
    const selections = invoke.mock.calls.filter(([cmd]) => cmd === "validate_source_selection");
    const last = selections[selections.length - 1][1]?.profiles ?? [];
    expect(last.map((p: IOProfile) => p.id)).toEqual(["io_first", "io_second"]);
    expect(document.body.textContent).toContain(REFUSAL);
    expect(option("Second GVRET")?.getAttribute("aria-selected")).toBe("false");
  });
});
