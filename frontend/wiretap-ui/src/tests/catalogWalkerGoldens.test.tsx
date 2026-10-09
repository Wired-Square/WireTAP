// @vitest-environment jsdom
//
// The item each bit-layout preview asks `catalog.frameLayout` for and what it hands
// BitPreview from the answer (the layout itself is the crate's, pinned by the
// Rust test `a_frame_layout_flags_the_item_its_path_addresses`), and the id
// helpers the editor still formats with.

import { describe, it, vi } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "../i18n";

const requests: unknown[] = [];
const LAYOUT = {
  byteLength: 8,
  ranges: [
    { name: "a", startBit: 0, bitLength: 8, kind: "signal" },
    { name: "sel", startBit: 8, bitLength: 4, kind: "selector", edited: true },
    { startBit: 56, bitLength: 8, kind: "checksum" },
  ],
};
vi.mock("../api/catalog", () => ({
  frameLayout: vi.fn(async (_content: string, protocol: string, key: string, path: string[]) => {
    requests.push({ protocol, key, path });
    return LAYOUT;
  }),
}));

const previews: unknown[] = [];
vi.mock("../components/BitPreview", () => ({
  default: ({ numBytes, ranges, currentStartBit, currentBitLength }: Record<string, unknown>) => {
    previews.push({ numBytes, ranges, currentStartBit, currentBitLength });
    return null;
  },
}));

import { formatFrameId, parseCanIdToNumber } from "../apps/catalog/utils";
import { sortMuxCaseKeys } from "../utils/muxCaseMatch";
import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import type { TomlNode } from "../apps/catalog/types";
import type { Catalog } from "../types/catalogModel";
import { useCatalogEditorStore } from "../stores/catalogEditorStore";
import CANFrameView from "../apps/catalog/views/CANFrameView";
import SerialFrameView from "../apps/catalog/views/SerialFrameView";
import MuxView from "../apps/catalog/views/MuxView";
import MuxCaseView from "../apps/catalog/views/MuxCaseView";
import SignalView from "../apps/catalog/views/SignalView";
import SignalEditDialog from "../apps/catalog/dialogs/SignalEditDialog";
import MuxEditDialog from "../apps/catalog/dialogs/MuxEditDialog";
import { expectGolden, fixtureJson, type GoldenCase } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SERVED = {
  sbrxxx: "catalog/sbrxxx.catalog.json",
  modbus: "catalog/modbus.catalog.json",
  serial: "catalog/serial.catalog.json",
} as const;
type Name = keyof typeof SERVED;

function findNode(nodes: TomlNode[], path: string[]): TomlNode {
  const want = path.join("/");
  const walk = (list: TomlNode[]): TomlNode | undefined => {
    for (const n of list) {
      if (n.path.join("/") === want) return n;
      const found = walk(n.children ?? []);
      if (found) return found;
    }
  };
  const node = walk(nodes);
  if (!node) throw new Error(`no node at ${want}`);
  return node;
}

function idCases(): GoldenCase[] {
  return [
    {
      name: "mux case key order",
      input: ["10", "2", "0-3", "1,2", "abc", "-1", "B", "a", "0x10", "2-5"],
      expected: sortMuxCaseKeys(["10", "2", "0-3", "1,2", "abc", "-1", "B", "a", "0x10", "2-5"]),
    },
    {
      name: "id parsing and the editor's id formatting",
      input: ["0x7FF", "0x800", "0x1FFFFFFF", "2047", " 256 ", "0X10", "-1", "status", "", "1e3"],
      expected: ["0x7FF", "0x800", "0x1FFFFFFF", "2047", " 256 ", "0X10", "-1", "status", "", "1e3"].map((id) => ({
        number: parseCanIdToNumber(id),
        hex: formatFrameId(id, "hex"),
        decimal: formatFrameId(id, "decimal"),
      })),
    },
  ];
}

const noop = () => {};

type Site = { name: string; catalogue: Name; path: string[]; render: (node: () => TomlNode) => [ComponentType<any>, object] };

const view = (Component: ComponentType<any>, props: object = {}) => (node: () => TomlNode): [ComponentType<any>, object] => [Component, { selectedNode: node(), ...props }];

