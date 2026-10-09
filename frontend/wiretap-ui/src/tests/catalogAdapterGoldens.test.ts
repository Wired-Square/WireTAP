// The editor's tree over the served `Catalog` (`catalog.parse`, pinned by the Rust
// test `catalog_parse_serves_the_adapter_fixtures`), and the decoders' adapter, over
// a CAN, a Modbus and a serial catalogue.

import { describe, it } from "vitest";
import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import type { TomlNode } from "../apps/catalog/types";
import { catalogToResolved } from "../utils/catalogParser";
import type { Catalog } from "../types/catalogModel";
import { expectGolden, fixtureJson } from "./catalogGoldens";

const CATALOGUES = ["sbrxxx", "modbus", "serial"];

/** Each node's place in the tree; the model it points at is the served fixture's. */
function outline(nodes: TomlNode[]): unknown[] {
  return nodes.map(({ key, type, path, children, metadata }) => ({
    key,
    type,
    path: path.join("."),
    ...(metadata?.inherited ? { inherited: true } : {}),
    ...(children ? { children: outline(children) } : {}),
  }));
}

describe.each(CATALOGUES)("the %s catalogue", (name) => {
  const input = `catalog/${name}.catalog.json`;
  const catalog = fixtureJson<Catalog>(input);

  it("outlines the editor tree", async () => {
    await expectGolden(`tree.${name}.json`, [{ name, input, expected: outline(catalogToTree(catalog)) }]);
  });

  it("adapts to the decoders' ParsedCatalog", async () => {
    const { rawToml: _, ...resolved } = catalogToResolved(catalog, "");
    await expectGolden(`resolved.${name}.json`, [{ name, input, expected: { ...resolved, frames: [...resolved.frames] } }]);
  });
});

describe("the configurations the decoders' adapter reads", () => {
  const models: [string, Partial<Catalog>][] = [
    ["a CAN section with no byte order", { can: { defaultExtended: true } }],
    ["a serial checksum with no calculation end and no encoding", { serial: { checksum: { algorithm: "xor", startByte: -1, byteLength: 1, calcStartByte: 0, bigEndian: false } } }],
    ["a Modbus section with no register base", { modbus: { defaultInterval: 500 } }],
  ];

  it("matches treeConfigs.json", async () => {
    await expectGolden(
      "treeConfigs.json",
      models.map(([name, extra]) => {
        const input = { meta: { name: "d", version: 1 }, frames: [], protocol: "can", ...extra } as Catalog;
        const { canConfig: can, serialConfig: serial, modbusConfig: modbus } = catalogToResolved(input, "");
        return { name, input, expected: { resolved: { can, serial, modbus } } };
      }),
    );
  });
});
