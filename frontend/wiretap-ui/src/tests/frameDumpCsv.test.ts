import { describe, it, expect } from "vitest";
import { exportToCsv, frameExportBasename } from "../utils/frameDump";
import type { FrameMessage } from "../types/frame";

const lastColumn = (line: string) => line.split(",").pop();

function frame(bytes: number[]): FrameMessage {
  return { protocol: "serial", timestamp_us: 0, frame_id: 1, bus: 0, dlc: bytes.length, bytes };
}

describe("exportToCsv", () => {
  it("exports every byte of a frame longer than 64", () => {
    const bytes = Array.from({ length: 100 }, (_, i) => i);
    const [header, row] = exportToCsv([frame(bytes)]).split("\n");

    expect(lastColumn(header)).toBe("D100");
    expect(row.split(",").slice(6)).toEqual(
      bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    );
  });

  it("rounds a CAN FD frame's columns up to a valid length", () => {
    const [header] = exportToCsv([frame(Array(9).fill(0))]).split("\n");

    expect(lastColumn(header)).toBe("D12");
  });
});

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
