import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useTransmitStore } from "../stores/transmitStore";
import { canEditorFromFrame } from "../apps/discovery/components/frameContextMenuItems";
import type { FrameRow } from "../apps/discovery/components";
import { canEditorFromDecoded, canEditorFromUnmatched } from "../apps/decoder/canEditorFromDecoder";
import type { DecodedFrame, UnmatchedFrame } from "../stores/decoderStore";

const editor = () => useTransmitStore.getState();

const received = (over: Partial<FrameRow>): FrameRow => ({
  timestamp_us: 0,
  frame_id: 0x123,
  protocol: "can",
  dlc: 8,
  bytes: Array(8).fill(0x11),
  ...over,
});

beforeEach(() => editor().resetCanEditor());

describe("Discovery's Send to Transmit loads the frame as received", () => {
  it("send to transmit keeps a short FD frame FD", () => {
    editor().updateCanEditor(canEditorFromFrame(received({ is_fd: true })));
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: true, data: Array(8).fill(0x11) });
  });

  it("send to transmit makes a classic frame classic in an FD editor", () => {
    editor().updateCanEditor({ isFd: true });
    editor().updateCanEditor(canEditorFromFrame(received({ is_fd: false })));
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: false });
  });

  it("send to transmit keeps an FD frame's bit rate switch", () => {
    editor().updateCanEditor(canEditorFromFrame(received({ is_fd: true, is_brs: true })));
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: true, is_brs: true });
  });

  it("send to transmit loads an RTR as a remote request for its length, with no data", () => {
    editor().updateCanEditor({ data: [9, 9, 9, 9, 9, 9, 9, 9] });
    editor().updateCanEditor(canEditorFromFrame(received({ is_rtr: true, dlc: 4, bytes: [] })));
    expect(editor().buildCanFrame()).toMatchObject({ is_rtr: true, is_fd: false, data: [0, 0, 0, 0] });
  });
});

describe("the Decoder's Send to Transmit loads the frame as received", () => {
  const detail = { id: 0x123, len: 8, signals: [] };
  const decoded = (over: Partial<DecodedFrame>): DecodedFrame => ({
    signals: [],
    rawBytes: Array(8).fill(0x11),
    headerFields: [],
    dlc: 8,
    ...over,
  });
  const unmatched = (over: Partial<UnmatchedFrame>): UnmatchedFrame => ({
    frameId: 0x123,
    bytes: Array(8).fill(0x11),
    dlc: 8,
    timestamp: 0,
    ...over,
  });

  it("a decoded or unmatched FD frame keeps its bit rate switch", () => {
    editor().updateCanEditor(canEditorFromDecoded(detail, decoded({ isFd: true, isBrs: true })));
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: true, is_brs: true });
    editor().resetCanEditor();
    editor().updateCanEditor(canEditorFromUnmatched(unmatched({ isFd: true, isBrs: true })));
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: true, is_brs: true });
  });

  it("a decoded frame is sent at its received length, not the catalogue's", () => {
    editor().updateCanEditor(canEditorFromDecoded(detail, decoded({ rawBytes: [1, 2, 3, 4], dlc: 4 })));
    expect(editor().buildCanFrame()).toMatchObject({ data: [1, 2, 3, 4] });
  });

  it("a decoded frame is sent with its received id, not the catalogue's masked one", () => {
    const masked = { id: 0x18ef0000, len: 8, signals: [], isExtended: true };
    editor().updateCanEditor(canEditorFromDecoded(masked, decoded({ frameId: 0x18ef0042, isExtended: true })));
    expect(editor().buildCanFrame()).toMatchObject({ frame_id: 0x18ef0042 });
  });

  it("a decoded or unmatched frame keeps its received id format and bus", () => {
    editor().updateCanEditor(canEditorFromDecoded(detail, decoded({ isExtended: true, bus: 2 })));
    expect(editor().buildCanFrame()).toMatchObject({ is_extended: true, bus: 2 });
    editor().resetCanEditor();
    editor().updateCanEditor(canEditorFromUnmatched(unmatched({ isExtended: true, bus: 1 })));
    expect(editor().buildCanFrame()).toMatchObject({ is_extended: true, bus: 1 });
  });

  it("an unmatched RTR arrives as a remote request for its received length", () => {
    editor().updateCanEditor(canEditorFromUnmatched(unmatched({ isRtr: true, dlc: 6, bytes: [] })));
    expect(editor().buildCanFrame()).toMatchObject({ is_rtr: true, data: Array(6).fill(0) });
  });
});
