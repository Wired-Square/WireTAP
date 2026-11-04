// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";
import DecoderFramesView from "../apps/decoder/views/DecoderFramesView";
import { LRUMap } from "../utils/LRUMap";
import type { DecodedFrame } from "../stores/decoderStore";
import type { Frame } from "../types/catalogModel";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const frame: Frame = {
  key: "0x005",
  frameId: 0x005,
  protocol: "can",
  length: 2,
  signals: [
    { name: "Coloured", startBit: 0, bitLength: 8, confidence: "high" },
    { name: "Plain", startBit: 8, bitLength: 8, confidence: "low" },
  ],
};

const decodedWith = (bytes: number[]): DecodedFrame => ({
  rawBytes: bytes,
  headerFields: [],
  signals: [
    { name: "Coloured", value: `c${bytes[0]}` },
    { name: "Plain", value: `p${bytes[1]}` },
  ],
});

describe("DecoderFramesView flash", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a flashing signal is emphasised towards the theme's text colour, not white", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (bytes: number[]) => {
      const decoded = new LRUMap<number, DecodedFrame>(10);
      decoded.set(frame.frameId, decodedWith(bytes));
      act(() => {
        root.render(
          <DecoderFramesView
            frames={[frame]}
            selectedIds={new Set(["can:5"])}
            decoded={decoded}
            decodedPerSource={new Map()}
            decodedVersion={bytes[0]}
            viewMode="single"
            displayFrameIdFormat="hex"
            isDecoding={false}
            showRawBytes
            onToggleRawBytes={() => {}}
            isReady
            playbackState="paused"
            onPlay={() => {}}
            onPause={() => {}}
            signalColours={{ high: "#336699" }}
          />,
        );
      });
    };

    render([1, 1]);
    render([2, 2]);

    const styleOf = (text: string) =>
      [...host.querySelectorAll("span")].find((s) => s.textContent === text)?.getAttribute("style");
    const emphasised = "color: color-mix(in srgb, #336699, var(--text-primary) 70%);";
    expect(styleOf("Coloured")).toBe(emphasised);
    expect(styleOf("c2")).toBe(emphasised);
    expect(styleOf("02")).toBe(emphasised);
    expect(styleOf("Plain")).toBe("color: var(--text-primary);");
    expect(styleOf("p2")).toBe("color: var(--text-primary);");
  });
});
