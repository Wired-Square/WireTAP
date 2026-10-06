// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import FrameDataTable, { type FrameRow } from "../apps/discovery/components/FrameDataTable";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const frame = (over: Partial<FrameRow>): FrameRow => ({ protocol: "can", timestamp_us: 1, frame_id: 0x100, dlc: 2, bytes: [0xaa, 0xbb], ...over });

describe("FrameDataTable marks a received frame's CAN flags", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  async function dataCells(frames: FrameRow[], showAscii = false) {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<FrameDataTable frames={frames} formatTime={String} showAscii={showAscii} />));
    return [...host.querySelectorAll("tbody tr")].map((tr) => tr.lastElementChild!);
  }

  const badges = (cell: Element) => [...cell.querySelectorAll(".badge")].map((b) => b.textContent);

  it("an RTR reads as a remote request for its length, not an empty payload", async () => {
    const [cell] = await dataCells([frame({ is_rtr: true, dlc: 4, bytes: [] })], true);
    expect(cell.textContent).toBe("Remote request for 4 bytes");
  });

  it("an FD frame shows its BRS and ESI flags, and an unflagged frame none", async () => {
    const [flagged, plain] = await dataCells([frame({ is_fd: true, is_brs: true, is_esi: true }), frame({ is_fd: true })]);
    expect(badges(flagged)).toEqual(["BRS", "ESI"]);
    expect(badges(plain)).toEqual([]);
  });
});
