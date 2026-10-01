import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Catalog } from "../types/catalogModel";

// `catalog-model.catalog.json` is what `catalog.parse` serves for `catalog-model.toml`;
// the Rust test `catalog_parse_serves_the_catalogue_model_fixture` pins it.
const catalog = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "catalog-model.catalog.json"), "utf-8"),
) as Catalog;

describe("the catalogue model mirror", () => {
  it("carries a frame checksum's parameters and notes", () => {
    const [checksum] = catalog.frames[0].checksums ?? [];
    expect([checksum.polynomial, checksum.init, checksum.xorOut]).toEqual([77, 0, 183]);
    expect([checksum.reflectIn, checksum.reflectOut, checksum.offset]).toEqual([false, false, undefined]);
    expect(checksum.notes).toEqual(["One of several init and xor_out pairs that fit"]);
  });

  it("carries the Modbus configuration's function codes", () => {
    const codes = catalog.modbus?.functionCodes ?? {};
    expect(codes["96"].name).toBe("Dispatch");
    expect(codes["96"].lengths?.[0].len).toEqual({ countAt: 6, overhead: 9 });
    expect(codes["32"].lengths?.[0]).toEqual({ when: { offset: 4, value: 3 }, len: { fixed: 11 } });
  });
});
