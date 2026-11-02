// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const CAPTURE = { id: "cap_bytes", kind: "bytes", name: "bytes", count: 4096, start_time_us: 0, end_time_us: 1, persistent: true };
const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "get_capture_metadata" || cmd === "get_capture_metadata_by_id") return CAPTURE;
  if (cmd === "get_capture_frame_info") return [];
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
  sessionId: "b_cap_bytes",
  state: "stopped",
  capabilities: null,
  captureId: CAPTURE.id,
  captureKind: "bytes",
  captureCount: CAPTURE.count,
  captureName: null,
  captureStartTimeUs: null,
  captureEndTimeUs: null,
  capturePersistent: true,
  isReady: true,
};
const manager = {
  ioProfile: "b_cap_bytes",
  ioProfileName: "bytes",
  multiBusProfiles: [],
  sourceProfileId: CAPTURE.id,
  outputBusToSource: new Map(),
  effectiveSessionId: "b_cap_bytes",
  isStreaming: false,
  isPaused: false,
  isStopped: false,
  canReturnToLive: false,
  isRealtime: false,
  isCaptureMode: false,
  sessionReady: true,
  capabilities: { traits: { protocols: ["serial"], temporal_mode: "capture" }, available_buses: [0] },
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
type Handlers = {
  onSuspended: (payload: { capture_id: string; capture_count: number }) => Promise<void>;
  onSessionDestroyed: (orphanedCaptureIds: string[]) => Promise<void>;
};
let handlers: Handlers;
vi.mock("../hooks/useIOSessionManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useIOSessionManager")>()),
  useIOSessionManager: (options: Handlers) => {
    handlers = options;
    return withStubs({ ...manager, session: withStubs({ ...captureSession }) });
  },
}));

const { default: Discovery } = await import("../apps/discovery/Discovery");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const frameInfoAsks = () => invoke.mock.calls.filter(([cmd]) => cmd === "get_capture_frame_info");

describe("Discovery on a byte capture", () => {
  let root: Root;
  beforeEach(async () => {
    invoke.mockClear();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<Discovery />));
  });
  afterEach(() => {
    act(() => root.unmount());
    manager.isPaused = false;
  });

  it("does not ask a suspended session's byte capture for frame info", async () => {
    await act(() => handlers.onSuspended({ capture_id: CAPTURE.id, capture_count: CAPTURE.count }));
    expect(frameInfoAsks()).toHaveLength(0);
  });

  it("does not ask a destroyed session's orphaned byte capture for frame info", async () => {
    await act(() => handlers.onSessionDestroyed([CAPTURE.id]));
    expect(frameInfoAsks()).toHaveLength(0);
  });

  it("does not ask a paused session's byte capture for frame info", async () => {
    manager.isPaused = true;
    await act(async () => root.render(<Discovery />));
    expect(frameInfoAsks()).toHaveLength(0);
  });
});
