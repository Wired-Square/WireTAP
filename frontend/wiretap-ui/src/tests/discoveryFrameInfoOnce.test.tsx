// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const CAPTURE = { id: "cap_big", kind: "frames", name: "big", count: 5_000_000, start_time_us: 0, end_time_us: 1, persistent: true };
const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "get_capture_metadata" || cmd === "get_capture_metadata_by_id") return CAPTURE;
  if (cmd === "get_capture_frame_info") return new Promise(() => {});
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock("../hooks/useMenuSessionControl", () => ({ useMenuSessionControl: () => {} }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.mock("../hooks/useAllIOProfiles", () => ({ useAllIOProfiles: () => [] }));

const withStubs = <T extends object>(known: T) => {
  const stubs = new Map<PropertyKey, unknown>();
  return new Proxy(known, {
    get: (target, key) =>
      key in target
        ? target[key as keyof T]
        : stubs.get(key) ?? stubs.set(key, vi.fn()).get(key),
  });
};
const captureSession = {
  sessionId: "f_cap_big",
  state: "stopped",
  capabilities: null,
  captureId: CAPTURE.id,
  captureKind: "frames",
  captureCount: 0,
  captureName: null,
  captureStartTimeUs: null,
  captureEndTimeUs: null,
  capturePersistent: true,
  isReady: true,
};
const manager = {
  ioProfile: "f_cap_big",
  ioProfileName: "big",
  multiBusProfiles: [],
  sourceProfileId: CAPTURE.id,
  outputBusToSource: new Map(),
  effectiveSessionId: "f_cap_big",
  session: withStubs(captureSession),
  isStreaming: false,
  isPaused: false,
  isStopped: false,
  canReturnToLive: false,
  isRealtime: false,
  isCaptureMode: true,
  sessionReady: true,
  capabilities: { traits: { protocols: ["can"], temporal_mode: "capture" }, available_buses: [0] },
  joinerCount: 1,
  playbackPosition: null,
  currentTimeUs: null,
  currentFrameIndex: null,
  eventOwner: null,
  watchFrameCount: 0,
  watchUniqueFrameCount: 0,
  watchByteCount: 0,
  bytesCaptureId: null,
  isWatching: false,
  isLoading: false,
  loadProfileId: null,
  loadFrameCount: 0,
  loadError: null,
  streamCompletedRef: { current: true },
};
vi.mock("../hooks/useIOSessionManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useIOSessionManager")>()),
  useIOSessionManager: () => withStubs({ ...manager, session: withStubs({ ...captureSession }) }),
}));

const { default: Discovery } = await import("../apps/discovery/Discovery");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Discovery connecting to a capture", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("asks for the capture's frame info once while it is in flight", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<Discovery />));
    captureSession.captureCount = CAPTURE.count;
    await act(async () => root.render(<Discovery />));
    manager.isPaused = true;
    await act(async () => root.render(<Discovery />));

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "get_capture_frame_info")).toHaveLength(1);
  });
});
