import { describe, it, expect } from "vitest";

import { buildNativeMenuLabels } from "../hooks/useNativeMenuLabels";
import appsJson from "../apps/apps.json";

describe("native menu labels", () => {
  const labels = buildNativeMenuLabels();

  it("gives every fixed label its en-AU text, not a raw key", () => {
    const { apps: _apps, ...fixed } = labels;
    for (const [field, text] of Object.entries(fixed)) {
      expect(text, field).toBeTruthy();
      expect(text, field).not.toContain("nativeMenu");
    }
  });

  it("sends the source line as a template with the name slot", () => {
    expect(labels.source).toBe("Source: {{name}}");
  });

  it("labels every app the Apps menu shows", () => {
    for (const app of appsJson.apps) {
      if ("singleton" in app || app.group === "settings") continue;
      expect(labels.apps[app.id], app.id).toBeTruthy();
      expect(labels.apps[app.id], app.id).not.toContain("panels.");
    }
  });
});
