// @vitest-environment jsdom
// The Rust half is `transmit_queue::tests`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { QueueRow } from "../generated/QueueRow";
import type { TransmitQueue } from "../generated/TransmitQueue";

let held: TransmitQueue = { revision: 0, rows: [], active_groups: [] };
const invoke = vi.fn(async (cmd: string) => (cmd === "transmit_queue_get" ? held : null));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
const openPanel = vi.fn();
vi.mock("../utils/windowCommunication", () => ({ openPanel }));

const { useTransmitStore } = await import("../stores/transmitStore");
const { useTransmitQueueSync } = await import("../hooks/useTransmitQueueSync");
const { wsTransport } = await import("../services/wsTransport");
const { MsgType, HEADER_SIZE, PROTOCOL_VERSION } = await import("../services/wsProtocol");

const row = (id: string, over: Partial<QueueRow> = {}): QueueRow => ({
  id,
  session_id: "f_1",
  profile_id: "p",
  profile_name: "n",
  payload: { kind: "can", frame: { frame_id: 1, data: [1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false } },
  interval_ms: 100,
  enabled: true,
  group: null,
  origin: "user",
  repeating: false,
  last_error: null,
  ...over,
});

/** A `TransmitQueue` message as `ws::dispatch::send_transmit_queue` frames it. */
function wsMessage(queue: TransmitQueue): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(queue));
  const buf = new Uint8Array(HEADER_SIZE + json.length);
  buf.set([PROTOCOL_VERSION << 4, MsgType.TransmitQueue, 0, 0]);
  buf.set(json, HEADER_SIZE);
  return buf.buffer;
}

let push: (queue: TransmitQueue) => void = () => {};
let reconnect: () => void = () => {};
vi.spyOn(wsTransport, "onGlobalMessage").mockImplementation((msgType, handler) => {
  if (msgType === MsgType.TransmitQueue) push = (queue) => {
    const raw = wsMessage(queue);
    handler(new DataView(raw, HEADER_SIZE), raw);
  };
  return () => {};
});
vi.spyOn(wsTransport, "onReconnect").mockImplementation((handler) => {
  reconnect = handler;
  return () => {};
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const ids = () => useTransmitStore.getState().queue.map((q) => q.id);

beforeEach(() => {
  useTransmitStore.setState({ queue: [], queueRevision: -1, activeGroups: new Set() });
  openPanel.mockClear();
});

describe("a window's view of the Rust Transmit queue", () => {
  it("reads the queue on mount, takes each push, and reads it again after a reconnect", async () => {
    held = { revision: 3, rows: [row("tx-1")], active_groups: [] };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(() => (useTransmitQueueSync(), null))));
    await settle();
    expect(ids()).toEqual(["tx-1"]);

    act(() => push({ revision: 4, rows: [row("tx-1"), row("tx-2", { group: "g", repeating: true })], active_groups: ["g"] }));
    expect(ids()).toEqual(["tx-1", "tx-2"]);
    expect([...useTransmitStore.getState().activeGroups]).toEqual(["g"]);

    held = { revision: 9, rows: [], active_groups: [] };
    reconnect();
    await settle();
    expect(ids()).toEqual([]);
    root.unmount();
  });

  it("opens the Transmit panel when an agent's repeat starts, not for a human's or a reload", async () => {
    held = { revision: 1, rows: [row("tx-a", { origin: "agent", repeating: true })], active_groups: [] };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(() => (useTransmitQueueSync(), null))));
    await settle();
    expect(openPanel).not.toHaveBeenCalled();

    act(() => push({ revision: 2, rows: [...held.rows, row("tx-u", { repeating: true })], active_groups: [] }));
    expect(openPanel).not.toHaveBeenCalled();

    act(() => push({ revision: 3, rows: [row("tx-b", { origin: "agent", repeating: true })], active_groups: [] }));
    expect(openPanel).toHaveBeenCalledWith("transmit");
    root.unmount();
  });
});
