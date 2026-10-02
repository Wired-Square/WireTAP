// @vitest-environment jsdom
//
// The profile form's defaults are Rust's `default_connection_for_kind`, served
// here by a mocked invoke whose values differ from the old TypeScript table, so
// a test passing on a hard-coded copy would fail.

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { IOProfile } from "../settings/appSettings";
import type { ConnectionProbe } from "../components/io/useConnectionProbe";
import type { ConnectionDefaults } from "../api/deviceKinds";

const served: Record<string, ConnectionDefaults> = {
  slcan: { baud_rate: 230400, bitrate: 250000, silent_mode: true, data_bits: 8, stop_bits: 1, parity: "none" },
  modbus_tcp: { host: "192.168.1.100", port: 502, unit_id: 1 },
};
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) =>
  cmd === "default_connection_for_kind" ? served[args?.kind as string] ?? {} : [],
);
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { applyConnectionDefaults } = await import("../settings/ioProfileForm");
const { modbusConnectionOf } = await import("../utils/modbusProfiles");
const { default: IOConnectionFields } = await import("../components/io/IOConnectionFields");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const slcan = (connection: Record<string, unknown>) =>
  ({ id: "", name: "CANable", kind: "slcan", connection }) as IOProfile;

describe("connection defaults from Rust", () => {
  it("fill only the blank fields, spelled as the form writes them", async () => {
    const filled = await applyConnectionDefaults(slcan({ port: "/dev/tty.usb", bitrate: "", silent_mode: false }));
    expect(filled.connection).toMatchObject({
      port: "/dev/tty.usb",
      baud_rate: "230400",
      bitrate: "250000",
      silent_mode: false,
      parity: "none",
    });
  });

  it("give a Modbus profile without a host the table's host, not 127.0.0.1", () => {
    expect(modbusConnectionOf({ connection: {} }, served.modbus_tcp)).toEqual({
      host: "192.168.1.100",
      port: 502,
      unit_id: 1,
    });
    expect(modbusConnectionOf({ connection: { host: "10.0.0.7", unit_id: "3" } }, served.modbus_tcp).host).toBe("10.0.0.7");
  });

  it("show a blank field at the served default", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <IOConnectionFields
          profile={slcan({ port: "" })}
          onUpdateConnectionField={() => {}}
          probe={{} as ConnectionProbe}
          platform={{ isWindows: false, isLinux: false, isMacos: true }}
          canProbeByProfileId={false}
        />,
      ),
    );
    const values = [...document.querySelectorAll("select")].map((s) => s.value);
    expect(values).toContain("250000");
    act(() => root.unmount());
  });
});
