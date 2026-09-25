// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../settings/appSettings";

const probeResult = {
  device_id: "FL-0042",
  board_name: "FrameLink Mini",
  board_revision: null,
  interfaces: [{ index: 0, iface_type: 1, name: "can0", type_name: "CAN", extra: "dropped" }],
};
vi.mock("../api/framelink", () => ({
  framelinkProbeDevice: vi.fn(async () => probeResult),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { useConnectionProbe } = await import("../components/io/useConnectionProbe");
const { useIOProfileHandlers } = await import("../apps/settings/hooks/handlers/useIOProfileHandlers");
const { useSettingsStore } = await import("../apps/settings/stores/settingsStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const platform = { isWindows: false, isLinux: false, isMacos: true, availableKinds: [] };
const probedFields = {
  interfaces: [{ index: 0, iface_type: 1, name: "can0", type_name: "CAN" }],
  device_id: "FL-0042",
  board_name: "FrameLink Mini",
};

const stored: IOProfile = {
  id: "fl-1",
  name: "Bench FrameLink",
  kind: "framelink",
  connection: { host: "10.0.0.5", port: "120", timeout: "5", board_revision: "B" },
};

type Harness = {
  probeFramelink: () => Promise<void>;
  persistProbedFields: (fields: Record<string, unknown>) => void;
};

function mount(onUpdate: (key: string, value: unknown) => void, onPersist?: (fields: Record<string, unknown>) => void) {
  const harness = {} as Harness;
  function Probe() {
    const form = { ...stored, connection: { ...stored.connection, host: "10.0.0.9" } } as IOProfile;
    harness.probeFramelink = useConnectionProbe({
      profile: form,
      active: false,
      platform,
      probeProfileId: stored.id,
      onUpdateConnectionField: onUpdate,
      onPersistProbe: onPersist,
      probeFailedText: "failed",
    }).probeFramelink;
    harness.persistProbedFields = useIOProfileHandlers().persistProbedFields;
    return null;
  }
  act(() => root.render(<Probe />));
  return harness;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("FrameLink re-probe", () => {
  it("fills the form and hands only the probe's fields to persist", async () => {
    const onUpdate = vi.fn();
    const onPersist = vi.fn();
    const harness = mount(onUpdate, onPersist);
    await act(() => harness.probeFramelink());

    expect(Object.fromEntries(onUpdate.mock.calls)).toEqual(probedFields);
    expect(onPersist).toHaveBeenCalledWith(probedFields);
  });

  it("writes the probe into the stored profile without the form's unsaved edits", () => {
    const form = { ...stored, name: "Renamed, unsaved", connection: { ...stored.connection, host: "10.0.0.9" } } as IOProfile;
    useSettingsStore.setState((s) => ({
      ioProfiles: { ...s.ioProfiles, profiles: [stored] },
      ui: { ...s.ui, dialogPayload: { ...s.ui.dialogPayload, editingProfileId: stored.id, profileForm: form } },
    }));
    const harness = mount(vi.fn());
    harness.persistProbedFields(probedFields);

    expect(useSettingsStore.getState().ioProfiles.profiles).toEqual([
      { ...stored, connection: { ...stored.connection, ...probedFields } },
    ]);
  });

  it("leaves settings alone for a profile not yet saved", () => {
    useSettingsStore.setState((s) => ({
      ioProfiles: { ...s.ioProfiles, profiles: [stored] },
      ui: { ...s.ui, dialogPayload: { ...s.ui.dialogPayload, editingProfileId: null } },
    }));
    const harness = mount(vi.fn());
    harness.persistProbedFields(probedFields);

    expect(useSettingsStore.getState().ioProfiles.profiles).toEqual([stored]);
  });
});
