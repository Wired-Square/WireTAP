// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/catalog", () => ({
  editCatalogOps: vi.fn(async (toml: string) => toml),
}));

import { editCatalogOps } from "../api/catalog";
import { useFrameHandlers } from "../apps/catalog/hooks/handlers/useFrameHandlers";
import { useCatalogEditorStore } from "../stores/catalogEditorStore";
import type { Catalog } from "../types/catalogModel";
import type { EditOp } from "../types/catalogEdit";
import { renderHookOnce } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The typed ops remove a key they model and are not given, so the configuration
// save passes through what its forms do not edit.
async function savedOps(model: Partial<Catalog>, enabled = { can: true, serial: true, modbus: true }): Promise<EditOp[]> {
  const catalog = { meta: { name: "d", version: 1 }, frames: [], ...model } as Catalog;
  const store = useCatalogEditorStore.getState();
  useCatalogEditorStore.setState((s) => ({ tree: { ...s.tree, catalog } }));
  store.seedConfigForms(catalog);
  store.setMetaForm({ name: catalog.meta.name, version: catalog.meta.version, default_frame: catalog.meta.defaultFrame });
  const handlers = renderHookOnce(() => useFrameHandlers({}));
  await handlers.handleSaveConfig(enabled);
  const { calls } = vi.mocked(editCatalogOps).mock;
  return calls[calls.length - 1][1];
}

const opNamed = (ops: EditOp[], name: EditOp["op"]) => ops.find((op) => op.op === name);

beforeEach(() => vi.mocked(editCatalogOps).mockClear());

describe("saving the catalogue configuration", () => {
  it("keeps the file's legacy Modbus device address", async () => {
    const ops = await savedOps({ modbus: { deviceAddress: 7, registerBase: 0 } });
    expect(opNamed(ops, "SetModbusConfig")).toMatchObject({ config: { device_address: 7, register_base: 0 } });
  });

  it("writes no Modbus device address or byte order the file does not have", async () => {
    const ops = await savedOps({ modbus: { registerBase: 0 } });
    expect(opNamed(ops, "SetModbusConfig")).toEqual({
      op: "SetModbusConfig",
      config: { register_base: 0, device_address: undefined, default_interval: undefined, default_byte_order: undefined, default_word_order: undefined },
    });
  });

  it("keeps the file's default frame", async () => {
    const ops = await savedOps({ meta: { name: "d", version: 3, defaultFrame: "serial" } });
    expect(ops[0]).toEqual({ op: "SetMeta", meta: { name: "d", version: 3, default_frame: "serial" } });
  });

  it("keeps the file's minimum serial frame length and frame id mask", async () => {
    const ops = await savedOps({ serial: { encoding: "slip", minFrameLength: 4, frameIdMask: 0xff00 } });
    expect(opNamed(ops, "SetSerialConfig")).toMatchObject({ config: { encoding: "slip", min_frame_length: 4, frame_id_mask: 0xff00 } });
  });

  it("deletes a protocol's section when it is turned off", async () => {
    const ops = await savedOps({ can: {} }, { can: false, serial: false, modbus: false });
    expect(ops.slice(1)).toEqual([
      { op: "DeleteAtPath", path: ["meta", "can"] },
      { op: "DeleteAtPath", path: ["meta", "serial"] },
      { op: "DeleteAtPath", path: ["meta", "modbus"] },
    ]);
  });
});
