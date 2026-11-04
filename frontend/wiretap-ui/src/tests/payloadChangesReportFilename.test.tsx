// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChangesResult } from "../stores/discoveryStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "report"), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-AU" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

await import("../i18n");

const { default: ExportAnalysisDialog } = await import("../dialogs/ExportAnalysisDialog");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("ExportAnalysisDialog", () => {
  it("suggests a filename named for the Payload Changes panel", async () => {
    const onExport = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(() =>
      root.render(
        <ExportAnalysisDialog
          open
          results={{ frames: [], frameCount: 0, window: {} } as unknown as ChangesResult}
          onCancel={() => {}}
          onExport={onExport}
        />,
      ),
    );
    const saveAs = [...document.querySelectorAll("button")].find((b) => b.textContent === "common:actions.saveAs")!;
    await act(async () => saveAs.click());
    expect(onExport.mock.calls[0][1]).toMatch(/^\d{8}-payload-changes-report\.txt$/);
    act(() => root.unmount());
  });
});
