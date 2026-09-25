// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IOProfile } from "../settings/appSettings";
import { rebaseSettings } from "../settings/rebaseSettings";

let onDisk: Record<string, unknown>;
const saveSettings = vi.fn(async () => {});
vi.mock("../api", () => ({
  loadSettings: vi.fn(async () => structuredClone(onDisk)),
  saveSettings,
  validateDirectory: vi.fn(async () => ({ exists: true, writable: true })),
  setWakeSettings: vi.fn(async () => {}),
  setLogLevel: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const { useSettingsStore } = await import("../apps/settings/stores/settingsStore");

const profile = (id: string, host: string): IOProfile =>
  ({ id, name: id, kind: "gvret_tcp", connection: { host } }) as IOProfile;

const settings = (io_profiles: IOProfile[], log_level = "off") => ({ io_profiles, log_level });

describe("rebaseSettings", () => {
  const a = profile("a", "10.0.0.1");
  const b = profile("b", "10.0.0.2");

  it("adopts the fresh settings when nothing changed locally", () => {
    const base = settings([a, b]);
    const fresh = settings([a, profile("b", "10.0.0.9"), profile("c", "10.0.0.3")], "info");
    expect(rebaseSettings(base, base, fresh)).toEqual(fresh);
  });

  it("keeps a profile edited locally and adopts the rest", () => {
    const base = settings([a, b]);
    const local = settings([profile("a", "local"), b]);
    const fresh = settings([profile("a", "remote"), profile("b", "remote")]);
    expect(rebaseSettings(base, local, fresh).io_profiles).toEqual([profile("a", "local"), profile("b", "remote")]);
  });

  it("drops a profile removed on either side unless it was edited locally", () => {
    const base = settings([a, b]);
    const local = settings([profile("a", "local")]);
    const fresh = settings([profile("b", "remote")]);
    expect(rebaseSettings(base, local, fresh).io_profiles).toEqual([profile("a", "local")]);
  });

  it("keeps a profile added locally", () => {
    const c = profile("c", "10.0.0.3");
    expect(rebaseSettings(settings([a]), settings([a, c]), settings([a, b])).io_profiles).toEqual([a, b, c]);
  });

  it("keeps a top-level field changed locally and adopts the others", () => {
    const base = { ...settings([a]), language: "en-AU" };
    const local = { ...base, log_level: "debug" };
    const fresh = { ...base, log_level: "info", language: "de" };
    expect(rebaseSettings(base, local, fresh)).toEqual({ ...base, log_level: "debug", language: "de" });
  });
});

describe("settings store rebase", () => {
  const disk = (io_profiles: IOProfile[], log_level = "off") => ({
    decoder_dir: "/d", dump_dir: "/u", report_dir: "/r", io_profiles, log_level,
  });

  beforeEach(async () => {
    onDisk = disk([profile("a", "10.0.0.1"), profile("b", "10.0.0.2")]);
    await useSettingsStore.getState().loadSettings();
    saveSettings.mockClear();
  });

  it("is clean after adopting a write made behind it", async () => {
    onDisk = disk([profile("a", "10.0.0.1"), profile("b", "probed")]);
    await useSettingsStore.getState().rebaseOnDisk();

    const state = useSettingsStore.getState();
    expect(state.ioProfiles.profiles[1]).toEqual(profile("b", "probed"));
    expect(state.hasUnsavedChanges()).toBe(false);
  });

  it("carries a local edit over the fresh settings and saves it without undoing the other write", async () => {
    useSettingsStore.setState((s) => ({ general: { ...s.general, logLevel: "debug" } }));
    onDisk = disk([profile("a", "10.0.0.1"), profile("b", "probed")], "info");
    await useSettingsStore.getState().rebaseOnDisk();
    await useSettingsStore.getState().saveSettings();

    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ log_level: "debug", io_profiles: [profile("a", "10.0.0.1"), profile("b", "probed")] }),
    );
  });

  it("does nothing on the echo of its own save", async () => {
    useSettingsStore.getState().updateProfile("a", profile("a", "edited"));
    await useSettingsStore.getState().saveSettings();
    onDisk = disk([profile("a", "edited"), profile("b", "10.0.0.2")]);
    const before = useSettingsStore.getState().ioProfiles;
    await useSettingsStore.getState().rebaseOnDisk();

    expect(useSettingsStore.getState().ioProfiles).toEqual(before);
    expect(useSettingsStore.getState().hasUnsavedChanges()).toBe(false);
  });
});
