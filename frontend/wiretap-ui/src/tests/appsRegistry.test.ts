// Every menu app needs a panel title — `getPanelTitle` reads `menus:panels.<i18nKey>`,
// and a missing key renders the raw id in the tab.

import { describe, it, expect } from "vitest";
import { menuApps } from "../apps/registry";
import menus from "../locales/en-AU/menus.json";

describe("apps registry", () => {
  it("has a panel title for every app", () => {
    const panels = menus.panels as Record<string, string>;
    for (const app of menuApps) {
      expect(panels[app.i18nKey], `menus.json panels.${app.i18nKey}`).toBeTruthy();
    }
  });

  it("has a unique accelerator per app", () => {
    const keys = menuApps.map((a) => a.accelerator).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
