// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActiveSessionInfo } from "../api/io";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

await import("../i18n");
const { default: SessionDetailPanel } = await import("../apps/session-manager/views/SessionDetailPanel");
const { useSessionManagerStore } = await import("../apps/session-manager/stores/sessionManagerStore");

const session = (subscriberId: string, appName: string) =>
  ({
    session_id: "c_1",
    subscribers: [{ subscriber_id: subscriberId, app_name: appName, registered_seconds_ago: 5, is_active: true }],
  }) as unknown as ActiveSessionInfo;

const detailsOf = (subscriberId: string, appName: string) => {
  useSessionManagerStore.getState().setSelectedNode({ id: `app::c_1::${subscriberId}`, type: "app" });
  const noop = () => {};
  return renderToStaticMarkup(
    <SessionDetailPanel
      sessions={[session(subscriberId, appName)]}
      profiles={[]}
      openApps={[]}
      onStartSession={noop}
      onStopSession={noop}
      onPauseSession={noop}
      onResumeSession={noop}
      onDestroySession={noop}
      onEvictSubscriber={noop}
      onAddSource={noop}
      onRemoveSource={noop}
      onDisableBusMapping={noop}
    />,
  );
};

describe("the session detail panel for an app node", () => {
  it("names an MCP subscriber as the agent, as the graph node does", () => {
    const markup = detailsOf("mcp_c_1", "mcp");
    expect(markup).toContain("MCP agent");
    expect(markup).not.toContain("mcp_c_1");
  });

  it("names a panel by its subscriber id", () => {
    expect(detailsOf("decoder_a3f9", "decoder")).toContain("decoder_a3f9");
  });
});
