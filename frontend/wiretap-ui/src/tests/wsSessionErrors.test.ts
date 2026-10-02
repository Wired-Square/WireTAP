// The Rust halves are `session_error_leads_with_its_severity` and
// `subscribe_nack_names_its_session` in ws/protocol.rs; these are their bytes.

import { describe, it, expect } from "vitest";
import { decodeSessionError, decodeSubscribeNack, MsgType, PROTOCOL_VERSION } from "../services/wsProtocol";
import { wsTransport } from "../services/wsTransport";

const utf8 = (s: string) => [...new TextEncoder().encode(s)];

describe("SessionError wire format", () => {
  it("decodes Rust's golden payloads", () => {
    expect(decodeSessionError(new Uint8Array([1, ...utf8("boom")]))).toEqual({ severity: "routine", message: "boom" });
    expect(decodeSessionError(new Uint8Array([0]))).toEqual({ severity: "fault", message: "" });
  });

  it("reads an unknown severity as a fault", () => {
    expect(decodeSessionError(new Uint8Array([9, ...utf8("x")])).severity).toBe("fault");
  });

  // The regexes sessionStore matched before the severity byte, and the messages
  // they classified as routine: the poller's (`a_declined_register_read_names_its_group`
  // in poll.rs), which it now sends as routine. No producer sends the others on 0x04.
  it("keeps routine what the retired regexes held routine", () => {
    const retired = [/^Modbus read error \(.+ @ \d+\):/, /^(Session|Capture)\b.*\bnot found$/];
    const routine = [
      "Modbus read error (holding @ 100): Modbus exception: Illegal data address",
      "Modbus read error (input @ 7): IO error: timed out",
    ];
    for (const message of routine) {
      expect(retired.some((r) => r.test(message))).toBe(true);
      expect(decodeSessionError(new Uint8Array([1, ...utf8(message)]))).toEqual({ severity: "routine", message });
    }
    for (const fault of ["Modbus connection lost: refused", "Stopped polling holding @ 100 after 5 consecutive errors"]) {
      expect(retired.some((r) => r.test(fault))).toBe(false);
    }
  });
});

describe("SubscribeNack", () => {
  it("decodes Rust's golden payloads", () => {
    const view = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);
    expect(decodeSubscribeNack(view([3, 0, ...utf8("f_1"), ...utf8("full")]))).toEqual({ sessionId: "f_1", error: "full" });
    expect(decodeSubscribeNack(view([3, 0, ...utf8("f_1")]))).toEqual({ sessionId: "f_1", error: "" });
  });

  it("rejects the subscribe it names, not the first one pending", async () => {
    const transport = wsTransport as unknown as {
      ws: { send(data: unknown): void } | null;
      handleMessage(buf: ArrayBuffer): void;
    };
    transport.ws = { send: () => {} };
    const message = (msgType: number, payload: number[]) =>
      new Uint8Array([PROTOCOL_VERSION << 4, msgType, 0, 0, ...payload]).buffer;

    const first = wsTransport.subscribe("f_first");
    const named = wsTransport.subscribe("f_named");
    transport.handleMessage(message(MsgType.SubscribeNack, [7, 0, ...utf8("f_named"), ...utf8("full")]));
    await expect(named).rejects.toThrow("full");

    transport.handleMessage(message(MsgType.SubscribeAck, [5, 7, 0, ...utf8("f_first")]));
    await expect(first).resolves.toBe(5);
    transport.ws = null;
  });
});
