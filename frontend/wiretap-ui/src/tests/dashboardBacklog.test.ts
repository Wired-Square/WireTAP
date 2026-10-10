// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

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
