import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useTransmitStore } from "../stores/transmitStore";
import { canEditorFromFrame } from "../apps/discovery/components/frameContextMenuItems";
import type { FrameRow } from "../apps/discovery/components";

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
});
