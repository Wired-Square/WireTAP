// @vitest-environment jsdom
//
// The authoring rules the editor applies before an edit reaches the crate: the
// ops `editorOps.ts`, the protocol handlers and the editor's frame, mux, node and
// signal handlers send for representative forms.

import { describe, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("../api/catalog", () => ({
  editCatalog: vi.fn(async (toml: string, op: unknown) => (sent.push(op), toml)),
  editCatalogOps: vi.fn(async (toml: string, ops: unknown[]) => (sent.push(...ops), toml)),
  validateFrameWs: vi.fn(async () => []),
  validateSignalWs: vi.fn(async () => []),
  validateChecksumWs: vi.fn(async () => []),
}));

import * as ops from "../apps/catalog/editorOps";
import { protocolRegistry } from "../apps/catalog/protocols";
import { useFrameHandlers } from "../apps/catalog/hooks/handlers/useFrameHandlers";
import { useMuxHandlers } from "../apps/catalog/hooks/handlers/useMuxHandlers";
import { signalFieldsFor, useSignalHandlers } from "../apps/catalog/hooks/handlers/useSignalHandlers";
import { useCatalogEditorStore } from "../stores/catalogEditorStore";
import type { FrameEditFields } from "../apps/catalog/views/FrameEditView";
import type { ProtocolType } from "../apps/catalog/types";
import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import type { TomlNode } from "../apps/catalog/types";
import type { Catalog } from "../types/catalogModel";
import { expectGolden, fixtureJson, renderHookOnce, type GoldenCase } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOML = '[meta]\nname = "x"\nversion = 1\n\n[frame.can."0x100"]\nlength = 8\n';

type Case = { name: string; input: any; run: (input: any) => Promise<unknown> | unknown };

/** The ops a call sent, beside anything it returned. */
async function sentBy(call: () => Promise<unknown> | unknown) {
  sent.length = 0;
  const returned = await call();
  return returned === undefined || typeof returned === "string" ? { ops: [...sent] } : { ops: [...sent], returned };
}

function setEditor(state: { toml?: string; forms?: object; tree?: object; dialogPayload?: object }) {
  useCatalogEditorStore.setState((s) => ({
    content: { ...s.content, toml: state.toml ?? TOML },
    forms: { ...s.forms, ...state.forms },
    tree: { ...s.tree, ...state.tree },
    ui: { ...s.ui, dialogPayload: { ...s.ui.dialogPayload, ...state.dialogPayload } },
  }));
}

function findNode(nodes: TomlNode[], path: string[]): TomlNode | undefined {
  for (const node of nodes) {
    if (node.path.join("/") === path.join("/")) return node;
    const found = findNode(node.children ?? [], path);
    if (found) return found;
  }
  return undefined;
}

const setters = () => ({
  setEditingId: vi.fn(),
  setEditingFrameId: vi.fn(),
  setEditingFrame: vi.fn(),
  setFrameFields: vi.fn(),
  setEditingFrameOriginalKey: vi.fn(),
});

function frameHandlers(frameFields?: FrameEditFields, editingFrameOriginalKey: string | null = null, editingFrameId: string | null = null) {
  const s = setters();
  const handlers = renderHookOnce(() => useFrameHandlers({ ...s, editingFrameId, frameFields, editingFrameOriginalKey }));
  return { handlers, s };
}

function muxHandlers(muxFields = { name: "", start_bit: 0, bit_length: 8 }, currentMuxPath: string[] = [], isEditingExistingMux = false) {
  const s = {
    setEditingMux: vi.fn(),
    setMuxFields: vi.fn(),
    setCurrentMuxPath: vi.fn(),
    setIsAddingNestedMux: vi.fn(),
    setIsEditingExistingMux: vi.fn(),
  };
  return { handlers: renderHookOnce(() => useMuxHandlers({ ...s, muxFields, currentMuxPath, isEditingExistingMux })), s };
}

const opCases: Case[] = [
  {
    name: "CAN frame (legacy editor): notes array of one collapses, interval goes under tx",
    input: { id: "0x123", length: 8, transmitter: "BMS", interval: 100, notes: ["one"] },
    run: (p) => sentBy(() => ops.upsertCanFrameToml(TOML, p)),
  },
  {
    name: "CAN frame (legacy editor): inherited length, transmitter and interval are omitted, a rename names the old key",
    input: { oldId: "0x100", id: "0x101", length: 8, transmitter: "BMS", interval: 100, isLengthInherited: true, isTransmitterInherited: true, isIntervalInherited: true, notes: [] },
    run: (p) => sentBy(() => ops.upsertCanFrameToml(TOML, p)),
  },
  {
    name: "CAN frame (legacy editor): two notes stay an array, an empty string is dropped",
    input: [{ id: "0x1", length: 0, notes: ["a", "b"] }, { id: "0x2", length: 8, notes: "" }],
    run: async (ps) => [await sentBy(() => ops.upsertCanFrameToml(TOML, ps[0])), await sentBy(() => ops.upsertCanFrameToml(TOML, ps[1]))],
  },
  ...(
    [
      ["can", { length: 8, transmitter: "BMS", interval: 100, notes: ["n"], signals: [{ name: "s" }], mux: { name: "m" }, checksums: [] }, { protocol: "can", id: "0x200", extended: false, fd: true, bus: 1, copy: "0x100", mirror_of: "0x300" }, {}],
      ["can", { length: 8, transmitter: "BMS", interval: 100 }, { protocol: "can", id: "0x200", extended: true, fd: false }, { length: true, transmitter: true, interval: true, extended: true, fd: true }],
      ["modbus", { length: 1, interval: 500 }, { protocol: "modbus", register_number: 13021, node_address: 3, register_type: "holding", register_base: 1 }, {}],
      ["modbus", { length: 4, transmitter: "Inverter", notes: "n" }, { protocol: "modbus", register_type: "coil", register_base: 0 }, { registerBase: true, interval: true }],
      ["serial", { length: 0, interval: 250 }, { protocol: "serial", frame_id: "0x10", delimiter: [] }, {}],
      ["serial", { length: 12, transmitter: "Controller" }, { protocol: "serial", frame_id: "", delimiter: [0xc0, 0x00] }, { interval: true }],
    ] as const
  ).map(([protocol, base, config, omitInherited]): Case => ({
    name: `${protocol} frame through its handler: ${JSON.stringify(config)}${Object.keys(omitInherited).length ? " with inherited fields omitted" : ""}`,
    input: { protocol, base, config, omitInherited },
    run: async (p) => ({
      serialised: protocolRegistry.get(p.protocol)!.serializeFrame("key", p.base, p.config, p.omitInherited),
      ...(await sentBy(() => ops.upsertFrameToml(TOML, { ...p, key: undefined, originalKey: "old" }))),
    }),
  })),
  {
    name: "Serial frame shorthand",
    input: { oldKey: "0x10", frameId: "0x11", length: 6, delimiter: [0x7e], transmitter: "Controller", interval: 50, notes: ["a"], isIntervalInherited: false },
    run: (p) => sentBy(() => ops.upsertSerialFrameToml(TOML, p)),
  },
  {
    name: "Signal with the editor's new-signal defaults: endianness renamed, empty confidence dropped, defaults passed through",
    input: { path: ["frame", "can", "0x100"], index: null, signal: { name: "S", start_bit: 0, bit_length: 8, factor: 1, offset: 0, unit: "", signed: false, endianness: undefined, confidence: "", notes: "" } },
    run: (p) => sentBy(() => ops.upsertSignalToml(TOML, p.path, p.signal, p.index)),
  },
  {
    name: "Signal at a full signal path inside a mux case: index from the path, notes become a one-line array",
    input: { path: ["frame", "can", "0x100", "mux", "1", "signals", "3"], index: null, signal: { name: "T", start_bit: 16, bit_length: 16, factor: 0.1, offset: -40, unit: "C", signed: true, endianness: "big", min: -40, max: 125, format: "number", confidence: "high", enum: { "0": "Off" }, notes: "two\nlines" } },
    run: (p) => sentBy(() => ops.upsertSignalToml(TOML, p.path, p.signal, p.index)),
  },
  {
    name: "Signal delete at a mux case",
    input: { path: ["frame", "can", "0x100", "mux", "1"], index: 2 },
    run: (p) => sentBy(() => ops.deleteSignalToml(TOML, p.path, p.index)),
  },
  {
    name: "Mux upsert and delete, notes to an array",
    input: { owner: ["frame", "can", "0x100"], mux: { name: "mux_256_0_8", start_bit: 0, bit_length: 8, notes: "page" } },
    run: async (p) => [await sentBy(() => ops.upsertMuxToml(TOML, p.owner, p.mux)), await sentBy(() => ops.deleteMuxToml(TOML, [...p.owner, "mux"]))],
  },
  {
    name: "Mux case add, rename and delete",
    input: { muxPath: ["frame", "can", "0x100", "mux"] },
    run: async (p) => [
      await sentBy(() => ops.addMuxCaseToml(TOML, p.muxPath, "1", "first")),
      await sentBy(() => ops.addMuxCaseToml(TOML, p.muxPath, "2", "")),
      await sentBy(() => ops.editMuxCaseToml(TOML, p.muxPath, "1", "0-3", undefined)),
      await sentBy(() => ops.deleteMuxCaseToml(TOML, p.muxPath, "2")),
    ],
  },
  {
    name: "Node add, rename and delete",
    input: {},
    run: async () => [
      await sentBy(() => ops.addNodeToml(TOML, "BMS", "Battery", 3)),
      await sentBy(() => ops.addNodeToml(TOML, "Charger", "", undefined)),
      await sentBy(() => ops.editNodeToml(TOML, "BMS", "Pack", undefined, 0)),
      await sentBy(() => ops.deleteNodeToml(TOML, "Pack")),
    ],
  },
  {
    name: "Checksum: endianness only past one byte",
    input: [
      { name: "CRC", algorithm: "crc8", start_byte: 7, byte_length: 1, endianness: "big", calc_start_byte: 0, calc_end_byte: 7, notes: "" },
      { name: "CRC16", algorithm: "crc16_modbus", start_byte: -2, byte_length: 2, endianness: "little", calc_start_byte: 0, calc_end_byte: -2, notes: "Modbus" },
    ],
    run: async (cs) => [
      await sentBy(() => ops.upsertChecksumToml(TOML, ["frame", "can", "0x100"], cs[0], null)),
      await sentBy(() => ops.upsertChecksumToml(TOML, ["frame", "serial", "0x10"], cs[1], 0)),
      await sentBy(() => ops.deleteChecksumToml(TOML, ["frame", "can", "0x100"], 0)),
    ],
  },
  {
    name: "Config ops: CAN default endianness renamed, serial checksum to camelCase, Modbus passed through",
    input: {
      meta: { name: "N", version: 2, default_frame: "can" },
      can: { default_endianness: "big", default_interval: 100, default_extended: true, default_fd: undefined, frame_id_mask: 0x1fffff00, fields: { source: { mask: 0xff, format: "hex" } } },
      serial: { encoding: "cobs", byte_order: "little", header_length: 2, min_frame_length: 0, frame_id_mask: undefined, fields: { id: { mask: 0xff00, endianness: "big", format: "hex" } }, checksum: { algorithm: "xor", start_byte: -1, byte_length: 1, calc_start_byte: 0, calc_end_byte: -1, big_endian: false } },
      modbus: { device_address: 7, register_base: 1, default_interval: 1000, default_byte_order: "big", default_word_order: "little" },
    },
    run: (p) => ({ ops: [ops.metaOp(p.meta), ops.canConfigOp(p.can), ops.serialConfigOp(p.serial), ops.modbusConfigOp(p.modbus)] }),
  },
  {
    name: "Frame keys a fresh frame falls back to, and the handlers' display ids",
    input: {
      can: [{ protocol: "can", id: "0x7FF" }, { protocol: "can", id: "256" }, { protocol: "can", id: "status" }, { protocol: "can", id: "" }],
      modbus: [{ protocol: "modbus", register_number: 5000, node_address: 3 }, { protocol: "modbus" }],
      serial: [{ protocol: "serial", frame_id: "0x10" }, { protocol: "serial" }],
    },
    run: (p) =>
      Object.fromEntries(
        (["can", "modbus", "serial"] as ProtocolType[]).map((protocol) => {
          const handler = protocolRegistry.get(protocol)!;
          return [
            protocol,
            {
              defaultConfig: handler.getDefaultConfig(),
              frames: p[protocol].map((config: any) => ({
                key: handler.getFrameKey(config),
                displayId: handler.getFrameDisplayId(config),
                displaySecondary: handler.getFrameDisplaySecondary?.(config) ?? null,
              })),
            },
          ];
        }),
      ),
  },
];

const frameFields = (protocol: ProtocolType, config: object, base: object, modbusFrameKey?: string, inherited: object = {}): FrameEditFields =>
  ({ protocol, config, base, modbusFrameKey, ...inherited }) as FrameEditFields;

const handlerCases: Case[] = [
  ...(
    [
      ["holding, two registers", "5000", { register_type: "holding" }, 2],
      ["input, length 0 seeds one register", "13021", { register_type: "input" }, 0],
      ["coil, four coils, no byte order", "100", { register_type: "coil" }, 4],
      ["discrete, one input", "200", { register_type: "discrete" }, 1],
      ["no register type", "300", {}, 3],
      ["a key of spaces names the signal value", "  ", { register_type: "holding" }, 1],
    ] as const
  ).map(([label, key, config, length]): Case => ({
    name: `New Modbus frame seeds one signal: ${label}`,
    input: { modbusFrameKey: key, config: { protocol: "modbus", ...config }, length },
    run: (p) => {
      setEditor({});
      const { handlers } = frameHandlers(frameFields("modbus", p.config, { length: p.length }, p.modbusFrameKey));
      return sentBy(() => handlers.handleSaveFrame());
    },
  })),
  {
    name: "Editing a Modbus frame seeds nothing",
    input: { originalKey: "5000", config: { protocol: "modbus", register_type: "input" }, length: 2 },
    run: (p) => {
      setEditor({});
      const { handlers } = frameHandlers(frameFields("modbus", p.config, { length: p.length }, "5000"), p.originalKey);
      return sentBy(() => handlers.handleSaveFrame());
    },
  },
  {
    name: "A blank frame identifier is refused before any op",
    input: { config: { protocol: "can", id: "" } },
    run: async (p) => {
      setEditor({});
      const { handlers } = frameHandlers(frameFields("can", p.config, { length: 8 }));
      const result = await sentBy(() => handlers.handleSaveFrame());
      return { ...result, validation: useCatalogEditorStore.getState().validation.errors };
    },
  },
  ...(
    [
      ["can", "0x200", { frameType: "can", idValue: "0x200", length: 8, lengthInherited: false, transmitter: "BMS", transmitterInherited: true, interval: 100, intervalInherited: true, extended: false, extendedInherited: true, fd: false, fdInherited: true, bus: 1, copyFrom: "0x100", mirrorOf: "0x300", notes: ["n"] }],
      ["modbus", "battery_power", { frameType: "modbus", length: 1, registerNumber: 13021, nodeAddress: 3, registerType: "input", interval: 1000, intervalInherited: true }],
      ["modbus", "5000", { frameType: "modbus", registerNumber: 5000 }],
      ["serial", "0x20", { frameType: "serial", frameId: "0x20", length: 16, delimiter: [192] }],
    ] as const
  ).map(([protocol, key, metadata]): Case => ({
    name: `Editing a ${protocol} tree node, then saving it unchanged: ${key}`,
    input: { key, metadata },
    run: async (p) => {
      setEditor({});
      const opened = frameHandlers();
      opened.handlers.handleEditFrame({ key: p.key, metadata: p.metadata });
      const fields = opened.s.setFrameFields.mock.calls[0][0] as FrameEditFields;
      const originalKey = opened.s.setEditingFrameOriginalKey.mock.calls[0][0] as string;
      const { handlers } = frameHandlers(fields, originalKey);
      return { fields, originalKey, ...(await sentBy(() => handlers.handleSaveFrame())) };
    },
  })),
  {
    name: "Editing then saving a Modbus frame as the tree shows it: the model's byte length becomes the register count",
    input: { catalogue: "catalog/modbus.catalog.json", path: ["frame", "modbus", "5000"] },
    run: async (p) => {
      setEditor({});
      const node = findNode(catalogToTree(fixtureJson<Catalog>(p.catalogue)).tree, p.path)!;
      const opened = frameHandlers();
      opened.handlers.handleEditFrame(node);
      const fields = opened.s.setFrameFields.mock.calls[0][0] as FrameEditFields;
      const { handlers } = frameHandlers(fields, node.key);
      return { treeLength: node.metadata?.length, fields, ...(await sentBy(() => handlers.handleSaveFrame())) };
    },
  },
  {
    name: "Adding a frame: each protocol's starting form",
    input: ["can", "modbus", "serial"],
    run: (protocols: ProtocolType[]) =>
      protocols.map((protocol) => {
        const { handlers, s } = frameHandlers();
        handlers.handleAddFrame(protocol);
        return s.setFrameFields.mock.calls[0][0];
      }),
  },
  {
    name: "Editing then saving a CAN frame in the legacy editor",
    input: { key: "0x200", metadata: { idValue: "0x200", length: 0, lengthInherited: true, transmitter: "BMS", transmitterInherited: false, interval: 100, intervalInherited: true, notes: ["n"] } },
    run: async (p) => {
      setEditor({});
      frameHandlers().handlers.handleEditId({ type: "can-frame", key: p.key, metadata: p.metadata });
      const form = useCatalogEditorStore.getState().forms.canFrame;
      const { handlers } = frameHandlers(undefined, null, p.key);
      return { form, ...(await sentBy(() => handlers.handleSaveId())) };
    },
  },
  {
    name: "Saving the configuration: CAN mask and header fields parsed, disabled protocols deleted",
    input: {
      forms: {
        meta: { name: "N", version: 4, default_frame: "can" },
        canDefaultEndianness: "big",
        canDefaultInterval: 100,
        canDefaultExtended: true,
        canDefaultFd: undefined,
        canFrameIdMask: " 0x1FFFFF00 ",
        canHeaderFields: [
          { name: " source ", mask: "0xFF", shift: 0, format: "hex" },
          { name: "priority", mask: "zz", shift: 26, format: "decimal" },
          { name: "", mask: "0xF0", format: "hex" },
          { name: "blank", mask: " ", format: "hex" },
        ],
      },
      enabled: { can: true, serial: false, modbus: false },
    },
    run: (p) => {
      setEditor({ forms: p.forms });
      return sentBy(() => frameHandlers().handlers.handleSaveConfig(p.enabled));
    },
  },
  {
    name: "Saving the configuration: serial header fields and the file's mask carried, Modbus device address from the file",
    input: {
      forms: {
        meta: { name: "N", version: 4 },
        serialEncoding: "raw",
        serialByteOrder: "little",
        serialHeaderLength: 3,
        serialHeaderFields: [
          { name: "id", mask: 0xff00, endianness: "big", format: "hex" },
          { name: " ", mask: 0xff, endianness: "big", format: "decimal" },
        ],
        serialChecksum: { algorithm: "sum8", start_byte: -1, byte_length: 1, calc_start_byte: 0, calc_end_byte: -1 },
        modbusRegisterBase: 1,
        modbusDefaultInterval: 1000,
        modbusDefaultByteOrder: "big",
        modbusDefaultWordOrder: "little",
        canFrameIdMask: "",
        canHeaderFields: [],
      },
      tree: { serialConfig: { encoding: "raw", frame_id_mask: 0xff00, min_frame_length: 4 }, modbusConfig: { register_base: 0, device_address: 9 } },
      enabled: { can: false, serial: true, modbus: true },
    },
    run: (p) => {
      setEditor({ forms: p.forms, tree: p.tree });
      return sentBy(() => frameHandlers().handlers.handleSaveConfig(p.enabled));
    },
  },
  {
    name: "Nodes: notes trimmed, blank notes dropped",
    input: { add: { nodeName: "BMS", nodeNotes: "  Battery  ", nodeDeviceAddress: 3 }, edit: { nodeName: "Pack", nodeNotes: "   ", nodeDeviceAddress: undefined } },
    run: async (p) => {
      setEditor({ forms: p.add });
      const added = await sentBy(() => frameHandlers().handlers.handleSaveNode());
      setEditor({ forms: p.edit, dialogPayload: { editingNodeOriginalName: "BMS" } });
      const edited = await sentBy(() => frameHandlers().handlers.handleSaveEditNode());
      return [added, edited];
    },
  },
];

const muxCases: Case[] = [
  {
    name: "Mux names minted from the frame key, start bit and length",
    input: [
      [["frame", "can", "0x71F"], 0, 8, false],
      [["frame", "can", "1823"], 8, 4, false],
      [["frame", "serial", "0x20"], 24, 8, false],
      [["frame", "serial", "heartbeat"], 0, 8, false],
      [["frame", "can", "0x71F", "mux", "3"], 8, 8, true],
      [["frame", "can", "0x71F", "mux", "0-3"], 16, 8, true],
      [["frame", "can", "0x71F", "mux", "3", "mux", "1"], 24, 8, true],
      [["0x100"], 0, 8, false],
    ],
    run: (calls: [string[], number, number, boolean][]) => {
      const { handlers } = muxHandlers();
      return calls.map((args) => handlers.generateMuxName(...args));
    },
  },
  {
    name: "Adding a mux: the default name and owner path",
    input: [["0x71F", undefined], ["256", undefined], ["status", ["frame", "serial", "status"]]],
    run: (calls: [string, string[] | undefined][]) =>
      calls.map(([idKey, path]) => {
        const { handlers, s } = muxHandlers();
        handlers.handleAddMux(idKey, path);
        return { path: s.setCurrentMuxPath.mock.calls[0][0], fields: s.setMuxFields.mock.calls[0][0] };
      }),
  },
  {
    name: "Adding a nested mux under a case",
    input: ["frame", "can", "0x71F", "mux", "4"],
    run: (path: string[]) => {
      const { handlers, s } = muxHandlers();
      handlers.handleAddNestedMux(path);
      return { path: s.setCurrentMuxPath.mock.calls[0][0], fields: s.setMuxFields.mock.calls[0][0] };
    },
  },
  {
    name: "Editing a mux: notes joined, missing fields defaulted",
    input: [{ name: "Page", start_bit: 8, bit_length: 4, notes: ["a", "b"] }, { start_bit: 0, bit_length: 0 }],
    run: (muxes: object[]) =>
      muxes.map((mux) => {
        const { handlers, s } = muxHandlers();
        handlers.handleEditMux(["frame", "can", "0x100", "mux"], mux);
        return s.setMuxFields.mock.calls[0][0];
      }),
  },
  {
    name: "Saving a mux: an existing mux's path loses its trailing mux",
    input: [
      { path: ["frame", "can", "0x100", "mux"], existing: true },
      { path: ["frame", "can", "0x100"], existing: false },
      { path: ["frame", "can", "0x100", "mux", "4"], existing: false },
    ],
    run: async (calls: { path: string[]; existing: boolean }[]) => {
      setEditor({});
      const out = [];
      for (const { path, existing } of calls) {
        const { handlers } = muxHandlers({ name: "m", start_bit: 0, bit_length: 8 }, path, existing);
        out.push(await sentBy(() => handlers.handleSaveMux()));
      }
      return out;
    },
  },
  {
    name: "Mux cases: notes trimmed on add and rename",
    input: { muxPath: ["frame", "can", "0x100", "mux"], add: { muxCaseValue: "5", muxCaseNotes: "  five " }, edit: { muxCaseValue: "5-6", muxCaseNotes: " " } },
    run: async (p) => {
      setEditor({ forms: p.add, dialogPayload: { currentMuxPath: p.muxPath } });
      const added = await sentBy(() => muxHandlers().handlers.handleSaveCase());
      setEditor({ forms: p.edit, dialogPayload: { editingCaseMuxPath: p.muxPath, editingCaseOriginalValue: "5" } });
      const edited = await sentBy(() => muxHandlers().handlers.handleSaveEditCase());
      return [added, edited];
    },
  },
];

const signalCases: Case[] = [
  {
    name: "A signal read back into the form: byte_order to endianness, string bits coerced, notes joined",
    input: [
      { name: "A", start_bit: "8", bit_length: "x", byte_order: "big", notes: ["one", "two"], factor: 0.5 },
      { start_bit: 0, endianness: "little", byte_order: "big", notes: "single" },
      {},
    ],
    run: (signals: object[]) => signals.map(signalFieldsFor),
  },
  {
    name: "Adding a signal, then saving the defaults",
    input: { idKey: "0x100", path: ["frame", "can", "0x100", "mux", "1"] },
    run: async (p) => {
      setEditor({});
      const s = {
        setEditingSignal: vi.fn(),
        setSignalFields: vi.fn(),
        setEditingSignalIndex: vi.fn(),
        setCurrentIdForSignal: vi.fn(),
        setCurrentSignalPath: vi.fn(),
      };
      const open = renderHookOnce(() => useSignalHandlers({ ...s, signalFields: {} as any, currentIdForSignal: null, currentSignalPath: [], editingSignalIndex: null }));
      open.handleAddSignal(p.idKey, p.path);
      const fields = s.setSignalFields.mock.calls[0][0];
      const save = renderHookOnce(() =>
        useSignalHandlers({ ...s, signalFields: { ...fields, name: "S" }, currentIdForSignal: p.idKey, currentSignalPath: p.path, editingSignalIndex: null }),
      );
      return { fields, ...(await sentBy(() => save.handleSaveSignal())) };
    },
  },
];

describe("catalogue authoring golden", () => {
  it("matches authoring.json", async () => {
    const cases: GoldenCase[] = [];
    for (const { name, input, run } of [...opCases, ...handlerCases, ...muxCases, ...signalCases]) {
      cases.push({ name, input, expected: await run(input) });
    }
    await expectGolden("authoring.json", cases);
  });
});
