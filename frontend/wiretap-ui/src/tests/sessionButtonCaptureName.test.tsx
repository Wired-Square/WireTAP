import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

const { SessionButton } = await import("../components/SessionControls");
const { useSessionStore } = await import("../stores/sessionStore");
type Session = import("../stores/sessionStore").Session;

describe("the session button", () => {
  it("names a capture session by its capture without the app passing metadata", () => {
    useSessionStore.setState({
      sessions: {
        f_replay: {
          id: "f_replay",
          sourceKind: "capture",
          originProfileIds: [],
          capture: { id: "cap_1", name: "Bench run" },
        } as unknown as Session,
      },
    });
    const markup = renderToStaticMarkup(
      createElement(SessionButton, { ioProfile: "f_replay", ioProfiles: [], onClick: () => {} }),
    );
    expect(markup).toContain("Bench run");
  });
});
