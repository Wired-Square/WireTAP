// What the picker sends when you ask a Modbus session to poll a range.
//
// Both "no" answers matter more than the "yes": a spec built when the user did
// not ask for one puts continuous traffic on someone's device, and a spec built
// from a backwards range would ask Rust to chunk a negative span.

import { describe, it, expect } from "vitest";
import {
  pollSpecFor,
  DEFAULT_MODBUS_POLL_CONFIG,
} from "../dialogs/io-source-picker/ModbusPollConfig";

describe("pollSpecFor", () => {
  it("polls nothing by default", () => {
    // A source picked but not configured must connect silently, not start
    // reading a device the user never pointed it at.
    expect(pollSpecFor(DEFAULT_MODBUS_POLL_CONFIG)).toBeNull();
    expect(pollSpecFor(undefined)).toBeNull();
  });

  it("builds one range from the enabled config", () => {
    expect(
      pollSpecFor({
        enabled: true,
        registerType: "input",
        start: 100,
        end: 199,
        intervalMs: 500,
      })
    ).toEqual({
      ranges: [{ register_type: "input", start: 100, end: 199 }],
      interval_ms: 500,
    });
  });

  it("accepts a single-register range", () => {
    // start === end is one register, not an empty span — the boundary the
    // start > end check must not swallow.
    expect(pollSpecFor({ ...DEFAULT_MODBUS_POLL_CONFIG, enabled: true, start: 7, end: 7 }))
      .toMatchObject({ ranges: [{ start: 7, end: 7 }] });
  });

  it("refuses a backwards range", () => {
    expect(
      pollSpecFor({ ...DEFAULT_MODBUS_POLL_CONFIG, enabled: true, start: 200, end: 100 })
    ).toBeNull();
  });

  it("carries the profile's unit id, and omits it rather than guessing", () => {
    // Without it Rust defaults the slave to 1 and the poll loop sets that per
    // request — so a profile on unit 5 would read unit 5's socket for unit 1's
    // registers, and the frames would be bussed under the wrong address too.
    const enabled = { ...DEFAULT_MODBUS_POLL_CONFIG, enabled: true };
    expect(pollSpecFor(enabled, 5)).toMatchObject({ device_address: 5 });
    expect(pollSpecFor(enabled)).not.toHaveProperty("device_address");
  });
});
