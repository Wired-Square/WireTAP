// The Rust half is `the_inventory_is_sent_whole_on_subscribe_then_only_as_it_changes`
// in ws/dispatch.rs.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
import { applyFrameInventory } from "../stores/sessionStore";
import type { CaptureFrameInfo } from "../generated/CaptureFrameInfo";

const row = (protocol: string, frame_id: number, max_dlc = 8): CaptureFrameInfo => ({
  protocol,
  frame_id,
  max_dlc,
  bus: 0,
  is_extended: false,
  has_dlc_mismatch: false,
});

describe("applyFrameInventory", () => {
  it("replaces only the identities a delta carries", () => {
    const held = applyFrameInventory(undefined, { reset: true, rows: [row("can", 1), row("modbus", 1)] });
    const next = applyFrameInventory(held, { reset: false, rows: [row("can", 1, 12)] });
    expect([...next.keys()]).toEqual(["can:1", "modbus:1"]);
    expect(next.get("can:1")?.max_dlc).toBe(12);
    expect(held.get("can:1")?.max_dlc).toBe(8);
  });

  it("drops what it held on a reset", () => {
    const held = applyFrameInventory(undefined, { reset: true, rows: [row("can", 1)] });
    expect(applyFrameInventory(held, { reset: true, rows: [] }).size).toBe(0);
  });
});
