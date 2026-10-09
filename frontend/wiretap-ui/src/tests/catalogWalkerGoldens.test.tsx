// @vitest-environment jsdom
//
// The raw-document walkers in `apps/catalog/utils.ts`, and the bit ranges and
// byte count each editor view and dialog hands BitPreview, over the TOML the
// editor holds and the tree `catalogToTree` builds from the served model.

import { describe, it, vi } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "../i18n";

const previews: unknown[] = [];
vi.mock("../components/BitPreview", () => ({
  default: ({ numBytes, ranges, currentStartBit, currentBitLength }: Record<string, unknown>) => {
    previews.push({ numBytes, ranges, currentStartBit, currentBitLength });
    return null;
  },
}));

import { tomlParse } from "../apps/catalog/toml";
import {
  extractMuxRangesFromPath,
  extractSignalRangesFromPath,
  formatFrameId,
  getFrameByteLengthFromPath,
  parseCanIdToNumber,
} from "../apps/catalog/utils";
import { getFrameKeys } from "../apps/catalog/editorOps";
import { sortMuxCaseKeys } from "../utils/muxCaseMatch";
import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import type { TomlNode } from "../apps/catalog/types";
import type { Catalog } from "../types/catalogModel";
import CANFrameView from "../apps/catalog/views/CANFrameView";
import SerialFrameView from "../apps/catalog/views/SerialFrameView";
import MuxView from "../apps/catalog/views/MuxView";
import MuxCaseView from "../apps/catalog/views/MuxCaseView";
import SignalView from "../apps/catalog/views/SignalView";
import SignalEditDialog from "../apps/catalog/dialogs/SignalEditDialog";
import MuxEditDialog from "../apps/catalog/dialogs/MuxEditDialog";
import { expectGolden, fixtureJson, fixtureText, type GoldenCase } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CATALOGUES = {
  sbrxxx: { toml: "sbrxxx.toml", served: "catalog/sbrxxx.catalog.json" },
  modbus: { toml: "catalog/modbus.toml", served: "catalog/modbus.catalog.json" },
  serial: { toml: "catalog/serial.toml", served: "catalog/serial.catalog.json" },
} as const;
type Name = keyof typeof CATALOGUES;

const toml = (name: Name) => fixtureText(CATALOGUES[name].toml);
const raw = (name: Name) => tomlParse(toml(name));
const tree = (name: Name) => catalogToTree(fixtureJson<Catalog>(CATALOGUES[name].served)).tree;

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

const PATHS: [Name, string[]][] = [
  ["sbrxxx", ["frame", "can", "0x70F"]],
  ["sbrxxx", ["frame", "can", "0x70F", "mux", "4"]],
  ["sbrxxx", ["frame", "can", "0x70F", "mux", "4", "signals", "1"]],
  ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux", "3"]],
  ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux", "3", "signals", "0"]],
  ["sbrxxx", ["frame", "can", "0x005"]],
  ["sbrxxx", ["frame", "can", "0x005", "signals", "0"]],
  ["sbrxxx", ["frame", "can", "0x999"]],
  ["sbrxxx", ["node", "BMS"]],
  ["modbus", ["frame", "modbus", "5000", "signals", "0"]],
  ["modbus", ["frame", "modbus", "battery_power"]],
  ["modbus", ["frame", "modbus", "100", "signals", "0"]],
  ["serial", ["frame", "serial", "0x10", "signals", "1"]],
  ["serial", ["frame", "serial", "0x20", "mux", "2-3", "signals", "0"]],
  ["serial", ["frame", "serial", "heartbeat"]],
];

