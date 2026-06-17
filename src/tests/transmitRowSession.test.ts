import { describe, it, expect } from "vitest";
import { resolveQueueItemSession } from "../stores/transmitRowSession";
import type { Session } from "../stores/sessionStore";

const sess = (id: string, profileId: string, connected = true): Session =>
  ({ id, profileId, lifecycleState: connected ? "connected" : "disconnected" } as unknown as Session);

describe("resolveQueueItemSession", () => {
  it("resolves by sessionId when present", () => {
    const sessions = { f_mcp1: sess("f_mcp1", "io_x") };
    const found = resolveQueueItemSession({ sessionId: "f_mcp1", profileId: "io_x" }, sessions);
    expect(found?.id).toBe("f_mcp1");
  });

  it("falls back to a connected session matching profileId", () => {
    const sessions = { f_ui: sess("f_ui", "io_y") };
    const found = resolveQueueItemSession({ profileId: "io_y" }, sessions);
    expect(found?.id).toBe("f_ui");
  });

  it("ignores a disconnected session in the profile fallback", () => {
    const sessions = { f_ui: sess("f_ui", "io_y", false) };
    const found = resolveQueueItemSession({ profileId: "io_y" }, sessions);
    expect(found).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    const found = resolveQueueItemSession({ sessionId: "nope", profileId: "io_z" }, {});
    expect(found).toBeUndefined();
  });
});
