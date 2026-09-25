// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const pageFetch = vi.fn(async () => ({ frames: [], capture_indices: [], total_count: 0 }));
vi.mock("../api/capture", () => ({
  getCaptureFramesPaginatedFiltered: pageFetch,
  getCaptureFramesTail: vi.fn(),
  getCaptureMetadataById: vi.fn(async () => null),
  findCaptureOffsetForTimestamp: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { framedSource } = await import("../stores/discoverySerialStore");
const { useCaptureFrameView } = await import("../apps/discovery/hooks/useCaptureFrameView");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("framedSource", () => {
  const session = { captureId: "cap_session", frameCount: 795 };

  it("reads a reader-framed session's own capture and its count together", () => {
    expect(framedSource({ framedCaptureId: null, backendFrameCount: 231 }, session)).toEqual({
      captureId: "cap_session",
      frameCount: 795,
      readerFramed: true,
    });
  });

  it("prefers client-side framing's derived capture, with the count framing returned", () => {
    expect(framedSource({ framedCaptureId: "cap_framed", backendFrameCount: 40 }, session)).toEqual({
      captureId: "cap_framed",
      frameCount: 40,
      readerFramed: false,
    });
  });

  it("has nothing to page on a byte session before framing", () => {
    expect(
      framedSource({ framedCaptureId: null, backendFrameCount: 0 }, { captureId: null, frameCount: 12 }),
    ).toEqual({ captureId: null, frameCount: 0, readerFramed: false });
  });
});

describe("useCaptureFrameView revision", () => {
  it("refetches a capture refilled under the same id", async () => {
    const root = createRoot(document.createElement("div"));
    const selection: never[] = [];
    function View({ revision }: { revision: number }) {
      useCaptureFrameView({ captureId: "cap_framed", isStreaming: false, selectedFrames: selection, pageSize: 20, revision });
      return null;
    }

    await act(async () => root.render(<View revision={0} />));
    const before = pageFetch.mock.calls.length;
    await act(async () => root.render(<View revision={1} />));

    expect(pageFetch.mock.calls.length).toBe(before + 1);
    act(() => root.unmount());
  });
});
