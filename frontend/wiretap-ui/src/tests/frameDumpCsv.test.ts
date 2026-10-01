import { describe, it, expect } from "vitest";
import { frameExportBasename } from "../utils/frameDump";

describe("frameExportBasename", () => {
  it("ends with the protocol as its last dash-separated token, which the CSV importer reads back", () => {
    const date = new Date(2026, 9, 1, 12, 43);
    for (const protocol of ["can", "modbus", "modbus_rtu", "serial"]) {
      const name = frameExportBasename(protocol, date);

      expect(name).toBe(`20261001-1243-${protocol}`);
      expect(name.split("-").pop()).toBe(protocol);
    }
  });

  it("names no protocol it was not told", () => {
    expect(frameExportBasename(undefined, new Date(2026, 9, 1, 12, 43))).toBe("20261001-1243-frames");
  });
});
