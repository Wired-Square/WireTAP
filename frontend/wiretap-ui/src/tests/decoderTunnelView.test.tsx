// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";
import DecoderTunnelView from "../apps/decoder/views/DecoderTunnelView";
import DecoderFramesView from "../apps/decoder/views/DecoderFramesView";
import { LRUMap } from "../utils/LRUMap";
import type { DecodedFrame, TunnelTransaction } from "../stores/decoderStore";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const base: TunnelTransaction = {
  protocol: "modbus_rtu",
  direction: "response",
  directionBasis: "layout",
  device: 1,
  function: 1,
  functionLabel: "0x01 Read Coils",
  register: 10,
  quantity: 10,
  payload: "coils",
  values: [],
  coils: [true, false, true, false, true, false, true, true, false, true],
  data: [0x02, 0xd5, 0x02],
  raw: [0x01, 0x01, 0x02, 0xd5, 0x02, 0x00, 0x00],
  frames: 1,
  crcValid: true,
  frameId: 0x1e0,
  bus: 0,
  timestampUs: 1_000_000,
};

describe("DecoderTunnelView", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (t: Partial<TunnelTransaction>) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <DecoderTunnelView
          transactions={[{ ...base, ...t }]}
          displayFrameIdFormat="hex"
          useLocalTimezone={false}
        />,
      );
    });
    return host.textContent ?? "";
  };

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows coil states from their first address", () => {
    expect(render({})).toContain("Coils [10] 10101011 01");
  });

  it("shows no values line for a message without values", () => {
    const text = render({ direction: "request", payload: "none", coils: [], data: [0, 10, 0, 10] });
    expect(text).not.toContain("Coils [");
    expect(text).not.toContain("00 0A 00 0A");
  });

  it("marks a direction sided by alternation as guessed", () => {
    expect(render({ directionBasis: "alternation", payload: "opaque", coils: [] })).toContain("guessed");
  });

  it("leaves a paired direction unmarked", () => {
    expect(render({ directionBasis: "pairing" })).not.toContain("guessed");
  });
});

describe("DecoderFramesView's Modbus tab", () => {
  it("shows no Modbus rows once the catalogue has no tunnel, even while the tab was active", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <DecoderFramesView
          frames={[]}
          selectedIds={new Set()}
          decoded={new LRUMap<number, DecodedFrame>(1)}
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
          activeTab="tunnel"
          hasTunnel={false}
          tunnelTransactions={[base]}
        />,
      );
    });
    const text = host.textContent ?? "";
    act(() => root.unmount());
    host.remove();
    expect(text).not.toContain("Coils [");
  });
});
