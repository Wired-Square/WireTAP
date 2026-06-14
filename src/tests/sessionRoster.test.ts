import { describe, it, expect } from "vitest";
import { reconcileKnownSessions } from "../stores/sessionRoster";
import type { Session } from "../stores/sessionStore";
import type { ActiveSessionInfo } from "../api/io";

const caps = {
  can_pause: false,
  supports_extended_id: true,
  supports_rtr: true,
  available_buses: [0, 1],
  traits: { temporal_mode: "realtime", protocols: ["can"], tx_frames: true, tx_bytes: true, multi_source: true },
  data_streams: { rx_frames: true, rx_bytes: false },
} as unknown as ActiveSessionInfo["capabilities"];

// Cast the whole literal: ActiveSessionInfo's nested broker-config shape is
// stricter than we need here, and reconcileKnownSessions only reads a subset.
const info = (sessionId: string, profileId = "io_x") =>
  ({
    sessionId,
    sourceType: "framelink",
    state: "running",
    capabilities: caps,
    subscriberCount: 1,
    subscribers: [],
    brokerConfigs: [{ profileId, displayName: "Dev", busMappings: [] }],
    sourceProfileIds: [profileId],
    captureId: null,
    captureFrameCount: null,
    isStreaming: true,
  }) as unknown as ActiveSessionInfo;

describe("reconcileKnownSessions", () => {
  it("adds a known-only entry for a roster session", () => {
    const next = reconcileKnownSessions({}, [info("f_mcp1")]);
    expect(next.f_mcp1.external).toBe(true);
    expect(next.f_mcp1.lifecycleState).toBe("connected");
    expect(next.f_mcp1.capabilities?.traits.tx_frames).toBe(true);
    expect(next.f_mcp1.profileId).toBe("io_x");
  });

  it("does not overwrite a UI-owned (non-external) entry", () => {
    const owned = { id: "f_mcp1", external: false, profileName: "Mine" } as unknown as Session;
    const next = reconcileKnownSessions({ f_mcp1: owned }, [info("f_mcp1")]);
    expect(next.f_mcp1).toBe(owned);
  });

  it("removes an external entry that vanished from the roster", () => {
    const adopted = reconcileKnownSessions({}, [info("f_mcp1")]);
    const next = reconcileKnownSessions(adopted, []);
    expect(next.f_mcp1).toBeUndefined();
  });

  it("keeps a UI-owned entry even when absent from the roster", () => {
    const owned = { id: "f_ui", external: false } as unknown as Session;
    const next = reconcileKnownSessions({ f_ui: owned }, []);
    expect(next.f_ui).toBe(owned);
  });
});
