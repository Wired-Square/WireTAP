import { describe, it, expect } from "vitest";
import { framesById } from "../utils/catalogFrames";
import type { Catalog } from "../types/catalogModel";
import { fixtureJson } from "./catalogGoldens";

describe("framesById", () => {
  it("keeps the signals of every frame sharing an id", () => {
    const frame = framesById(fixtureJson<Catalog>("catalog/sbrxxx.catalog.json")).get(0x4de2);
    expect(frame?.signals.map((s) => s.name)).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((i) => `Tunnel_4DE2_Holding_${i}`),
      "Tunnel_4DE2_Input_0",
      "Tunnel_4DE2_Input_1",
    ]);
  });
});
