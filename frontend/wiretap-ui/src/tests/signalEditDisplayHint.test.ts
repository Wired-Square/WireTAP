import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../api/catalog", () => ({ editCatalog: vi.fn(async () => "RESULT_TOML") }));

import { editCatalog } from "../api/catalog";
import { upsertSignalToml } from "../apps/catalog/editorOps";
import { signalFieldsFor } from "../apps/catalog/hooks/handlers/useSignalHandlers";
import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import type { TomlNode } from "../apps/catalog/types";
import type { Catalog } from "../types/catalogModel";

const catalog = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/display-hints.catalog.json"), "utf-8"),
) as Catalog;

function findNode(nodes: TomlNode[], path: string[]): TomlNode | undefined {
  for (const n of nodes) {
    if (n.path.join("/") === path.join("/")) return n;
    const found = findNode(n.children ?? [], path);
    if (found) return found;
  }
  return undefined;
}

// The Rust half, that `catalog.edit` keeps a `display` it is given, is
// `editing_a_signal_keeps_its_display_hint` in the app crate.
describe("editing a signal", () => {
  it("keeps its display hint", async () => {
    const node = findNode(catalogToTree(catalog).tree, ["frame", "can", "0x100", "mux", "1", "signals", "0"]);
    const fields = { ...signalFieldsFor(node?.metadata?.properties), unit: "kPa" };

    await upsertSignalToml("", ["frame", "can", "0x100", "mux", "1"], fields, 0);

    expect(vi.mocked(editCatalog).mock.calls[0][1]).toMatchObject({
      op: "UpsertArrayItem",
      array_path: ["frame", "can", "0x100", "mux", "1", "signals"],
      value: {
        name: "Boost",
        unit: "kPa",
        display: { widget: "rotary", start_angle: -90, end_angle: 90 },
      },
    });
  });
});
