// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const getCaptureBytesPaginated = vi.fn(async () => ({
  bytes: [0x41, 0x42, 0x43].map((byte, i) => ({ byte, timestamp_us: i * 5000, bus: 0 })),
  chunk_starts: [0, 2],
}));
vi.mock("../api/capture", () => ({
  getCaptureBytesPaginated,
  getCaptureMetadataById: vi.fn(async () => null),
  findCaptureBytesOffsetForTimestamp: vi.fn(),
}));
vi.mock("../api/io", () => ({ getCaptureBytesTail: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { default: ByteView } = await import("../apps/discovery/views/serial/ByteView");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("the Byte view's chunks", () => {
  it("asks Rust for the gap and draws a row per chunk it returns", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(<ByteView viewConfig={{ displayMode: "chunked", chunkGapUs: 1000 }} bytesCaptureId="cap" byteCount={3} />),
    );

    expect(getCaptureBytesPaginated).toHaveBeenCalledWith("cap", 0, expect.any(Number), 1000);
    const hex = [...host.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(hex).toHaveLength(2);
    expect(hex[0]).toContain("41 42");
    expect(hex[1]).toContain("43");
    act(() => root.unmount());
  });
});
