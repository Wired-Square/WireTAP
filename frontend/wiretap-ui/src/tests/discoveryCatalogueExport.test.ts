import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { framesCatalogOps, knowledgeCatalogOps, modbusCatalogOps } from "../utils/frameExport";
import type { EditOp } from "../types/catalogEdit";
import * as f from "./fixtures/discovery-export/inputs";

// The `.golden.toml` beside each fixture is what the TypeScript writers saved. The
// Rust half, `each_discovery_export_builds_the_catalogue_its_typescript_writer_did`,
// builds these ops and parses both to the same catalogue.
function fixture(name: string): EditOp[] {
  return JSON.parse(readFileSync(resolve(__dirname, "fixtures/discovery-export", `${name}.ops.json`), "utf-8"));
}

describe("Discovery catalogue export", () => {
  it("builds a knowledge export's ops", () => {
    expect(knowledgeCatalogOps(f.knowledgeCanFrames, f.canMeta, f.hexId)).toEqual(fixture("knowledge-can"));
  });

  it("builds a serial knowledge export's ops", () => {
    expect(knowledgeCatalogOps(f.serialFrames, f.serialMeta, f.hexId, f.serialConfig)).toEqual(
      fixture("knowledge-serial"),
    );
  });

  it("builds a plain frames export's ops", () => {
    expect(framesCatalogOps(f.plainFrames, f.canMeta, f.hexId)).toEqual(fixture("plain-can"));
  });

  it("builds a Modbus export's ops", () => {
    expect(modbusCatalogOps(f.modbusRegisters, f.modbusMeta, f.modbusConfig)).toEqual(fixture("modbus"));
  });

  it("names every mux selector, which validation requires", () => {
    const muxes = knowledgeCatalogOps(f.knowledgeCanFrames, f.canMeta, f.hexId).flatMap((op) =>
      op.op === "SetMux" ? [op.mux.name] : [],
    );

    expect(muxes).toEqual(["selector_0", "selector_0", "selector_1", "selector_1"]);
  });

  it("refuses a protocol a catalogue has no frames for", () => {
    expect(() => framesCatalogOps([{ id: 0x0103, len: 8, protocol: "modbus_rtu" }], f.canMeta, f.hexId)).toThrow(
      "modbus_rtu frames cannot be saved as a catalogue",
    );
  });
});
