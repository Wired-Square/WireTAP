// The editor's tree over the served `Catalog` (`catalog.parse`, pinned by the Rust
// test `catalog_parse_serves_the_adapter_fixtures`), over a CAN, a Modbus and a
// serial catalogue.

import { describe, it } from "vitest";
import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import type { TomlNode } from "../apps/catalog/types";
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
});
