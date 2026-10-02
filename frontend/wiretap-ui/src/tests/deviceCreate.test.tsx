// @vitest-environment jsdom
//
// The picker's device editor creates through Rust's `create_device`, which
// writes settings.json itself. The stores take the device from its answer and
// the backend's settings-changed rebase, so nothing writes the settings again.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";
import type { IOProfile } from "../settings/appSettings";
import { servedTable } from "./fixtures/profileTraits";

type Draft = Omit<IOProfile, "id">;

let onDisk: { decoder_dir: string; dump_dir: string; report_dir: string; io_profiles: IOProfile[] };
let adHoc: IOProfile[];
const listeners = new Map<string, (() => void)[]>();

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "load_settings":
      return structuredClone({ ...onDisk, io_profiles: [...onDisk.io_profiles, ...adHoc] });
    case "create_device": {
      const persist = args!.persist as boolean;
      const { id: _id, ...draft } = args!.draft as Draft & { id?: string };
      const device = { ...draft, id: persist ? "io_42" : "adhoc_42", connection: { ...draft.connection, bitrate: "500000" } } as IOProfile;
      if (persist) {
        onDisk.io_profiles.push(device);
        listeners.get("settings:changed")?.forEach((fire) => fire());
      } else {
        adHoc.push({ ...device, ephemeral: true });
      }
      return device;
    }
    case "list_ephemeral_profiles":
      return structuredClone(adHoc);
    case "list_profile_traits":
      return servedTable();
    case "validate_directory":
      return { exists: true, writable: true };
    case "list_orphaned_captures":
    case "list_active_sessions":
    case "get_profiles_usage":
      return [];
    case "default_connection_for_kind":
    case "get_profile_bus_mappings":
    case "get_supported_protocols":
      return {};
    default:
      return cmd.startsWith("list") || cmd.includes("ports") ? [] : null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));

const { default: IoSourcePickerDialog } = await import("../dialogs/IoSourcePickerDialog");
const { useSettingsStore } = await import("../apps/settings/stores/settingsStore");
const { useAdHocProfileStore } = await import("../stores/adHocProfileStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent?.trim() === text);
const saves = () => invoke.mock.calls.filter(([cmd]) => cmd === "save_settings");

describe("the device editor creates through create_device", () => {
  let root: Root;
  const onStartLoad = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onDisk = { decoder_dir: "/d", dump_dir: "/u", report_dir: "/r", io_profiles: [] };
    adHoc = [];
    useAdHocProfileStore.setState({ profiles: [] });
    await useSettingsStore.getState().loadSettings();
    invoke.mockClear();
    onStartLoad.mockClear();

    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <IoSourcePickerDialog isOpen onClose={() => {}} ioProfiles={[]} selectedId={null} onSelect={() => {}} onStartLoad={onStartLoad} />,
      ),
    );
    await act(async () => button("New device…")!.click());
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  async function connect() {
    await act(async () => button("Connect")!.click());
    // Past the settings store's 1 s save debounce.
    await act(async () => vi.advanceTimersByTimeAsync(2000));
  }

  it("saves a device once, through Rust, and the settings store shows it", async () => {
    const saveToSettings = [...document.querySelectorAll("label")].find((l) => l.textContent === "Save to Settings");
    await act(async () => saveToSettings!.querySelector("input")!.click());
    await connect();

    const [, args] = invoke.mock.calls.find(([cmd]) => cmd === "create_device")!;
    expect(args).toMatchObject({ persist: true, draft: { kind: "slcan" } });
    expect(useSettingsStore.getState().ioProfiles.profiles).toEqual([
      expect.objectContaining({ id: "io_42", connection: expect.objectContaining({ bitrate: "500000" }) }),
    ]);
    expect(useSettingsStore.getState().hasUnsavedChanges()).toBe(false);
    expect(saves()).toEqual([]);
    expect(onStartLoad).toHaveBeenCalledWith("io_42", true, expect.anything());
  });

  it("registers an ad-hoc device without touching settings", async () => {
    await connect();

    expect(invoke.mock.calls.find(([cmd]) => cmd === "create_device")![1]).toMatchObject({ persist: false });
    expect(useAdHocProfileStore.getState().profiles.map((p) => p.id)).toEqual(["adhoc_42"]);
    expect(useSettingsStore.getState().ioProfiles.profiles).toEqual([]);
    expect(saves()).toEqual([]);
    expect(onStartLoad).toHaveBeenCalledWith("adhoc_42", true, expect.anything());
  });
});
