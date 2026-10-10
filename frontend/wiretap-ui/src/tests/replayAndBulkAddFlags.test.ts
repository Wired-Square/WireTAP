// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { useTransmitStore } from "../stores/transmitStore";
import type { Session } from "../stores/sessionStore";
import type { NewQueueRow } from "../api/transmit";

const received = { timestamp_us: 0, frame_id: 0x123, bus: 0, is_extended: false };
const session = { id: "f_x", profileId: "p", profileName: "p" } as unknown as Session;
const queued = () =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === "transmit_queue_add")
    .flatMap(([, args]) => (args as { rows: NewQueueRow[] }).rows.map((row) => row.payload.kind === "can" && row.payload.frame));

beforeEach(() => vi.mocked(invoke).mockClear());

describe("bulk Add to Transmit queues a frame as received", () => {
  it("a bulk-added RTR queues as an RTR for its requested length", async () => {
    await useTransmitStore.getState().addCanFramesBulk([{ ...received, dlc: 4, bytes: [], is_rtr: true }], session);
    expect(queued()).toMatchObject([{ is_rtr: true, data: [0, 0, 0, 0] }]);
  });

  it("a bulk-added FD frame queues as FD with its bit rate switch", async () => {
    await useTransmitStore.getState().addCanFramesBulk([{ ...received, dlc: 12, bytes: Array(12).fill(1), is_fd: true, is_brs: true }], session);
    expect(queued()).toMatchObject([{ is_fd: true, is_brs: true }]);
  });
});
