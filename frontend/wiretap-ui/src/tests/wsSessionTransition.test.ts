// @vitest-environment jsdom
// The Rust halves are `session_transition_leads_with_state_and_transition` in
// ws/protocol.rs and `a_transition_carries_its_codes_capabilities_and_capture` in
// ws/dispatch.rs; these are their bytes.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
import { decodeSessionTransition, type SessionTransition } from "../services/wsProtocol";
import { sessionTransitionEffect } from "../stores/sessionStore";
import type { IOCapabilities, IOStateType } from "../api/io";

const view = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

describe("SessionLifecycle (scoped) wire format", () => {
  it("decodes Rust's golden payloads", () => {
    expect(decodeSessionTransition(view([0, 1, 2, 0, ...utf8("{}"), 2, 0, ...utf8("c1"), 42, 0, 0, 0]))).toEqual({
      state: "stopped",
      transition: "switched_to_capture",
      capabilities: {},
      capture_id: "c1",
      capture_count: 42,
    });
    expect(decodeSessionTransition(view([2, 3, 2, 0, ...utf8("{}"), 0, 0, 0, 0, 0, 0]))).toEqual({
      state: "running",
      transition: "returned_to_live",
      capabilities: {},
      capture_id: null,
      capture_count: 0,
    });
  });

  it("reads an unknown transition as a capabilities change", () => {
    expect(decodeSessionTransition(view([0, 9, 2, 0, ...utf8("{}"), 0, 0, 0, 0, 0, 0])).transition).toBe("capabilities_changed");
  });
});

// The inference sessionStore ran on the old 0x08 (state + capabilities only) until the
// message carried its transition: which callback it fired, and whether it reset the
// session's counts, from the previous state, the new state and the temporal mode.
type Callback = "onResuming" | "onSwitchedToCapture" | "onSuspended" | "onSourceReplaced" | null;

function retiredInference(prevState: IOStateType, stateType: IOStateType, temporal: string): { callback: Callback; resets: boolean } {
  const isNowRunning = stateType === "running" || stateType === "starting";
  const wasStoppedOrPaused = prevState === "stopped" || prevState === "paused";
  const isNowStopped = stateType === "stopped";
  if (isNowRunning && wasStoppedOrPaused) return { callback: "onResuming", resets: true };
  if (isNowStopped && temporal === "capture") return { callback: "onSwitchedToCapture", resets: false };
  if (isNowStopped) return { callback: "onSuspended", resets: false };
  return { callback: "onSourceReplaced", resets: false };
}

interface Case {
  site: string;
  prev: IOStateType;
  state: IOStateType;
  temporal: "realtime" | "recorded" | "capture";
  transition: SessionTransition;
  /** The state the push carries where it differs from the old message's, which went after the start. */
  pushedState?: IOStateType;
  old: Callback;
  oldResets: boolean;
  /** Why the pushed transition fires something else; absent where it fires the same. */
  differs?: string;
}

const cases: Case[] = [
  { site: "suspend_session (realtime)", prev: "running", state: "stopped", temporal: "realtime", transition: "suspended", old: "onSuspended", oldResets: false },
  { site: "suspend_session (recorded)", prev: "paused", state: "stopped", temporal: "recorded", transition: "suspended", old: "onSuspended", oldResets: false },
  {
    site: "suspend_session (capture replay)", prev: "running", state: "stopped", temporal: "capture", transition: "suspended", old: "onSwitchedToCapture", oldResets: false,
    differs: "a stopped replay was read as a switch to capture; the switch that follows it is its own message",
  },
  { site: "stop_and_switch_to_capture", prev: "running", state: "stopped", temporal: "capture", transition: "switched_to_capture", old: "onSwitchedToCapture", oldResets: false },
  { site: "switch_to_capture_replay", prev: "stopped", state: "stopped", temporal: "capture", transition: "switched_to_capture", old: "onSwitchedToCapture", oldResets: false },
  {
    site: "resume_session_fresh", prev: "stopped", state: "stopped", temporal: "realtime", transition: "resuming", old: "onSuspended", oldResets: false,
    differs: "the message goes before the start, so a resume was read as a suspend and joined apps never cleared",
  },
  { site: "resume_to_live_session (from stopped)", prev: "stopped", state: "running", pushedState: "stopped", temporal: "realtime", transition: "returned_to_live", old: "onResuming", oldResets: true },
  { site: "resume_to_live_session (from paused)", prev: "paused", state: "running", pushedState: "stopped", temporal: "realtime", transition: "returned_to_live", old: "onResuming", oldResets: true },
  { site: "resume_to_live_session (still starting)", prev: "stopped", state: "starting", pushedState: "stopped", temporal: "realtime", transition: "returned_to_live", old: "onResuming", oldResets: true },
  {
    site: "resume_to_live_session (from a playing replay)", prev: "running", state: "running", pushedState: "stopped", temporal: "realtime", transition: "returned_to_live", old: "onSourceReplaced", oldResets: false,
    differs: "running to running looked like a source swap, so the old replay's frames stayed",
  },
  {
    site: "set_framing / refresh_session_capabilities (running)", prev: "running", state: "running", temporal: "realtime", transition: "capabilities_changed", old: "onSourceReplaced", oldResets: false,
    differs: "onSourceReplaced had no consumer and is retired",
  },
  {
    site: "set_framing / refresh_session_capabilities (stopped)", prev: "stopped", state: "stopped", temporal: "realtime", transition: "capabilities_changed", old: "onSuspended", oldResets: false,
    differs: "a capabilities change on a stopped session was read as a suspend",
  },
  {
    site: "set_framing / refresh_session_capabilities (stopped replay)", prev: "stopped", state: "stopped", temporal: "capture", transition: "capabilities_changed", old: "onSwitchedToCapture", oldResets: false,
    differs: "a capabilities change on a stopped replay was read as a switch to capture",
  },
  {
    site: "refresh_session_capabilities (the running blip: the store still held stopped)", prev: "stopped", state: "running", temporal: "realtime", transition: "capabilities_changed", old: "onResuming", oldResets: true,
    differs: "the running blip: a stale stopped made a capabilities push read as a resume, zeroing the capture",
  },
];

const capabilities = (temporal: string) => ({ traits: { temporal_mode: temporal } }) as unknown as IOCapabilities;

describe("the pushed transition against the retired inference", () => {
  it.each(cases)("$site", ({ prev, state, temporal, transition, pushedState, old, oldResets, differs }) => {
    expect(retiredInference(prev, state, temporal)).toEqual({ callback: old, resets: oldResets });

    const effect = sessionTransitionEffect(
      { transition, state: pushedState ?? state, capabilities: capabilities(temporal), capture_id: null, capture_count: 0 },
      undefined,
      "f_1",
    );
    const resets = effect.updates.frameCount === 0;
    if (differs) {
      expect({ callback: effect.callback, resets }).not.toEqual({ callback: old, resets: oldResets });
    } else {
      expect({ callback: effect.callback, resets }).toEqual({ callback: old, resets: oldResets });
    }
  });

  // The retired inference fabricated these from the store's capture; the push carries
  // what Rust finished with, under the names Discovery, Decoder and the manager read.
  it.each(["suspended", "switched_to_capture"] as const)("%s carries the capture id and count", (transition) => {
    const msg = { transition, state: "stopped" as const, capabilities: capabilities("capture"), capture_id: "c1", capture_count: 42 };
    const { updates } = sessionTransitionEffect(msg, undefined, "f_1");
    expect(updates.capture).toMatchObject({ id: "c1", count: 42, available: true });
  });
});
