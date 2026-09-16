// Composite frame-key helpers.
//
// Frame identity is (protocol, frame_id): CAN 0x100 and Modbus register 256 are distinct
// frames that share a numeric id. These helpers are the only place that grammar lives.

import { describe, it, expect } from "vitest";
import { frameKey, parseFrameKey, keyOf, groupKeysByProtocol } from "../utils/frameKey";

describe("frameKey", () => {
  it("round-trips protocol and id", () => {
    expect(parseFrameKey(frameKey("can", 256))).toEqual({ protocol: "can", frameId: 256 });
    expect(parseFrameKey(frameKey("modbus", 5013))).toEqual({ protocol: "modbus", frameId: 5013 });
  });

  it("keys the same numeric id under two protocols apart", () => {
    expect(frameKey("can", 256)).not.toBe(frameKey("modbus", 256));
  });

  it("builds the same key from a frame as from its parts", () => {
    expect(keyOf({ protocol: "can", frame_id: 256 })).toBe(frameKey("can", 256));
  });
});

describe("groupKeysByProtocol", () => {
  it("groups keys under their protocol", () => {
    const groups = groupKeysByProtocol(["can:256", "can:257", "modbus:256"]);

    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.protocol === "can")?.frame_ids).toEqual([256, 257]);
    expect(groups.find((g) => g.protocol === "modbus")?.frame_ids).toEqual([256]);
  });

  it("does not collapse the same numeric id across protocols", () => {
    const groups = groupKeysByProtocol(["can:256", "modbus:256"]);

    expect(groups.flatMap((g) => g.frame_ids)).toEqual([256, 256]);
    expect(groups.map((g) => g.protocol).sort()).toEqual(["can", "modbus"]);
  });

  it("returns nothing for an empty selection, which reads as no filter", () => {
    expect(groupKeysByProtocol([])).toEqual([]);
    expect(groupKeysByProtocol(new Set<string>())).toEqual([]);
  });

  it("accepts a Set, which is how selections are held", () => {
    expect(groupKeysByProtocol(new Set(["can:256"]))).toEqual([
      { protocol: "can", frame_ids: [256] },
    ]);
  });
});
