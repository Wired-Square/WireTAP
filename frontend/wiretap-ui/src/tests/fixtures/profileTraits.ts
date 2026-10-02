// A stand-in for the table `list_profile_traits` serves, for tests that mock `invoke`.

import type { KindTraits, ProfileTraits, ProfileTraitsTable } from "../../api/deviceKinds";

export function traits(overrides: Partial<ProfileTraits> = {}): ProfileTraits {
  return {
    temporal_mode: "realtime",
    protocols: ["can"],
    tx_frames: true,
    tx_bytes: false,
    multi_source: true,
    bus_protocol: "can",
    multi_bus: false,
    tx_blocked: null,
    ...overrides,
  };
}

const kind = (name: string, overrides: Partial<ProfileTraits> = {}): KindTraits => ({
  kind: name,
  available: true,
  ...traits(overrides),
});

export const SERVED_KINDS: KindTraits[] = [
  kind("gvret_tcp", { multi_bus: true }),
  kind("modbus_tcp", { protocols: ["modbus"], bus_protocol: "modbus", tx_frames: false }),
  kind("mqtt", { tx_frames: false, multi_source: false }),
  kind("wiretap", { temporal_mode: "recorded", tx_frames: false, multi_source: false }),
  kind("serial", { protocols: ["serial"], bus_protocol: "serial", tx_frames: false, tx_bytes: true }),
  kind("slcan", { tx_blocked: "silent_mode" }),
  kind("virtual"),
];

export function servedTable(profiles: Record<string, ProfileTraits> = {}): ProfileTraitsTable {
  return { kinds: SERVED_KINDS, profiles };
}
