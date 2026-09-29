// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReplayLogEntry } from "../stores/transmitStore";

vi.stubEnv("TZ", "Australia/Melbourne");

const UTC_0435_MS = Date.UTC(2026, 8, 29, 4, 35, 0, 123);
const LOCAL_1435 = "2026-09-29 14:35:00.123";
const UTC_0435 = "2026-09-29 04:35:00.123";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { default: TransmitReplayView } = await import("../apps/transmit/views/TransmitReplayView");
const { useTransmitStore } = await import("../stores/transmitStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Transmit replay log", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("a replay log row shows its time in the local zone", () => {
    useTransmitStore.setState({
      replayLog: [{
        id: "1",
        replayId: "r1",
        kind: "started",
        profileName: "can0",
        totalFrames: 10,
        speed: 1,
        loopReplay: false,
        timestamp: UTC_0435_MS,
      }] as ReplayLogEntry[],
    });
    const host = document.createElement("div");
    root = createRoot(host);
    act(() => root.render(<TransmitReplayView useLocalTimezone />));
    expect(host.innerHTML).toContain(LOCAL_1435);
    expect(host.innerHTML).not.toContain(UTC_0435);
  });
});
