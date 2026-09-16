// Which toolbox tools a Discovery session offers.
//
// The bug: Serial Payload was gated on serial *mode*, which means "the source emits a raw
// byte stream". A source that frames in the backend (SLIP) delivers serial frames without
// ever emitting raw bytes, so the tool written for framed serial data was hidden from
// exactly those sessions.

import { describe, it, expect } from "vitest";
import {
  toolNeeds,
  isToolApplicable,
  hasToolData,
  type SessionShape,
  type ToolRequirements,
} from "../dialogs/toolboxGating";

const frameOrder: ToolRequirements = {};
const serialFraming: ToolRequirements = { serialRequires: "bytes" };
const serialPayload: ToolRequirements = { serialRequires: "frames" };
const modbusScan: ToolRequirements = { modbusRequires: true };

const session = (over: Partial<SessionShape> = {}): SessionShape => ({
  isSerialMode: false,
  isSerialProtocol: false,
  hasSource: false,
  ...over,
});

/** A serial source that frames in the backend: serial frames, no raw byte stream. */
const framedSerial = session({ isSerialProtocol: true });
/** A serial source handing over an unframed byte stream. */
const rawSerial = session({ isSerialMode: true, isSerialProtocol: true });

describe("toolNeeds", () => {
  it("classifies each tool by the data it works on", () => {
    expect(toolNeeds(frameOrder)).toBe("frames");
    expect(toolNeeds(serialFraming)).toBe("serial-bytes");
    expect(toolNeeds(serialPayload)).toBe("serial-frames");
    expect(toolNeeds(modbusScan)).toBe("modbus");
  });
});

describe("isToolApplicable", () => {
  it("offers Serial Payload to a source that frames in the backend", () => {
    // The regression test: this was false, so the tool never reached the menu.
    expect(isToolApplicable(serialPayload, framedSerial)).toBe(true);
  });

  it("does not offer Serial Framing without a raw byte stream to frame", () => {
    expect(isToolApplicable(serialFraming, framedSerial)).toBe(false);
    expect(isToolApplicable(serialFraming, rawSerial)).toBe(true);
  });

  it("keeps the frame tools for a framed-serial session", () => {
    // Those sessions have frames, and they were already getting these tools — the fix
    // must add Serial Payload without taking anything away.
    expect(isToolApplicable(frameOrder, framedSerial)).toBe(true);
  });

  it("hides the frame tools while a serial source is still an unframed stream", () => {
    expect(isToolApplicable(frameOrder, rawSerial)).toBe(false);
  });

  it("leaves a raw-byte serial session exactly as it was", () => {
    expect(isToolApplicable(serialFraming, rawSerial)).toBe(true);
    expect(isToolApplicable(serialPayload, rawSerial)).toBe(true);
    expect(isToolApplicable(frameOrder, rawSerial)).toBe(false);
  });

  it("leaves a plain CAN session exactly as it was", () => {
    const can = session({ hasSource: true });
    expect(isToolApplicable(frameOrder, can)).toBe(true);
    expect(isToolApplicable(serialFraming, can)).toBe(false);
    expect(isToolApplicable(serialPayload, can)).toBe(false);
  });

  it("lists the modbus tools whatever the session is", () => {
    // A sweep names its own device and needs neither a session nor a catalogue,
    // so no session shape rules it out — the source only ever withholds it,
    // which is `hasToolData`'s job.
    for (const shape of [session(), session({ hasSource: true }), rawSerial, framedSerial]) {
      expect(isToolApplicable(modbusScan, shape)).toBe(true);
    }
  });
});

describe("hasToolData", () => {
  const counts = { frameCount: 0, serialFrameCount: 0, serialBytesCount: 0 };

  it("enables Serial Payload on its own frame count, not the capture's", () => {
    // Previously the !isSerialMode branch answered first and returned frameCount > 0,
    // so a framed-serial session judged the tool by the wrong number entirely.
    expect(hasToolData(serialPayload, framedSerial, { ...counts, serialFrameCount: 12 })).toBe(true);
    expect(hasToolData(serialPayload, framedSerial, { ...counts, frameCount: 12 })).toBe(false);
  });

  it("enables Serial Framing on the byte count", () => {
    expect(hasToolData(serialFraming, rawSerial, { ...counts, serialBytesCount: 5 })).toBe(true);
    expect(hasToolData(serialFraming, rawSerial, counts)).toBe(false);
  });

  it("enables the frame tools on the frame count", () => {
    expect(hasToolData(frameOrder, session(), { ...counts, frameCount: 3 })).toBe(true);
    expect(hasToolData(frameOrder, session(), counts)).toBe(false);
  });

  it("enables the modbus tools at No source, with no frames needed", () => {
    // A sweep produces frames rather than consuming them, so having captured
    // nothing is no obstacle. What it needs is the device to itself.
    expect(hasToolData(modbusScan, session(), counts)).toBe(true);
  });

  it("holds the modbus tools back while any source is selected", () => {
    // Listed but not runnable: a sweep takes the view over to show its results,
    // and joining its session destroys whichever session was selected. Not just
    // a Modbus source — any source at all.
    const withSource = session({ hasSource: true });
    expect(isToolApplicable(modbusScan, withSource)).toBe(true);
    expect(hasToolData(modbusScan, withSource, counts)).toBe(false);
    const serialSource = session({ ...rawSerial, hasSource: true });
    expect(hasToolData(modbusScan, serialSource, counts)).toBe(false);
  });
});
