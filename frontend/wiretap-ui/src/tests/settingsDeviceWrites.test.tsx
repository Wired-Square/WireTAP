// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../settings/appSettings";

const saved: IOProfile = { id: "io_1", name: "Bench", kind: "virtual", connection: { host: "10.0.0.5" } } as IOProfile;
let onDisk: { decoder_dir: string; dump_dir: string; report_dir: string; io_profiles: IOProfile[] };
const listeners = new Map<string, (() => void)[]>();
const announce = () => listeners.get("settings:changed")?.forEach((fire) => fire());

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  switch (cmd) {
    case "load_settings":
      return structuredClone(onDisk);
    case "delete_device":
      onDisk.io_profiles = onDisk.io_profiles.filter((p) => p.id !== args!.profile_id);
      announce();
      return null;
    case "reconfigure_device":
      onDisk.io_profiles = onDisk.io_profiles.map((p) =>
        p.id === args!.profile_id ? ({ ...p, connection: args!.connection } as IOProfile) : p,
      );
      announce();
      return null;
    case "create_device": {
      const draft = args!.draft as IOProfile;
      if (onDisk.io_profiles.some((p) => p.name === draft.name)) throw { code: "nameDuplicate", field: "name" };
      const device = { ...draft, id: "io_2" } as IOProfile;
      onDisk.io_profiles.push(device);
      announce();
      return device;
    }
    case "validate_directory":
      return { exists: true, writable: true };
    default:
      return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));

const { useIOProfileHandlers } = await import("../apps/settings/hooks/handlers/useIOProfileHandlers");
const { useSettingsStore } = await import("../apps/settings/stores/settingsStore");
const { createDevice } = await import("../api/ephemeralProfiles");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Handlers = ReturnType<typeof useIOProfileHandlers>;

describe("a Settings device write reaches the settings file at once", () => {
  let root: Root;
  let handlers: Handlers;

  beforeEach(async () => {
    // The settings store's save debounce never fires: anything waiting on it is too late.
    vi.useFakeTimers();
    onDisk = { decoder_dir: "/d", dump_dir: "/u", report_dir: "/r", io_profiles: [structuredClone(saved)] };
    await useSettingsStore.getState().loadSettings();
    root = createRoot(document.createElement("div"));
    function Harness() {
      handlers = useIOProfileHandlers();
      return null;
    }
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("frees a deleted device's name for a new device", async () => {
    act(() => handlers.handleDeleteIOProfile(saved.id));
    await act(() => handlers.handleConfirmDeleteIOProfile());

    await expect(createDevice({ name: saved.name, kind: "virtual", connection: {} }, true)).resolves.toMatchObject({
      name: saved.name,
    });
    expect(useSettingsStore.getState().ioProfiles.profiles.map((p) => p.id)).toEqual(["io_2"]);
  });

  it("writes a probe's fields, and only those, into the saved device", async () => {
    const form = { ...saved, name: "Renamed, unsaved", connection: { host: "10.0.0.9" } } as IOProfile;
    act(() => useSettingsStore.getState().setDialogPayload({ editingProfileId: saved.id, profileForm: form }));
    await act(async () => handlers.persistProbedFields({ device_id: "FL-0042" }));

    const probed = { ...saved, connection: { host: "10.0.0.5", device_id: "FL-0042" } };
    expect(onDisk.io_profiles).toEqual([probed]);
    expect(useSettingsStore.getState().ioProfiles.profiles).toEqual([probed]);
  });
});
