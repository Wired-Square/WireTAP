// Settings goldens: Rust serves settings migrated, defaulted and clamped
// (`settingsNormalise.json`, `settingsMigrateFrameLink.json` and
// `settingsDefaults.rust.json` are pinned by `settings::tests`); the frontend
// changes nothing of them but the ad-hoc devices, and its bounds are Rust's ranges.

import { describe, it, expect } from "vitest";

import { normalizeSettings, type AppSettings, type IOProfile } from "../settings/appSettings";
import { SETTINGS_BOUNDS } from "../settings/bounds";
import { expectGolden, fixtureJson } from "./catalogGoldens";

type BoundRow = {
  key: string | null;
  field: string;
  ts: { min: number; max: number; step: number } | null;
  rust: { min: number; max: number } | null;
};

const { bounds } = fixtureJson<{ bounds: BoundRow[] }>("data/settingsBounds.json");

describe("settings goldens", () => {
  it("defaults beside Rust's", async () => {
    const rust = fixtureJson<Record<string, unknown>>("data/settingsDefaults.rust.json");
    const ts = normalizeSettings(rust as unknown as AppSettings) as unknown as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(rust), ...Object.keys(ts)])].sort();
    const expected = {
      onlyRust: keys.filter((k) => !(k in ts)),
      onlyTs: keys.filter((k) => !(k in rust)),
      differ: Object.fromEntries(
        keys
          .filter((k) => k in ts && k in rust && JSON.stringify(ts[k]) !== JSON.stringify(rust[k]))
          .map((k) => [k, { ts: ts[k], rust: rust[k] }]),
      ),
    };
    await expectGolden("settingsDefaults.diff.json", [{ name: "normalizeSettings(Rust's served defaults)", input: null, expected }], "data");
  });

  it("drops this run's ad-hoc devices", () => {
    const profile = (id: string, ephemeral: boolean) => ({ id, name: id, kind: "slcan", connection: {}, ephemeral }) as IOProfile;
    const rust = fixtureJson<AppSettings>("data/settingsDefaults.rust.json");
    const { io_profiles } = normalizeSettings({ ...rust, io_profiles: [profile("a", true), profile("b", false)] });
    expect(io_profiles.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("SETTINGS_BOUNDS against the bounds table", () => {
  it("lists exactly the table's keyed rows", () => {
    const keyed = bounds.filter((row) => row.key !== null);
    expect(Object.keys(SETTINGS_BOUNDS).sort()).toEqual(keyed.map((row) => row.key).sort());
  });

  it.each(bounds.filter((row) => row.key !== null).map((row) => [row.key, row] as const))("%s", (key, row) => {
    expect(SETTINGS_BOUNDS[key as keyof typeof SETTINGS_BOUNDS]).toEqual(row.ts);
  });
});
