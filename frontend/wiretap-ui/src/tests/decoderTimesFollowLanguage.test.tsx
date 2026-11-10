// @vitest-environment jsdom

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const { default: i18n } = await import("../i18n");
const { default: DecoderFramesView, RawFrameRow } = await import("../apps/decoder/views/DecoderFramesView");
const { LRUMap } = await import("../utils/LRUMap");
import type { DecodedFrame } from "../stores/decoderStore";
import type { Frame } from "../types/catalogModel";

const finnishClock = /\d{2}\.\d{2}\.\d{2}/;
const timestamp = 1_780_000_000.25;

describe("the Decoder's times follow the chosen language", () => {
  beforeAll(() => i18n.changeLanguage("fi"));
  afterAll(() => i18n.changeLanguage("en-AU"));

  it("a signal's last-update time", () => {
    const frame: Frame = { key: "0x005", frameId: 0x005, protocol: "can", length: 8, signals: [{ name: "Speed", startBit: 0, bitLength: 8 }] };
    const decoded = new LRUMap<number, DecodedFrame>(10);
    decoded.set(frame.frameId, { rawBytes: [1, 2, 3, 4, 5, 6, 7, 8], headerFields: [], signals: [{ name: "Speed", value: "1", timestamp }] });
    const markup = renderToStaticMarkup(
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
    expect(markup).toMatch(finnishClock);
  });

  it("an unmatched frame's time", () => {
    const markup = renderToStaticMarkup(
      <RawFrameRow
        frame={{ frameId: 0x100, bytes: [0xaa], dlc: 1, timestamp, protocol: "can" }}
        displayFrameIdFormat="hex"
        showAscii={false}
        onContextMenu={() => {}}
      />,
    );
    expect(markup).toMatch(finnishClock);
  });
});
