// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { toReplayFrame } from "../api/transmit";
import { useTransmitStore } from "../stores/transmitStore";
import type { Session } from "../stores/sessionStore";

const received = { timestamp_us: 0, frame_id: 0x123, bus: 0, is_extended: false };
const session = { id: "f_x", profileId: "p", profileName: "p" } as unknown as Session;
const queued = () => useTransmitStore.getState().queue.map((row) => row.canFrame);

beforeEach(() => useTransmitStore.setState({ queue: [] }));

describe("replay sends a frame as received", () => {
  it("a replayed RTR goes out as an RTR for its requested length", () => {
    const { frame } = toReplayFrame({ ...received, dlc: 4, bytes: [], is_rtr: true });
    expect(frame).toMatchObject({ is_rtr: true, data: [0, 0, 0, 0] });
  });

  it("a replayed FD frame keeps its bit rate switch", () => {
    const { frame } = toReplayFrame({ ...received, dlc: 12, bytes: Array(12).fill(1), is_fd: true, is_brs: true });
    expect(frame).toMatchObject({ is_fd: true, is_brs: true });
  });
});

describe("bulk Add to Transmit queues a frame as received", () => {
  it("a bulk-added RTR queues as an RTR for its requested length", () => {
    useTransmitStore.getState().addCanFramesBulk([{ ...received, dlc: 4, bytes: [], is_rtr: true }], session);
    expect(queued()).toMatchObject([{ is_rtr: true, data: [0, 0, 0, 0] }]);
  });

  it("a bulk-added FD frame queues as FD with its bit rate switch", () => {
    useTransmitStore.getState().addCanFramesBulk([{ ...received, dlc: 12, bytes: Array(12).fill(1), is_fd: true, is_brs: true }], session);
    expect(queued()).toMatchObject([{ is_fd: true, is_brs: true }]);
  });
});
