// P5 D1 goldens for settings: normalizeSettings, the bounds table shared with
// `settings::tests`, the TS defaults beside Rust's, and migrateFrameLinkProfiles.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { normalizeSettings, type AppSettings, type IOProfile } from "../settings/appSettings";
import { SETTINGS_BOUNDS } from "../settings/bounds";
import { expectGolden, fixtureJson, type GoldenCase } from "./catalogGoldens";

const { migrateFrameLinkProfiles } = await import("../apps/settings/stores/settingsStore");

type BoundRow = {
  key: string | null;
  field: string;
  ts: { min: number; max: number; step: number } | null;
  rust: { min: number; max: number } | null;
};

const { bounds } = fixtureJson<{ bounds: BoundRow[] }>("data/settingsBounds.json");

const defaults = normalizeSettings({}) as unknown as Record<string, unknown>;

function changedFromDefaults(settings: AppSettings) {
  return Object.fromEntries(
    Object.entries(settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k])),
  );
}

const loose = (raw: Record<string, unknown>) => raw as Partial<AppSettings>;

const normaliseInputs: { name: string; raw: Record<string, unknown>; dirs?: { decoders: string; dumps: string; reports: string } }[] = [
  { name: "falsy directories take the default dirs", raw: { decoder_dir: "", dump_dir: "/d" }, dirs: { decoders: "/dec", dumps: "/dmp", reports: "/rep" } },
  { name: "legacy and unknown keys are dropped", raw: { enable_file_logging: true, log_level: "off", capture_storage: "x", clear_buffers_on_start: false } },
  { name: "out-of-range numbers are not clamped", raw: { query_result_limit: 5, smp_port: 0, mcp_server_port: 80, graph_buffer_size: 1e9, modbus_max_register_errors: -1 } },
  { name: "zero and empty string survive ?? but not ||", raw: { session_manager_stats_interval: 0, install_id: "", config_path: "", signal_colour_none: "", theme_accent_primary: "" } },
  { name: "id formats coerce anything but decimal to hex", raw: { display_frame_id_format: "HEX", save_frame_id_format: "Decimal" } },
  { name: "other enums pass through unchecked", raw: { display_time_format: "bogus", display_timezone: "mars", theme_mode: "neon", default_frame_type: "lin", log_level: "loud" } },
  { name: "null takes the default", raw: { log_level: null, prevent_idle_sleep: null, default_read_profile: null, default_write_profiles: null } },
  { name: "wrong types pass through", raw: { query_result_limit: "500", prevent_idle_sleep: "yes", language: 7 } },
  { name: "frame editor colours of seven are replaced", raw: { frame_editor_colours: ["#1", "#2", "#3", "#4", "#5", "#6", "#7"] } },
  { name: "frame editor colours of nine are replaced", raw: { frame_editor_colours: ["#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9"] } },
  { name: "frame editor colours of eight are kept, unchecked", raw: { frame_editor_colours: ["", "x", "#3", "#4", "#5", "#6", "#7", "#8"] } },
  {
    name: "ephemeral profiles are dropped",
    raw: {
      io_profiles: [
        { id: "a", name: "A", kind: "slcan", connection: {}, ephemeral: true },
        { id: "b", name: "B", kind: "slcan", connection: {}, ephemeral: false },
      ],
    },
  },
];

const framelink = (id: string, connection: Record<string, unknown>, name = id) =>
  ({ id, name, kind: "framelink", connection }) as IOProfile;

const migrateInputs: { name: string; profiles: IOProfile[] }[] = [
  { name: "no legacy profiles", profiles: [framelink("g", { host: "h", interfaces: [] })] },
  {
    name: "two interfaces of one device merge under the first id",
    profiles: [
      framelink("p2", { host: "10.0.0.5", device_id: "FL1", interface_index: 2, interface_type: 3, interface_name: "CAN2" }, "Bench CAN2"),
      framelink("p1", { host: "10.0.0.5", device_id: "FL1", interface_index: 1, interface_name: "CAN1" }, "Bench CAN1"),
    ],
  },
  {
    name: "no device id groups by port, which defaults to 120",
    profiles: [
      framelink("a", { host: "h", port: "121", interface_index: 0 }),
      framelink("b", { host: "h", interface_index: 0 }),
      framelink("c", { host: "h", port: "120", interface_index: 1 }),
    ],
  },
  {
    name: "a name not ending in the interface name becomes the device id, else the name",
    profiles: [
      framelink("a", { host: "h1", device_id: "DEV", interface_index: 0, interface_name: "CAN0" }, "Something"),
      framelink("b", { host: "h2", interface_index: 0, interface_name: "CAN0" }, "Other"),
    ],
  },
  {
    name: "a name equal to the interface name falls back to the device id, else the name",
    profiles: [framelink("a", { host: "h", interface_index: 0, interface_name: "CAN0" }, "CAN0")],
  },
  {
    name: "an interfaces array makes a profile new-style even with interface_index",
    profiles: [framelink("a", { host: "h", interface_index: 0, interfaces: [] })],
  },
  {
    name: "other profiles come first and keep their order; merged ones are appended",
    profiles: [
      framelink("old", { host: "h", interface_index: 0, timeout: "5" }),
      { id: "s", name: "S", kind: "slcan", connection: {} } as IOProfile,
      framelink("new", { host: "h", interfaces: [] }),
    ],
  },
  {
    name: "no host groups under undefined",
    profiles: [framelink("a", { interface_index: 0 }), framelink("b", { interface_index: 1 })],
  },
];

describe("settings goldens", () => {
  it("normalizeSettings", async () => {
    const cases: GoldenCase[] = [{ name: "empty input gives the defaults", input: {}, expected: defaults }];
    for (const { name, raw, dirs } of normaliseInputs) {
      cases.push({ name, input: { raw, dirs }, expected: changedFromDefaults(normalizeSettings(loose(raw), dirs)) });
    }
    await expectGolden("settingsNormalise.json", cases, "data");
  });

  it("migrateFrameLinkProfiles", async () => {
    const cases = migrateInputs.map(({ name, profiles }) => {
      const before = structuredClone(profiles);
      const result = migrateFrameLinkProfiles(profiles);
      return { name, input: before, expected: { ...result, sameArray: result.profiles === profiles } };
    });
    await expectGolden("settingsMigrateFrameLink.json", cases, "data");
  });

  it("defaults beside Rust's", async () => {
    const rust = fixtureJson<Record<string, unknown>>("data/settingsDefaults.rust.json");
    const ts = normalizeSettings({}, { decoders: "", dumps: "", reports: "" }) as unknown as Record<string, unknown>;
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
    await expectGolden("settingsDefaults.diff.json", [{ name: "normalizeSettings({}) against AppSettings::default()", input: null, expected }], "data");
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
