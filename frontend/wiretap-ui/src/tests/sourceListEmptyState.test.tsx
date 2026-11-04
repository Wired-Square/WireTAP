import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { default: SourceList } = await import("../dialogs/io-source-picker/SourceList");

const render = (captureCount: number) =>
  renderToStaticMarkup(
    createElement(SourceList, {
      ioProfiles: [],
      checkedSourceId: null,
      isLoading: false,
      onSelectSource: () => {},
      hideSessions: true,
      renderAfterSessions: captureCount ? createElement("div", null, "Bench run") : undefined,
      captureCount,
      activeTab: "captures",
      onTabChange: () => {},
    }),
  );

describe("the source list's empty state", () => {
  it("says no sources are configured only when it lists nothing", () => {
    expect(render(0)).toContain("ioSourcePicker.sources.noSources");
    const withCapture = render(1);
    expect(withCapture).toContain("Bench run");
    expect(withCapture).not.toContain("ioSourcePicker.sources.noSources");
  });
});
