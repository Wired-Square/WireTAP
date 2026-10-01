// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

import { useDashboardStore, readTimeSeries, type SignalValueEntry } from "../stores/dashboardStore";
import { deliverDecodedBacklog, type SessionCallbacks } from "../stores/sessionStore";
import type { DecodedSignalsEntry } from "../services/wsProtocol";

function backlogPayload(subscriber: string, decoded: unknown[]): DataView {
  const name = new TextEncoder().encode(subscriber);
  const body = new TextEncoder().encode(JSON.stringify(decoded));
  const bytes = new Uint8Array(2 + name.length + body.length);
  new DataView(bytes.buffer).setUint16(0, name.length);
  bytes.set(name, 2);
  bytes.set(body, 2 + name.length);
  return new DataView(bytes.buffer);
}

describe("an attach's decoded backlog", () => {
  it("reaches only the subscriber that attached", () => {
    const received: Record<string, [DecodedSignalsEntry[], boolean][]> = { decoder: [], dashboard: [] };
    const subscriber = (name: string): SessionCallbacks => ({
      onDecoded: (decoded, backlog) => received[name].push([decoded, backlog]),
    });
    const callbacks = new Map([
      ["main_decoder", subscriber("decoder")],
      ["main_dashboard", subscriber("dashboard")],
    ]);
    const entry = { maskedFrameId: 0x100, t: 1, signals: [] };

    deliverDecodedBacklog(callbacks, backlogPayload("main_dashboard", [entry]));

    expect(received.decoder).toEqual([]);
    expect(received.dashboard).toEqual([[[entry], true]]);
  });
});

const soc = (replace: boolean, ...pairs: Array<[number, number]>): SignalValueEntry[] =>
  pairs.map(([timestamp, value]) => ({ frameId: 0x100, signalName: "soc", value, timestamp, replace }));

const push = (entries: SignalValueEntry[]) => useDashboardStore.getState().pushSignalValues(entries);

function series(key = "256:soc") {
  const s = useDashboardStore.getState().seriesBuffers.get(key)!;
  const { timestamps, values } = readTimeSeries(s);
  return { timestamps, values, latestValue: s.latestValue, min: s.min, max: s.max, sum: s.sum, sampleCount: s.sampleCount };
}

describe("the Dashboard's own backlog", () => {
  beforeEach(() => useDashboardStore.getState().clearData());

  it("replaces a signal's series rather than appending to it", () => {
    push(soc(false, [1, 10], [2, 20], [3, 30]));
    push(soc(true, [1, 10], [2, 20], [3, 30]));
    expect(series()).toEqual({
      timestamps: [1, 2, 3],
      values: [10, 20, 30],
      latestValue: 30,
      min: 10,
      max: 30,
      sum: 60,
      sampleCount: 3,
    });
  });

  it("replaces live samples queued before it, and keeps those after it", () => {
    push([...soc(false, [1, 10], [2, 20]), ...soc(true, [1, 10], [2, 20]), ...soc(false, [3, 5])]);
    expect(series()).toMatchObject({ timestamps: [1, 2, 3], latestValue: 5, min: 5, sum: 35, sampleCount: 3 });
  });

  it("leaves a series it does not carry alone", () => {
    push([{ frameId: 0x100, signalName: "byte[0]", value: 7, timestamp: 1 }]);
    push(soc(true, [2, 20]));
    expect(series("256:byte[0]")).toMatchObject({ timestamps: [1], sampleCount: 1 });
  });
});
