// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { RawFrameRow } from "../apps/decoder/views/DecoderFramesView";
import type { UnmatchedFrame } from "../stores/decoderStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const frame = (over: Partial<UnmatchedFrame>): UnmatchedFrame => ({ frameId: 0x100, bytes: [0xaa, 0xbb], dlc: 2, timestamp: 1, protocol: "can", ...over });

describe("the Decoder's Unmatched and Filtered rows mark a frame's CAN flags as Discovery does", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  async function row(f: UnmatchedFrame) {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<RawFrameRow frame={f} displayFrameIdFormat="hex" showAscii={false} onContextMenu={() => {}} />));
    return host;
  }

  const badges = (host: Element) => [...host.querySelectorAll(".badge")].map((b) => b.textContent);

  it("an RTR reads as a remote request for its length, not an empty payload", async () => {
    const host = await row(frame({ isRtr: true, dlc: 4, bytes: [] }));
    expect(host.textContent).toContain("Remote request for 4 bytes");
    expect(host.textContent).not.toContain("[0]");
  });

  it("an FD frame shows its BRS and ESI flags, and an unflagged frame none", async () => {
    expect(badges(await row(frame({ isFd: true, isBrs: true, isEsi: true })))).toEqual(["BRS", "ESI"]);
    act(() => root.unmount());
    expect(badges(await row(frame({ isFd: true })))).toEqual([]);
  });
});
