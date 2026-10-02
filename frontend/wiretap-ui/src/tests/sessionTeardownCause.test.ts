// @vitest-environment jsdom
// The Rust half is `a_teardown_names_the_subscriber_whose_call_caused_it` in io/session.rs.
// A view that heard its own teardown adopted the orphaned capture as its next session,
// which looped through further teardowns until a rate cap stopped it.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
const { isDestroyedUnderneath } = await import("../hooks/useIOSession");
import type { SessionLifecyclePayload } from "../generated/SessionLifecyclePayload";

const destroyed = (subscriber_id: string | null, session_id = "f_1"): SessionLifecyclePayload => ({
  session_id,
  event_type: "destroyed",
  source_type: null,
  state: null,
  subscriber_count: 0,
  source_profile_ids: [],
  subscriber_id,
  reset: false,
});

describe("a destroyed session's view", () => {
  it("ignores the teardown its own call caused", () => {
    expect(isDestroyedUnderneath(destroyed("decoder_1"), "f_1", "decoder_1")).toBe(false);
  });

  it("acts on a teardown nobody on it asked for, or another subscriber caused", () => {
    expect(isDestroyedUnderneath(destroyed(null), "f_1", "decoder_1")).toBe(true);
    expect(isDestroyedUnderneath(destroyed("discovery_1"), "f_1", "decoder_1")).toBe(true);
  });

  it("ignores another session's teardown", () => {
    expect(isDestroyedUnderneath(destroyed(null, "f_2"), "f_1", "decoder_1")).toBe(false);
  });
});
