// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock("../hooks/useMenuSessionControl", () => ({ useMenuSessionControl: () => {} }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const profiles = [{ id: "plc", name: "PLC", kind: "modbus_tcp", connection: { host: "10.0.0.2", port: 502 } }];
vi.mock("../hooks/useAllIOProfiles", () => ({ useAllIOProfiles: () => profiles }));

const resumeWithNewCapture = vi.fn(async () => {});
// Only the values Discovery reads are listed; every method it reaches is a no-op.
const withStubs = <T extends object>(known: T) => {
  const stubs = new Map<PropertyKey, unknown>();
  return new Proxy(known, {
    get: (target, key) =>
      key in target
        ? target[key as keyof T]
        : stubs.get(key) ?? stubs.set(key, vi.fn()).get(key),
  });
};
const endedModbusSession = withStubs({
  sessionId: "m_plc",
  state: "stopped",
  capabilities: null,
  captureId: null,
  captureKind: null,
  captureCount: 0,
  captureName: null,
  captureStartTimeUs: null,
  captureEndTimeUs: null,
  capturePersistent: false,
  isReady: true,
});
const endedManager = withStubs({
  ioProfile: "m_plc",
  ioProfileName: "PLC",
  multiBusProfiles: [],
  sourceProfileId: "plc",
  outputBusToSource: new Map(),
  effectiveSessionId: "m_plc",
  session: endedModbusSession,
  isStreaming: false,
  isPaused: false,
  isStopped: true,
  canReturnToLive: true,
  isRealtime: true,
  isCaptureMode: false,
  sessionReady: true,
  capabilities: { traits: { protocols: ["modbus"], temporal_mode: "realtime" }, available_buses: [0] },
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
  resumeWithNewCapture,
});
vi.mock("../hooks/useIOSessionManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useIOSessionManager")>()),
  useIOSessionManager: () => endedManager,
}));

const { default: Discovery } = await import("../apps/discovery/Discovery");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Discovery's Modbus poll switch", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("resuming polling on an ended session restarts the session", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root.render(<Discovery />));

    const resume = [...host.querySelectorAll("button")].find((b) => b.textContent === "modbusPoll.resume")!;
    await act(async () => resume.click());

    expect(resumeWithNewCapture).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith("resume_source_polling", expect.anything());
  });
});
