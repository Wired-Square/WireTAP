// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.stubEnv("TZ", "Australia/Melbourne");

const UTC_0435_US = Date.UTC(2026, 8, 29, 4, 35, 0, 123) * 1000 + 456;
const LOCAL_1435 = "2026-09-29 14:35:00.123456";
const UTC_0435 = "2026-09-29 04:35:00.123456";

vi.mock("../api/capture", () => ({
  getCaptureBytesPaginated: vi.fn(async () => ({ bytes: [{ byte: 0x41, timestamp_us: UTC_0435_US, bus: 0 }] })),
  getCaptureMetadataById: vi.fn(async () => null),
  findCaptureBytesOffsetForTimestamp: vi.fn(),
  getCaptureFramesPaginatedFiltered: vi.fn(async () => ({
    frames: [{ protocol: "serial", timestamp_us: UTC_0435_US, frame_id: 0, bus: 0, dlc: 1, bytes: [0x41] }],
    capture_indices: [1],
    total_count: 1,
  })),
  getCaptureFramesTail: vi.fn(),
  findCaptureOffsetForTimestamp: vi.fn(),
}));
vi.mock("../api/io", () => ({ getCaptureBytesTail: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { default: ByteView } = await import("../apps/discovery/views/serial/ByteView");
const { default: FramedDataView } = await import("../apps/discovery/views/serial/FramedDataView");
const { useDiscoverySerialStore } = await import("../stores/discoverySerialStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("serial Discovery views in the local zone", () => {
  let root: Root;
  const mount = async (node: React.ReactNode) => {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(node));
    return host.innerHTML;
  };

  afterEach(() => act(() => root.unmount()));

  it("a serial byte row shows its time in the local zone", async () => {
    const html = await mount(
      <ByteView
        viewConfig={{ displayMode: "individual", chunkGapUs: 0 }}
        bytesCaptureId="cap_bytes"
        byteCount={1}
        useLocalTimezone
      />,
    );
    expect(html).toContain(LOCAL_1435);
    expect(html).not.toContain(UTC_0435);
  });

  it("a framed serial row shows its time in the local zone", async () => {
    useDiscoverySerialStore.getState().setFramedPageSize(20);
    const html = await mount(
      <FramedDataView
        captureId="cap_framed"
        sessionId={null}
        onAccept={() => {}}
        onApplyIdMapping={() => {}}
        onApplySourceMapping={() => {}}
        accepted={false}
        useLocalTimezone
      />,
    );
    expect(html).toContain(LOCAL_1435);
    expect(html).not.toContain(UTC_0435);
  });
});