const SITES: Site[] = [
  ...(["0x70F", "0x00a"] as const).map((id): Site => ({
    name: `CANFrameView ${id}`,
    catalogue: "sbrxxx",
    path: ["frame", "can", id],
    render: view(CANFrameView, { editingSignal: false, onAddSignal: noop, onEditSignal: noop, onRequestDeleteSignal: noop, onAddMux: noop }),
  })),
  ...(["0x20", "heartbeat"] as const).map((id): Site => ({
    name: `SerialFrameView ${id}`,
    catalogue: "serial",
    path: ["frame", "serial", id],
    render: view(SerialFrameView),
  })),
  ...([["sbrxxx", ["frame", "can", "0x70F", "mux"]], ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux"]]] as const).map(
    ([catalogue, path]): Site => ({
      name: `MuxView ${path.join(".")}`,
      catalogue,
      path: [...path],
      render: view(MuxView, { onAddCase: noop, onEditMux: noop, onDeleteMux: noop, onSelectNode: noop }),
    }),
  ),
  {
    name: "MuxCaseView frame.can.0x71F.mux.8.mux.3",
    catalogue: "sbrxxx",
    path: ["frame", "can", "0x71F", "mux", "8", "mux", "3"],
    render: view(MuxCaseView, { onAddSignal: noop, onAddNestedMux: noop, onDeleteCase: noop, onSelectNode: noop }),
  },
  ...(
    [
      ["sbrxxx", ["frame", "can", "0x70F", "mux", "4", "signals", "1"]],
      ["modbus", ["frame", "modbus", "100", "signals", "0"]],
    ] as const
  ).map(([catalogue, path]): Site => ({
    name: `SignalView ${catalogue} ${path.join(".")}`,
    catalogue,
    path: [...path],
    render: view(SignalView, { onEditSignal: noop, onRequestDeleteSignal: noop }),
  })),
  ...(
    [
      [["frame", "can", "0x70F"], null],
      [["frame", "can", "0x71F", "mux", "8", "mux", "3"], 0],
    ] as const
  ).map(([ownerPath, editingIndex]): Site => ({
    name: `SignalEditDialog ${ownerPath.join(".")} editing ${editingIndex}`,
    catalogue: "sbrxxx",
    path: [...ownerPath],
    render: () => [
      SignalEditDialog,
      { open: true, ownerPath: [...ownerPath], fields: { name: "New", start_bit: 16, bit_length: 8 }, setFields: noop, editingIndex, onCancel: noop, onSave: noop },
    ],
  })),
  ...(
    [
      [["frame", "can", "0x71F", "mux", "8"], false],
      [["frame", "can", "0x70F", "mux"], true],
    ] as const
  ).map(([muxPath, existing]): Site => ({
    name: `MuxEditDialog ${muxPath.join(".")}${existing ? " editing" : " adding"}`,
    catalogue: "sbrxxx",
    path: [...muxPath],
    render: () => [
      MuxEditDialog,
      { open: true, currentMuxPath: [...muxPath], isAddingNestedMux: !existing, isEditingExistingMux: existing, fields: { name: "", start_bit: 0, bit_length: 8 }, setFields: noop, onCancel: noop, onSave: noop },
    ],
  })),
];

async function previewCases(): Promise<GoldenCase[]> {
  const cases: GoldenCase[] = [];
  for (const { name, catalogue, path, render } of SITES) {
    const catalog = fixtureJson<Catalog>(SERVED[catalogue]);
    useCatalogEditorStore.setState((s) => ({ content: { ...s.content, toml: catalogue }, tree: { ...s.tree, catalog } }));
    const [Component, props] = render(() => findNode(catalogToTree(catalog), path));
    requests.length = 0;
    previews.length = 0;
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Component, props)));
    act(() => root.unmount());
    cases.push({ name, input: { catalogue: SERVED[catalogue], path }, expected: { requests: [...requests], preview: previews[previews.length - 1] ?? null } });
  }
  return cases;
}

describe("catalogue layout goldens", () => {
  it("matches walkers.json", async () => {
    await expectGolden("walkers.json", idCases());
  });

  it("matches bitPreviewRanges.json", async () => {
    await expectGolden("bitPreviewRanges.json", await previewCases());
  });
});
