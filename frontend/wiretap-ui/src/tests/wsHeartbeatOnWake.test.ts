// @vitest-environment jsdom
// A webview waking from display sleep sends its WS heartbeat at once, which is what
// re-attaches the subscribers the Rust watchdog parked (`touch_subscriber_heartbeats`).

import { describe, it, expect, vi } from "vitest";
import { MsgType, decodeHeader, encodeAuth } from "../services/wsProtocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ port: 1, token: "t" })) }));

const sent: ArrayBuffer[] = [];

class FakeSocket {
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({ data: encodeAuth("") });
    });
  }
  send(buf: ArrayBuffer) {
    sent.push(buf);
  }
  close() {}
}
vi.stubGlobal("WebSocket", FakeSocket);

const { wsTransport } = await import("../services/wsTransport");

const heartbeats = () => sent.filter((buf) => decodeHeader(buf).msgType === MsgType.Heartbeat).length;

describe("the WS heartbeat on wake", () => {
  it("goes out once when the page becomes visible", async () => {
    await wsTransport.connect();
    const before = heartbeats();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(heartbeats()).toBe(before + 1);
    wsTransport.disconnect();
  });
});
