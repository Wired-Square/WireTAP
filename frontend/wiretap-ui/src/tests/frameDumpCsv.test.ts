import { describe, it, expect } from "vitest";
import { exportToCsv } from "../utils/frameDump";
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
