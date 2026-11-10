// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

await import("../i18n");
const { default: AppNode } = await import("../apps/session-manager/nodes/AppNode");

const node = (appId: string, appName: string) =>
  renderToStaticMarkup(
    <AppNode selected={false} data={{ appId, appName, sessionId: "c_1", isActive: true, isConnected: true }} />,
  );

describe("an app node on the session canvas", () => {
  it("names an MCP subscriber as the agent, not by its subscriber id", () => {
    const markup = node("mcp_c_1", "mcp");
    expect(markup).toContain("MCP agent");
    expect(markup).not.toContain("mcp_c_1");
  });

  it("names a panel by its per-instance id", () => {
    expect(node("decoder_a3f9", "decoder")).toContain("decoder_a3f9");
  });
});
