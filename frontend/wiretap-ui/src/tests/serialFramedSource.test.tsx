// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const FRAMED_TOTAL = 33;
const pageFetch = vi.fn(async (_captureId: string, offset: number, limit: number) => {
  const rows = Array.from({ length: Math.max(0, Math.min(limit, FRAMED_TOTAL - offset)) }, (_, i) => offset + i);
  return {
    frames: rows.map((row) => ({ protocol: "serial", timestamp_us: row * 1000, frame_id: 0, bus: 0, dlc: 1, bytes: [row] })),
    capture_indices: rows.map((row) => row + 1),
    total_count: FRAMED_TOTAL,
  };
});
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

const { framedSource, useDiscoverySerialStore } = await import("../stores/discoverySerialStore");
const { useCaptureFrameView } = await import("../apps/discovery/hooks/useCaptureFrameView");
const { default: FramedDataView } = await import("../apps/discovery/views/serial/FramedDataView");

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

describe("FramedDataView paging", () => {
  async function mount(props: { isStreaming?: boolean; isRecorded?: boolean }) {
    useDiscoverySerialStore.getState().setFramedPageSize(20);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <FramedDataView
          captureId="cap_framed"
          sessionId={null}
          onAccept={() => {}}
          onApplyIdMapping={() => {}}
          onApplySourceMapping={() => {}}
          accepted={false}
          {...props}
        />,
      ),
    );
    return { host, root };
  }

  it("reaches every frame of a capture longer than a page before framing is accepted", async () => {
    const { host, root } = await mount({});
    expect(host.textContent).toContain("1 / 2");

    const next = host.querySelector<HTMLButtonElement>('[title="pagination.nextPage"]')!;
    await act(async () => next.click());

    const rows = host.querySelectorAll("tbody > tr");
    expect(rows[rows.length - 1].querySelector("td")?.textContent).toBe(String(FRAMED_TOTAL));
    act(() => root.unmount());
  });

  it("reports a last page clamped to the end as the last page", async () => {
    const { host, root } = await mount({});
    const button = (title: string) => host.querySelector<HTMLButtonElement>(`[title="pagination.${title}"]`)!;
    await act(async () => button("nextPage").click());

    expect(host.textContent).toContain("2 / 2");
    expect(button("nextPage").disabled).toBe(true);
    expect(button("lastPage").disabled).toBe(true);
    act(() => root.unmount());
  });

  it("pages a stored source's capture while its session runs, rather than tailing it", async () => {
    const { host, root } = await mount({ isStreaming: true, isRecorded: true });
    expect(host.textContent).toContain("1 / 2");
    act(() => root.unmount());
  });
});
