// @vitest-environment jsdom
// The settings store's defaults — its state before a load, what a load fills in for an absent
// field, and what the reset buttons restore — pinned in `settingsStoreDefaults.json`, checked
// against Rust's served defaults, and read from `generated/settingDefaults.ts` rather than spelt.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { expectGolden, fixtureJson } from "./catalogGoldens";

let onDisk: Record<string, unknown>;
vi.mock("../api", () => ({
  loadSettings: vi.fn(async () => structuredClone(onDisk)),
  saveSettings: vi.fn(async () => {}),
  validateDirectory: vi.fn(async () => ({ exists: true, writable: true })),
  setWakeSettings: vi.fn(async () => {}),
  setLogLevel: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { useSettingsStore } = await import("../apps/settings/stores/settingsStore");

const slices = () => {
  const { display, buffers, general, mcp } = useSettingsStore.getState();
  return structuredClone({ display, buffers, general, mcp });
};

const LOCATIONS = { config_path: "", decoder_dir: "", dump_dir: "", report_dir: "" };

async function loadedFrom(file: Record<string, unknown>) {
  onDisk = file;
  await useSettingsStore.getState().loadSettings();
  return slices();
}

function afterResets() {
  const store = useSettingsStore.getState();
  store.setSignalColour("low", "#000001");
  store.setBinaryOneColour("#000002");
  store.setBinaryZeroColour("#000003");
  store.setBinaryUnusedColour("#000004");
  store.setFrameEditorColour(0, "#000005");
  store.setThemeColour("accentDanger", "#000006");
  for (const level of ["none", "low", "medium", "high"] as const) store.resetSignalColour(level);
  store.resetBinaryOneColour();
  store.resetBinaryZeroColour();
  store.resetBinaryUnusedColour();
  store.resetFrameEditorColours();
  store.resetThemeColours();
  return slices().display;
}

describe("settings store defaults", () => {
  it("matches fixtures/data/settingsStoreDefaults.json", async () => {
    const initial = slices();
    const loaded = await loadedFrom({ ...LOCATIONS, io_profiles: [] });
    const reset = afterResets();
    await expectGolden(
      "settingsStoreDefaults.json",
      [
        { name: "before a load", input: null, expected: initial },
        { name: "a load of a file with no settings", input: { io_profiles: [] }, expected: loaded },
        { name: "every display reset", input: null, expected: reset },
      ],
      "data",
    );
    expect(loaded).toEqual(initial);
    expect(reset).toEqual(initial.display);
  });

  it("spells no default of its own", () => {
    for (const file of ["settings/appSettings.ts", "apps/settings/stores/settingsStore.ts"]) {
      const source = readFileSync(resolve(__dirname, "..", file), "utf-8");
      expect(source, file).not.toMatch(/#[0-9a-f]{6}/i);
      expect(source, file).not.toMatch(/(\?\?|\|\|) *(true|false|\d|'[^']|"[^"])/);
      expect(source, file).not.toMatch(/const DEFAULT_/);
    }
  });

  it("fills an absent field with Rust's default", async () => {
    await loadedFrom({ ...LOCATIONS, io_profiles: [] });
    const rust = fixtureJson<Record<string, unknown>>("data/settingsDefaults.rust.json");
    expect(useSettingsStore.getState().originalSettings).toEqual({ ...rust, ...LOCATIONS });
  });
});
