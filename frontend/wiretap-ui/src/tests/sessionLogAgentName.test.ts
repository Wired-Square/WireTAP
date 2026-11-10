import { describe, it, expect, vi } from "vitest";
import type { SessionLogEntry } from "../generated/SessionLogEntry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

await import("../i18n");
const { describeEntry } = await import("../apps/session-manager/stores/sessionLogStore");

describe("the session log", () => {
  it("names an MCP subscriber as the agent, as the graph node does", () => {
    const joined: SessionLogEntry = {
      id: 1,
      timestamp_ms: 0,
      session_id: "f_1",
      profile_ids: [],
      subscriber_id: "mcp_c_1",
      app_name: "mcp",
      event: { kind: "joined", subscriber_count: 2 },
    };
    expect(describeEntry(joined)).toBe("MCP agent joined (2 listeners)");
  });
});
