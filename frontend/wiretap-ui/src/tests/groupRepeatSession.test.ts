// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { useSessionStore, type Session } from "../stores/sessionStore";
import { useTransmitStore, type TransmitQueueItem } from "../stores/transmitStore";

const PROFILE_ID = "io_slcan";

const session = (id: string) =>
  ({
    id,
    profileId: PROFILE_ID,
    profileName: "slcan",
    lifecycleState: "connected",
    hasQueuedMessages: false,
    capabilities: { traits: { tx_frames: true } },
  }) as unknown as Session;

const row = (id: string, sessionId: string): TransmitQueueItem => ({
  id,
  profileId: PROFILE_ID,
  profileName: "slcan",
  type: "can",
  canFrame: { frame_id: 0x100, data: [1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false },
  repeatIntervalMs: 100,
  isRepeating: false,
  enabled: true,
  groupName: "g",
  sessionId,
});

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useSessionStore.setState({ sessions: { first: session("first"), second: session("second") } });
  useTransmitStore.setState({ queue: [], activeGroups: new Set(), error: null });
});

const repeatGroupSessions = () =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === "io_start_repeat_group")
    .map(([, args]) => (args as { sessionId: string }).sessionId);

describe("a group repeat transmits through its rows' sessions", () => {
  it("rows naming the second session on a shared profile repeat through that session", async () => {
    useTransmitStore.setState({ queue: [row("a", "second"), row("b", "second")] });
    await useTransmitStore.getState().startGroupRepeat("g");
    expect(repeatGroupSessions()).toEqual(["second"]);
  });

  it("rows naming two sessions on one profile repeat through each", async () => {
    useTransmitStore.setState({ queue: [row("a", "first"), row("b", "second")] });
    await useTransmitStore.getState().startGroupRepeat("g");
    expect(repeatGroupSessions()).toEqual(["first", "second"]);
  });
});

describe("stopping a group repeat", () => {
  it("stops the sub-group of every session its rows repeated through", async () => {
    useTransmitStore.setState({ queue: [row("a", "first"), row("b", "second")] });
    await useTransmitStore.getState().startGroupRepeat("g");
    await useTransmitStore.getState().stopGroupRepeat("g");
    const stopped = vi.mocked(invoke).mock.calls
      .filter(([cmd]) => cmd === "io_stop_repeat_group")
      .map(([, args]) => (args as { groupId: string }).groupId);
    expect(stopped).toEqual(expect.arrayContaining(["g:first", "g:second"]));
  });
});
