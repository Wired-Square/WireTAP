import { describe, it, expect } from "vitest";
import { exportProtocol } from "../apps/discovery/exportProtocol";

describe("Discovery's export protocol", () => {
  it("a framed byte capture is named for what the framer stamped, not the line", () => {
    expect(exportProtocol("frames", "modbus_rtu", "serial")).toBe("modbus_rtu");
  });

  it("raw bytes are serial, and unframed frames keep their own protocol", () => {
    expect(exportProtocol("bytes", "modbus_rtu", "serial")).toBe("serial");
    expect(exportProtocol("frames", undefined, "can")).toBe("can");
  });
});
