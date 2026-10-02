// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOProfile } from "../hooks/useSettings";
import type { SessionPurpose } from "../generated/SessionPurpose";

const captureIds = new Set(["cap_a", "cap_b"]);
const openedSessions: Array<string | undefined> = [];
let minted = 0;
const mintedFor = (purpose: SessionPurpose) =>
  `${purpose.purpose === "sources" ? purpose.profile_ids.join("+") : purpose.purpose}#${++minted}`;

vi.mock("../hooks/useIOSession", () => ({
  useIOSession: (opts: { sessionId?: string }) => {
    openedSessions.push(opts.sessionId);
    return {
      sessionId: opts.sessionId,
      subscriberId: "discovery_1",
      state: "stopped",
      capabilities: null,
      isReady: true,
      joinerCount: 1,
      playbackPosition: null,
      currentTimeUs: null,
      captureId: null,
      captureStartTimeUs: null,
      reinitialize: vi.fn(async () => {}),
      markSessionSwitch: vi.fn(),
      leave: vi.fn(async () => {}),
      rejoin: vi.fn(async () => {}),
    };
  },
}));
vi.mock("../stores/sessionStore", async () => {
  const { create } = await import("zustand");
  return {
    createAndStartMultiSourceSession: vi.fn(async () => ({})),
    joinMultiSourceSession: vi.fn(async () => ({})),
    isCaptureProfileId: (id: string | null) => id !== null && captureIds.has(id),
    useSessionStore: create(() => ({
      pendingJoins: {},
      sessions: {},
      clearPendingJoin: () => {},
      setSessionCatalogPath: () => {},
    })),
  };
});
vi.mock("../stores/profileBusStore", () => ({
  useProfileBusStore: { getState: () => ({ ensureLoaded: async () => {} }) },
  isMultiSourceCapable: () => true,
  isRealtimeProfile: () => true,
  profileBusMappings: (_id: string, outputBus: number) => [
    { device_bus: 0, output_bus: outputBus, enabled: true, interface_id: "can0", protocol: "can", supported_protocols: [], traits: null },
  ],
}));
vi.mock("../api/io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/io")>()),
  generateSessionId: vi.fn(async (purpose: SessionPurpose) => mintedFor(purpose)),
  setSessionSubscriberActive: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const { useIOSessionManager } = await import("../hooks/useIOSessionManager");
type Manager = ReturnType<typeof useIOSessionManager>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const virtualDevice = {
  id: "walk-v",
  name: "walk-v",
  kind: "virtual",
  connection: { traffic_type: "can" },
} as unknown as IOProfile;
const profiles = [virtualDevice];

let root: Root;
const manager = {} as { current: Manager };

function Harness() {
  manager.current = useIOSessionManager({ appName: "discovery", ioProfiles: profiles });
  return null;
}

async function run(step: (m: Manager) => Promise<void>) {
  await act(async () => step(manager.current));
  return manager.current.effectiveSessionId;
}

/** A stopped Virtual Device session: the multi-source path, then Change source. */
async function fromVirtualDevice() {
  expect(await run((m) => m.watchSource([virtualDevice.id], {}))).toMatch(/^walk-v#/);
}

beforeEach(() => {
  openedSessions.length = 0;
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useIOSessionManager source switching", () => {
  it("follows each capture picked after a multi-source session", async () => {
    await fromVirtualDevice();

    const first = await run((m) => m.watchSource(["cap_a"], {}));
    expect(first).toMatch(/^cap_a#/);
    expect(first).toBe(manager.current.ioProfile);

    const second = await run((m) => m.watchSource(["cap_b"], {}));
    expect(second).toMatch(/^cap_b#/);
    expect(second).not.toBe(first);
    expect(openedSessions[openedSessions.length - 1]).toBe(second);
  });

  it("follows a load started after a multi-source session", async () => {
    await fromVirtualDevice();
    expect(await run((m) => m.loadSource(["cap_a"], {}))).toMatch(/^ingest#/);
  });

  it("follows a connect-only session started after a multi-source session", async () => {
    await fromVirtualDevice();
    expect(await run((m) => m.connectOnly("cap_a"))).toMatch(/^cap_a#/);
  });

  it("returns to no source when the picker is skipped after a multi-source session", async () => {
    await fromVirtualDevice();
    expect(await run((m) => m.skipReader())).toBeUndefined();
  });
});
