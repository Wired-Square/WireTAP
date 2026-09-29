import { describe, it, expect, vi } from "vitest";

const handlers = new Map<string, (params: unknown) => unknown>();
vi.mock("../services/wsTransport", () => ({
  wsTransport: { registerBridgeMethod: (method: string, fn: (params: unknown) => unknown) => handlers.set(method, fn) },
}));
const openPanel = vi.fn();
vi.mock("../utils/windowCommunication", () => ({ openPanel }));

const { initMcpBridge } = await import("../services/mcpBridge");
initMcpBridge();
const openApp = (panelId: string) => handlers.get("ui.openPanel")!({ panelId });

describe("MCP open_app", () => {
  it("names an unknown app id and the valid ones instead of opening it", async () => {
    await expect(openApp("devices")).rejects.toThrow(/Unknown app "devices".*discovery/);
    expect(openPanel).not.toHaveBeenCalled();
  });

  it("opens a registered app", async () => {
    await expect(openApp("discovery")).resolves.toMatchObject({ opened: true, panelId: "discovery" });
    expect(openPanel).toHaveBeenCalledWith("discovery");
  });
});