function walkerCases(): GoldenCase[] {
  return [
    ...PATHS.map(([name, path]) => ({
      name: `walk ${name} ${path.join(".")}`,
      input: { catalogue: CATALOGUES[name].toml, path },
      expected: {
        muxRanges: extractMuxRangesFromPath(path, raw(name)),
        signalRanges: extractSignalRangesFromPath(path, raw(name)),
        frameByteLength: getFrameByteLengthFromPath(path, raw(name)),
      },
    })),
    {
      name: "frame keys per protocol",
      input: Object.keys(CATALOGUES),
      expected: (Object.keys(CATALOGUES) as Name[]).map((name) => ({
        can: getFrameKeys(toml(name), "can").length,
        modbus: getFrameKeys(toml(name), "modbus"),
        serial: getFrameKeys(toml(name), "serial"),
      })),
    },
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

type Site = { name: string; catalogue: Name; path: string[]; render: (node: TomlNode, content: string) => [ComponentType<any>, object] };

const SITES: Site[] = [
  ...(["0x70F", "0x71F", "0x005"] as const).map((id): Site => ({
    name: `CANFrameView ${id}`,
    catalogue: "sbrxxx",
    path: ["frame", "can", id],
    render: (node, content) => [CANFrameView, { selectedNode: node, catalogContent: content, editingId: false, editingSignal: false, onAddSignal: noop, onEditSignal: noop, onRequestDeleteSignal: noop, onAddMux: noop }],
  })),
  ...(["0x10", "0x20"] as const).map((id): Site => ({
    name: `SerialFrameView ${id}`,
    catalogue: "serial",
    path: ["frame", "serial", id],
    render: (node, content) => [SerialFrameView, { selectedNode: node, catalogContent: content }],
  })),
  ...([["sbrxxx", ["frame", "can", "0x70F", "mux"]], ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux"]], ["serial", ["frame", "serial", "0x20", "mux"]]] as const).map(
    ([catalogue, path]): Site => ({
      name: `MuxView ${path.join(".")}`,
      catalogue,
      path: [...path],
      render: (node, content) => [MuxView, { selectedNode: node, catalogContent: content, onAddCase: noop, onEditMux: noop, onDeleteMux: noop, onSelectNode: noop }],
    }),
  ),
  ...([["sbrxxx", ["frame", "can", "0x70F", "mux", "4"]], ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux", "3"]], ["serial", ["frame", "serial", "0x20", "mux", "2-3"]]] as const).map(
    ([catalogue, path]): Site => ({
      name: `MuxCaseView ${path.join(".")}`,
      catalogue,
      path: [...path],
      render: (node, content) => [MuxCaseView, { selectedNode: node, catalogContent: content, onAddSignal: noop, onAddNestedMux: noop, onDeleteCase: noop, onSelectNode: noop }],
    }),
  ),
  ...(
    [
      ["sbrxxx", ["frame", "can", "0x70F", "mux", "4", "signals", "1"]],
      ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux", "3", "signals", "0"]],
      ["modbus", ["frame", "modbus", "5000", "signals", "0"]],
      ["modbus", ["frame", "modbus", "100", "signals", "0"]],
      ["serial", ["frame", "serial", "0x10", "signals", "1"]],
    ] as const
  ).map(([catalogue, path]): Site => ({
    name: `SignalView ${catalogue} ${path.join(".")}`,
    catalogue,
    path: [...path],
    render: (node, content) => [SignalView, { selectedNode: node, catalogContent: content, onEditSignal: noop, onRequestDeleteSignal: noop, onSetValidation: noop }],
  })),
  ...(
    [
      ["sbrxxx", ["frame", "can", "0x70F"], null],
      ["sbrxxx", ["frame", "can", "0x70F", "mux", "4"], null],
      ["sbrxxx", ["frame", "can", "0x71F", "mux", "8", "mux", "3", "signals", "0"], 0],
      ["modbus", ["frame", "modbus", "5000"], 0],
      ["serial", ["frame", "serial", "0x20", "mux", "2-3"], null],
    ] as const
  ).map(([catalogue, path, editingIndex]): Site => ({
    name: `SignalEditDialog ${catalogue} ${path.join(".")} editing ${editingIndex}`,
    catalogue,
    path: [...path],
    render: (node, content) => [
      SignalEditDialog,
      { open: true, selectedNode: node, catalogContent: content, fields: { name: "New", start_bit: 0, bit_length: 8 }, setFields: noop, editingIndex, onCancel: noop, onSave: noop },
    ],
  })),
  ...(
    [
      ["sbrxxx", ["frame", "can", "0x70F"], false],
      ["sbrxxx", ["frame", "can", "0x71F", "mux", "8"], true],
      ["modbus", ["frame", "modbus", "5000"], false],
    ] as const
  ).map(([catalogue, path, nested]): Site => ({
    name: `MuxEditDialog ${catalogue} ${path.join(".")}`,
    catalogue,
    path: ["meta"],
    render: (_, content) => [
      MuxEditDialog,
      { open: true, catalogContent: content, currentMuxPath: path, isAddingNestedMux: nested, isEditingExistingMux: false, fields: { name: "m", start_bit: 0, bit_length: 8 }, setFields: noop, generateMuxName: () => "m", onCancel: noop, onSave: noop },
    ],
  })),
];

function previewCases(): GoldenCase[] {
  return SITES.map(({ name, catalogue, path, render }) => {
    const [Component, props] = render(findNode(tree(catalogue), path), toml(catalogue));
    previews.length = 0;
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Component, props)));
    act(() => root.unmount());
    return { name, input: { catalogue: CATALOGUES[catalogue].toml, path }, expected: previews.slice(0, 1) };
  });
}

describe("catalogue walkers golden", () => {
  it("matches walkers.json", async () => {
    await expectGolden("walkers.json", walkerCases());
  });

  it("matches bitPreviewRanges.json", async () => {
    await expectGolden("bitPreviewRanges.json", previewCases());
  });
});
