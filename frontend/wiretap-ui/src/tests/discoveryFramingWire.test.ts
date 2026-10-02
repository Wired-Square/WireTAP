// Discovery's framing dialog used to translate its "delimiter" into the wire's
// "raw", which the port read as *no framing*. Both now say "delimiter".

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FramingConfig } from "../stores/discoverySerialStore";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => ({
  frame_count: 0,
  capture_id: "c1",
  filtered_count: 0,
  filtered_capture_id: null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../api/settings", () => ({
  tlog: { info: vi.fn(), debug: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { useDiscoverySerialStore } = await import("../stores/discoverySerialStore");

async function wireFor(config: FramingConfig) {
  invoke.mockClear();
  await useDiscoverySerialStore.getState().setFramingConfig(config);
  await useDiscoverySerialStore.getState().applyFraming(null, "s1");
  const call = invoke.mock.calls.find(([cmd]) => cmd === "apply_framing_to_capture");
  return (call?.[1] as { config: Record<string, unknown> }).config;
}

describe("Discovery framing on the wire", () => {
  beforeEach(() => useDiscoverySerialStore.getState().resetFraming());

  it("sends the dialog's delimiter as delimiter, with its bytes and length", async () => {
    const wire = await wireFor({ mode: "delimiter", delimiterHex: "0D0A", maxFrameLength: 512 });
    expect(wire).toMatchObject({ mode: "delimiter", delimiter: "0D0A", max_length: 512 });
  });

  it("sends SLIP and Modbus RTU under their own names", async () => {
    expect((await wireFor({ mode: "slip" })).mode).toBe("slip");
    expect((await wireFor({ mode: "modbus_rtu", validateCrc: true })).mode).toBe("modbus_rtu");
  });
});
