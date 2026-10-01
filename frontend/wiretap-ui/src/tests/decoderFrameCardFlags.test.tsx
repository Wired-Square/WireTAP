// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";
import DecoderFramesView from "../apps/decoder/views/DecoderFramesView";
import { LRUMap } from "../utils/LRUMap";
import type { DecodedFrame } from "../stores/decoderStore";
import type { FrameDetail } from "../types/decoder";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const frame: FrameDetail = {
  id: 0x005,
  len: 8,
  mirrorOf: "0x705",
  signals: [
    { name: "Differs", start_bit: 0, bit_length: 8, _inherited: true },
    { name: "Agrees", start_bit: 8, bit_length: 8, _inherited: true },
    { name: "Uncompared", start_bit: 24, bit_length: 8, _inherited: true },
  ],
};

const decodedFrame: DecodedFrame = {
  rawBytes: [1, 2, 3, 4, 5, 6, 7, 0x2a],
  headerFields: [],
  checksum: { extracted: 0x2a, calculated: 0x2b, valid: false },
  signals: [
    { name: "Differs", value: "1", mirrorMismatch: true },
    { name: "Agrees", value: "2", mirrorMismatch: false },
    { name: "Uncompared", value: "4" },
  ],
};

describe("DecoderFramesView reads Rust's verdicts", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the checksum and per-signal mirror flags as they arrive", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const decoded = new LRUMap<number, DecodedFrame>(10);
    decoded.set(frame.id, decodedFrame);
    act(() => {
      root.render(
        <DecoderFramesView
          frames={[frame]}
          selectedIds={new Set(["can:5"])}
          decoded={decoded}
          decodedPerSource={new Map()}
          decodedVersion={1}
          viewMode="single"
          displayFrameIdFormat="hex"
          isDecoding={false}
          showRawBytes={false}
          onToggleRawBytes={() => {}}
          isReady
          playbackState="paused"
          onPlay={() => {}}
          onPause={() => {}}
        />,
      );
    });

    expect(host.textContent).toContain("Checksum: 0x2A");
    const flag = (title: string) => host.querySelectorAll(`[title="${title}"]`).length;
    expect(flag("Mismatch with source frame 0x705")).toBe(1);
    expect(flag("Matches source frame 0x705")).toBe(1);
    expect(flag("Inherited from 0x705")).toBe(1);
  });
});
