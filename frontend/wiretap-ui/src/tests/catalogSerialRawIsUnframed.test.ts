import { describe, it, expect } from "vitest";
import catalog from "../locales/en-AU/catalog.json";
import { frameEditFieldsFor, frameFieldsOf } from "../apps/catalog/views/frameEditUtils";
import type { Frame } from "../types/catalogModel";

describe("a catalogue's serial raw encoding is unframed", () => {
  it("a raw serial encoding is labelled unframed", () => {
    for (const label of [catalog.newCatalog.encodingRaw, catalog.serialConfig.encodingRaw]) {
      expect(label).toBe("Raw (unframed)");
    }
  });

  it("a serial frame edit carries no delimiter", () => {
    const frame = { protocol: "serial", key: "status", length: 4, delimiter: [0x0d, 0x0a] } as unknown as Frame;
    expect(frameFieldsOf(frameEditFieldsFor(frame, null))).not.toHaveProperty("delimiter");
  });
});
