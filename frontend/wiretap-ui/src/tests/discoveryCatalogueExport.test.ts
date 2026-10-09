import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { framesCatalogOps, modbusCatalogOps, serialReservedSpans } from "../utils/frameExport";
import type { EditOp } from "../types/catalogEdit";
import * as f from "./fixtures/discovery-export/inputs";

// The `.golden.toml` beside each fixture is what the TypeScript writers saved. The
// Rust half, `each_discovery_export_builds_the_catalogue_its_typescript_writer_did`,
// builds these ops and parses both to the same catalogue.
function fixture(name: string): EditOp[] {
  return JSON.parse(readFileSync(resolve(__dirname, "fixtures/discovery-export", `${name}.ops.json`), "utf-8"));
}

describe("Discovery catalogue export", () => {
  it("builds a plain frames export's ops", () => {
    expect(framesCatalogOps(f.plainFrames, f.canMeta, f.hexId)).toEqual(fixture("plain-can"));
  });

  it("builds a Modbus export's ops", () => {
    expect(modbusCatalogOps(f.modbusRegisters, f.modbusMeta, f.modbusConfig)).toEqual(fixture("modbus"));
  });

  it("reserves a serial frame's id, source address and checksum bytes", () => {
    expect(serialReservedSpans(f.serialConfig)).toEqual([
      { start: 1, len: 2 },
      { start: 0, len: 1 },
      { start: -1, len: 1 },
    ]);
  });

  it("refuses a protocol a catalogue has no frames for", () => {
    expect(() => framesCatalogOps([{ id: 0x0103, len: 8, protocol: "modbus_rtu" }], f.canMeta, f.hexId)).toThrow(
      "modbus_rtu frames cannot be saved as a catalogue",
    );
  });
});
