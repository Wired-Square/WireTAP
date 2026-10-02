// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import type { BusMapping, BusOverride, MultiSourceInput } from "../api/io";
import { servedTable, traits } from "./fixtures/profileTraits";

const bus = (device_bus: number, output_bus: number, enabled = true): BusMapping => ({
  device_bus,
  enabled,
  output_bus,
  interface_id: `can${device_bus}`,
  protocol: "can",
  supported_protocols: ["can"],
  traits: null,
});

/** Rust's answer, with output buses no TypeScript count would arrive at. */
function allocate(sources: MultiSourceInput[]): Record<string, BusMapping[]> {
  const disabled = (id: string, deviceBus: number) =>
    sources.find((s) => s.profile_id === id)?.overrides?.some((o) => o.device_bus === deviceBus && o.enabled === false);
  return {
    gvret: [bus(0, 4, !disabled("gvret", 0)), bus(1, 5, !disabled("gvret", 1))],
    slcan: [bus(0, 6)],
  };
}

const invoke = vi.fn(async (cmd: string, args?: { sources?: MultiSourceInput[]; opts?: { sources?: MultiSourceInput[] } }) => {
  switch (cmd) {
    case "probe_device":
      return { success: true, source_type: "x", is_multi_bus: false, bus_count: 1, primary_info: null, secondary_info: null, supports_fd: null, error: null };
    case "list_orphaned_captures":
    case "list_active_sessions":
    case "get_profiles_usage":
      return [];
    case "get_profile_bus_mappings":
    case "get_supported_protocols":
      return {};
    case "list_profile_traits":
      return servedTable({ gvret: traits({ multi_bus: true }), slcan: traits() });
    case "preview_source_buses":
      return allocate(args!.sources!);
    case "open_session":
      return {
        created: true,
        start_error: null,
        startup_error: null,
        bus_mappings: allocate(args!.opts!.sources!),
        capabilities: {},
        state: { type: "Running" },
        capture_id: null,
        capture_kind: null,
        subscriber_count: 1,
        origin_profile_ids: ["gvret", "slcan"],
        source_type: "multi_source",
        source_kind: "device",
      };
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
const { createAndStartMultiSourceSession } = await import("../stores/sessionStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const profiles = [
  { id: "gvret", name: "GVRET", kind: "gvret_tcp", connection: {} },
  { id: "slcan", name: "CANable", kind: "slcan", connection: {} },
] as unknown as IOProfile[];

const lastSources = (cmd: string) => {
  const args = invoke.mock.calls.filter(([c]) => c === cmd).pop()?.[1];
  return args?.sources ?? args?.opts?.sources ?? [];
};
const outputBusSelects = () =>
  [...document.querySelectorAll<HTMLSelectElement>("select")].filter((s) => s.options.length === 8);

describe("the picker opens a multi-source session on Rust's allocation", () => {
  let root: Root;
  const onStartMultiLoad = vi.fn();

  beforeEach(async () => {
    invoke.mockClear();
    onStartMultiLoad.mockClear();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <IoSourcePickerDialog
          isOpen
          onClose={() => {}}
          ioProfiles={profiles}
          selectedId={null}
          selectedIds={["gvret", "slcan"]}
          allowMultiSelect
          onSelect={() => {}}
          onStartMultiLoad={onStartMultiLoad}
        />,
      ),
    );
    for (let i = 0; i < 4; i++) await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("shows the output buses Rust allocated", () => {
    expect(lastSources("preview_source_buses")).toEqual([
      { profile_id: "gvret", overrides: undefined },
      { profile_id: "slcan", overrides: undefined },
    ]);
    expect(outputBusSelects().map((s) => s.value)).toEqual(["4", "5", "6"]);
  });

  it("sends what the user changed as an override, and shows Rust's answer to it", async () => {
    const busOne = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")][1];
    await act(async () => busOne.click());
    await act(async () => {});

    const overrides: BusOverride[] = [{ device_bus: 1, enabled: false }];
    expect(lastSources("preview_source_buses")[0]).toEqual({ profile_id: "gvret", overrides });
    expect(outputBusSelects().map((s) => s.value)).toEqual(["4", "6"]);

    const connect = [...document.querySelectorAll("button")].find((b) => b.textContent === "ioSourcePicker.actions.connect")!;
    await act(async () => connect.click());
    expect(onStartMultiLoad.mock.calls[0][2].busOverrides).toEqual(new Map([["gvret", overrides]]));
  });

  it("forgets a source's edits when it is unticked, so re-ticking starts from Rust's allocation", async () => {
    const busOne = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")][1];
    await act(async () => busOne.click());
    await act(async () => {});
    expect(lastSources("preview_source_buses")[0].overrides).toEqual([{ device_bus: 1, enabled: false }]);

    const gvretOption = () =>
      [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes("GVRET"))!;
    await act(async () => gvretOption().click());
    await act(async () => gvretOption().click());
    await act(async () => {});

    expect(lastSources("preview_source_buses")).toEqual([
      { profile_id: "slcan", overrides: undefined },
      { profile_id: "gvret", overrides: undefined },
    ]);
    expect(outputBusSelects().map((s) => s.value)).toEqual(["4", "5", "6"]);
  });
});

describe("opening the session", () => {
  it("names each source and its overrides, and reads back the buses Rust gave it", async () => {
    vi.useFakeTimers();
    const overrides: BusOverride[] = [{ device_bus: 0, output_bus: 2 }];
    const result = await createAndStartMultiSourceSession({
      sessionId: "f_1",
      subscriberId: "discovery_1",
      appName: "discovery",
      profileIds: ["gvret", "slcan"],
      busOverrides: new Map([["slcan", overrides]]),
    });
    vi.useRealTimers();

    const sources = lastSources("open_session");
    expect(sources.map(({ profile_id, overrides }) => ({ profile_id, overrides }))).toEqual([
      { profile_id: "gvret", overrides: undefined },
      { profile_id: "slcan", overrides },
    ]);
    expect(sources.every((s) => !("bus_mappings" in s))).toBe(true);
    expect(result.busMappings.get("slcan")?.map((m) => m.output_bus)).toEqual([6]);
  });
});
