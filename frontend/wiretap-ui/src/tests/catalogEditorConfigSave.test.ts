import { describe, it, expect } from "vitest";

import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import { metaOp, modbusConfigOp, serialConfigOp } from "../apps/catalog/editorOps";
import type { Catalog } from "../types/catalogModel";

// The typed ops remove a key they model and are not given, so the editor's config
// save passes through what its forms do not edit.
function tree(extra: Partial<Catalog>) {
  return catalogToTree({ meta: { name: "d", version: 1 }, frames: [], ...extra } as Catalog);
}

describe("saving the catalogue configuration", () => {
  it("keeps the file's legacy Modbus device address", () => {
    const parsed = tree({ modbus: { deviceAddress: 7, registerBase: 0 } } as Partial<Catalog>).modbusConfig!;

    expect(modbusConfigOp({ ...parsed, register_base: 1 })).toMatchObject({
      op: "SetModbusConfig",
      config: { device_address: 7, register_base: 1 },
    });
  });

  it("writes no Modbus device address the file does not have", () => {
    expect(tree({ modbus: { registerBase: 0 } } as Partial<Catalog>).modbusConfig!.device_address).toBeUndefined();
  });

  it("keeps the file's default frame", () => {
    const { meta } = tree({ meta: { name: "d", version: 3, defaultFrame: "serial" } });

    expect(metaOp(meta!)).toEqual({ op: "SetMeta", meta: { name: "d", version: 3, default_frame: "serial" } });
  });

  it("keeps the file's minimum serial frame length and frame id mask", () => {
    const parsed = tree({
      serial: { encoding: "slip", minFrameLength: 4, frameIdMask: 0xff00 },
    } as Partial<Catalog>).serialConfig!;

    expect(serialConfigOp(parsed)).toMatchObject({
      op: "SetSerialConfig",
      config: { encoding: "slip", min_frame_length: 4, frame_id_mask: 0xff00 },
    });
  });
});
