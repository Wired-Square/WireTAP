import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useTransmitStore } from "../stores/transmitStore";

const editor = () => useTransmitStore.getState();

beforeEach(() => {
  editor().resetCanEditor();
  editor().updateCanEditor({ frameId: "123" });
});

describe("the CAN editor builds only frames the wire can carry", () => {
  it("an FD frame is never remote", () => {
    editor().updateCanEditor({ isRtr: true });
    editor().updateCanEditor({ isFd: true });
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: true, is_rtr: false });
  });

  it("a classic frame never switches bit rate", () => {
    editor().updateCanEditor({ isFd: true });
    editor().updateCanEditor({ isBrs: true });
    editor().updateCanEditor({ isFd: false });
    expect(editor().buildCanFrame()).toMatchObject({ is_fd: false, is_brs: false });
  });
});
