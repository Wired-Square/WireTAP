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
import type { RepeatGroupMember } from "../api/transmit";

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

const repeatGroupMembers = () =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === "io_start_repeat_group")
    .map(([, args]) => (args as { members: RepeatGroupMember[] }).members.map((m) => [m.session_id, m.frames.length]));

describe("a group repeat transmits through its rows' sessions", () => {
  it("rows naming the second session on a shared profile repeat through that session", async () => {
    useTransmitStore.setState({ queue: [row("a", "second"), row("b", "second")] });
    await useTransmitStore.getState().startGroupRepeat("g");
    expect(repeatGroupMembers()).toEqual([[["second", 2]]]);
  });

  it("rows across sessions are one group, in queue order", async () => {
    useTransmitStore.setState({ queue: [row("a", "first"), row("b", "second"), row("c", "first")] });
    await useTransmitStore.getState().startGroupRepeat("g");
    expect(repeatGroupMembers()).toEqual([[["first", 1], ["second", 1], ["first", 1]]]);
  });
});

describe("a group repeat's state follows the backend", () => {
  it("the group shows repeating when the backend says it started", async () => {
    useTransmitStore.setState({ queue: [row("a", "first"), row("b", "second")] });
    await useTransmitStore.getState().startGroupRepeat("g");
    expect(useTransmitStore.getState().isGroupRepeating("g")).toBe(false);
    useTransmitStore.getState().markGroupRepeating("g");
    expect(useTransmitStore.getState().isGroupRepeating("g")).toBe(true);
    expect(useTransmitStore.getState().queue.every((q) => q.isRepeating)).toBe(true);
  });

  it("stopping it stops the one group", async () => {
    useTransmitStore.setState({ queue: [row("a", "first"), row("b", "second")] });
    useTransmitStore.getState().markGroupRepeating("g");
    await useTransmitStore.getState().stopGroupRepeat("g");
    const stopped = vi.mocked(invoke).mock.calls
      .filter(([cmd]) => cmd === "io_stop_repeat_group")
      .map(([, args]) => (args as { groupId: string }).groupId);
    expect(stopped).toEqual(["g"]);
    expect(useTransmitStore.getState().isGroupRepeating("g")).toBe(false);
  });

  it("a group the backend stopped on a device error shows stopped", () => {
    useTransmitStore.setState({ queue: [row("a", "first"), row("b", "second")] });
    useTransmitStore.getState().markGroupRepeating("g");
    useTransmitStore.getState().markRepeatStopped("g");
    expect(useTransmitStore.getState().isGroupRepeating("g")).toBe(false);
    expect(useTransmitStore.getState().queue.some((q) => q.isRepeating)).toBe(false);
  });

  it("a grouped row repeating alone stops alone", () => {
    useTransmitStore.setState({ queue: [{ ...row("a", "first"), isRepeating: true }, { ...row("b", "first"), isRepeating: true }] });
    useTransmitStore.getState().markRepeatStopped("a");
    expect(useTransmitStore.getState().queue.map((q) => q.isRepeating)).toEqual([false, true]);
  });
});
