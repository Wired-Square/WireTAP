// @vitest-environment jsdom
//
// What the editor sends the crate for representative forms: the typed ops carry
// intent (the crate decides what is written), the generic ops what they are given.
// `the_editors_frame_saves_change_nothing_they_were_not_asked_to` applies the
// unchanged-save ops below to the catalogues they came from.

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
import { useFrameHandlers } from "../apps/catalog/hooks/handlers/useFrameHandlers";
import { useMuxHandlers } from "../apps/catalog/hooks/handlers/useMuxHandlers";
import { signalFieldsFor, useSignalHandlers } from "../apps/catalog/hooks/handlers/useSignalHandlers";
import { NEW_MUX_FIELDS, NEW_SIGNAL_FIELDS } from "../apps/catalog/hooks/useCatalogForms";
import { useCatalogEditorStore } from "../stores/catalogEditorStore";
import type { FrameEditFields } from "../apps/catalog/views/FrameEditView";
import type { ProtocolType } from "../apps/catalog/types";
import type { Catalog, Mux } from "../types/catalogModel";
import type { MuxFields } from "../types/catalogEdit";
import { expectGolden, fixtureJson, renderHookOnce, type GoldenCase } from "./catalogGoldens";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TOML = '[meta]\nname = "x"\nversion = 1\n\n[frame.can."0x100"]\nlength = 8\n';

const SERVED = {
  sbrxxx: "catalog/sbrxxx.catalog.json",
  modbus: "catalog/modbus.catalog.json",
  serial: "catalog/serial.catalog.json",
} as const;
const served = (name: keyof typeof SERVED) => fixtureJson<Catalog>(SERVED[name]);

type Case = { name: string; input: any; run: (input: any) => Promise<unknown> | unknown };

/** The ops a call sent, beside anything it returned. */
async function sentBy(call: () => Promise<unknown> | unknown) {
  sent.length = 0;
  const returned = await call();
  return returned === undefined || typeof returned === "string" ? { ops: [...sent] } : { ops: [...sent], returned };
}

function setEditor(state: { catalog?: Catalog | null; forms?: object; dialogPayload?: object }) {
  useCatalogEditorStore.setState((s) => ({
    content: { ...s.content, toml: TOML },
    forms: { ...s.forms, ...state.forms },
    tree: { ...s.tree, catalog: state.catalog ?? null },
    ui: { ...s.ui, dialogPayload: { ...s.ui.dialogPayload, ...state.dialogPayload }, dialogs: { ...s.ui.dialogs, validationErrors: false } },
  }));
}

const frameSetters = () => ({
  setEditingFrame: vi.fn(),
  setFrameFields: vi.fn(),
  setEditingFrameOriginalKey: vi.fn(),
});

function frameHandlers(frameFields?: FrameEditFields, editingFrameOriginalKey: string | null = null) {
  const s = frameSetters();
  return { handlers: renderHookOnce(() => useFrameHandlers({ ...s, frameFields, editingFrameOriginalKey })), s };
}

function muxHandlers(muxFields: MuxFields = NEW_MUX_FIELDS, currentMuxPath: string[] = [], isEditingExistingMux = false) {
  const s = {
    setEditingMux: vi.fn(),
    setMuxFields: vi.fn(),
    setCurrentMuxPath: vi.fn(),
    setIsAddingNestedMux: vi.fn(),
    setIsEditingExistingMux: vi.fn(),
  };
  return { handlers: renderHookOnce(() => useMuxHandlers({ ...s, muxFields, currentMuxPath, isEditingExistingMux })), s };
}

/** Opens each frame in the editor and saves it untouched. */
async function saveUnchanged(catalog: Catalog, keys?: string[]) {
  setEditor({ catalog });
  const out = [];
  for (const frame of catalog.frames.filter((f) => !keys || keys.includes(f.key))) {
    const opened = frameHandlers();
    opened.handlers.handleEditFrame({ path: ["frame", frame.protocol, frame.key] });
    const fields = opened.s.setFrameFields.mock.calls[0][0] as FrameEditFields;
    const { handlers } = frameHandlers(fields, opened.s.setEditingFrameOriginalKey.mock.calls[0][0]);
    out.push({ fields, ...(await sentBy(() => handlers.handleSaveFrame())) });
  }
  return out;
}

const opCases: Case[] = [
  {
    name: "A new frame is AddFrame; an edit is SetFrame, naming the old key only on a rename",
    input: { frame: { length: 2, register_type: "input" } },
    run: async (p) => [
      await sentBy(() => ops.saveFrameToml(TOML, "modbus", "5000", p.frame, null)),
      await sentBy(() => ops.saveFrameToml(TOML, "modbus", "5000", p.frame, "5000")),
      await sentBy(() => ops.saveFrameToml(TOML, "modbus", "5001", p.frame, "5000")),
    ],
  },
  {
    name: "Signal with the editor's new-signal defaults, sent as the form holds it",
    input: { path: ["frame", "can", "0x100"], index: null, signal: { ...NEW_SIGNAL_FIELDS, name: "S", confidence: "", notes: "" } },
    run: (p) => sentBy(() => ops.upsertSignalToml(TOML, p.path, p.signal, p.index)),
  },
  {
    name: "Signal at a full signal path inside a mux case: index from the path",
    input: { path: ["frame", "can", "0x100", "mux", "1", "signals", "3"], index: null, signal: { name: "T", start_bit: 16, bit_length: 16, factor: 0.1, offset: -40, unit: "C", signed: true, byte_order: "big", min: -40, max: 125, format: "number", confidence: "high", enum: { "0": "Off" }, notes: "two\nlines" } },
    run: (p) => sentBy(() => ops.upsertSignalToml(TOML, p.path, p.signal, p.index)),
  },
  {
    name: "Signal delete at a mux case",
    input: { path: ["frame", "can", "0x100", "mux", "1"], index: 2 },
    run: (p) => sentBy(() => ops.deleteSignalToml(TOML, p.path, p.index)),
  },
  {
    name: "Mux upsert and delete",
    input: { owner: ["frame", "can", "0x100"], mux: { name: "", start_bit: 0, bit_length: 8, notes: "page" } },
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
];

const frameFields = (protocol: ProtocolType, config: object, base: object, modbusFrameKey?: string): FrameEditFields =>
  ({ protocol, config, base, modbusFrameKey }) as FrameEditFields;

const handlerCases: Case[] = [
  ...(
    [
      ["holding, two registers", "5000", { register_type: "holding" }, 2],
      ["input, length 0", "13021", { register_type: "input" }, 0],
      ["coil, four coils", "100", { register_type: "coil" }, 4],
      ["a key of spaces", "  ", { register_type: "holding" }, 1],
    ] as const
  ).map(([label, key, config, length]): Case => ({
    name: `New Modbus frame, the crate seeding its signal: ${label}`,
    input: { modbusFrameKey: key, config: { protocol: "modbus", ...config }, length },
    run: async (p) => {
      setEditor({});
      const { handlers } = frameHandlers(frameFields("modbus", p.config, { length: p.length }, p.modbusFrameKey));
      return { ...(await sentBy(() => handlers.handleSaveFrame())), validation: useCatalogEditorStore.getState().validation.errors };
    },
  })),
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
  {
    name: "A refused save is shown in the validation dialog",
    input: { refusal: "a Modbus frame covers at least one register" },
    run: async (p) => {
      setEditor({});
      const api = await import("../api/catalog");
      vi.mocked(api.editCatalogOps).mockRejectedValueOnce(p.refusal);
      const { handlers, s } = frameHandlers(frameFields("modbus", { protocol: "modbus" }, { length: 0 }, "5000"), "5000");
      await handlers.handleSaveFrame();
      const { validation, ui } = useCatalogEditorStore.getState();
      return { errors: validation.errors, dialogOpen: ui.dialogs.validationErrors, editorClosed: s.setEditingFrame.mock.calls.length > 0 };
    },
  },
  {
    name: "Saving every sbrxxx frame of interest unchanged: a plain frame, a mux frame, a mirror with an inherited mux",
    input: { catalogue: SERVED.sbrxxx, keys: ["0x100", "0x70F", "0x00a", "0x501"] },
    run: (p) => saveUnchanged(served("sbrxxx"), p.keys),
  },
  {
    name: "Saving every Modbus frame unchanged: the length goes in registers",
    input: { catalogue: SERVED.modbus },
    run: () => saveUnchanged(served("modbus")),
  },
  {
    name: "Saving every serial frame unchanged, the name-keyed one too",
    input: { catalogue: SERVED.serial },
    run: () => saveUnchanged(served("serial")),
  },
  {
    name: "Adding a frame: each protocol's starting form, and from a node",
    input: ["can", "modbus", "serial"],
    run: (protocols: ProtocolType[]) => [
      ...protocols.map((protocol) => {
        const { handlers, s } = frameHandlers();
        handlers.handleAddFrame(protocol);
        return s.setFrameFields.mock.calls[0][0];
      }),
      ...[
        ["can", { transmitter: "BMS" }],
        ["modbus", { nodeAddress: 3 }],
      ].map(([protocol, seed]) => {
        const { handlers, s } = frameHandlers();
        handlers.handleAddFrame(protocol as ProtocolType, seed as object);
        return s.setFrameFields.mock.calls[0][0];
      }),
    ],
  },
  {
    name: "Saving the configuration: masks go to the crate as typed, disabled protocols deleted",
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
    name: "Saving the configuration: an unset byte order stays unset, the file's mask and device address carried",
    input: {
      forms: {
        meta: { name: "N", version: 4 },
        serialEncoding: "raw",
        serialByteOrder: undefined,
        serialHeaderLength: 3,
        serialHeaderFields: [
          { name: "id", mask: 0xff00, endianness: "big", format: "hex" },
          { name: " ", mask: 0xff, endianness: "big", format: "decimal" },
        ],
        serialChecksum: { algorithm: "sum8", start_byte: -1, byte_length: 1, calc_start_byte: 0 },
        modbusRegisterBase: 1,
        modbusDefaultInterval: 1000,
        modbusDefaultByteOrder: undefined,
        modbusDefaultWordOrder: "little",
        canFrameIdMask: "",
        canHeaderFields: [],
      },
      catalog: { serial: { encoding: "raw", frameIdMask: 0xff00, minFrameLength: 4 }, modbus: { registerBase: 0, deviceAddress: 9 } },
      enabled: { can: false, serial: true, modbus: true },
    },
    run: (p) => {
      setEditor({ forms: p.forms, catalog: { meta: { name: "N", version: 4 }, frames: [], ...p.catalog } as Catalog });
      return sentBy(() => frameHandlers().handlers.handleSaveConfig(p.enabled));
    },
  },
  {
    name: "Configuration draft seeded from the model: unset byte orders stay unset",
    input: [
      { meta: { name: "d", version: 1 }, frames: [], can: { defaultExtended: true, frameIdMask: 0x1fffff00, fields: { src: { mask: 255 } } } },
      { meta: { name: "d", version: 1 }, frames: [], serial: { checksum: { algorithm: "xor", startByte: -1, byteLength: 1, calcStartByte: 0, bigEndian: false } } },
      { meta: { name: "d", version: 1 }, frames: [], modbus: { defaultInterval: 500, deviceAddress: 7 } },
    ],
    run: (catalogs: Catalog[]) =>
      catalogs.map((catalog) => {
        useCatalogEditorStore.getState().seedConfigForms(catalog);
        const { meta: _, nodeName: _n, nodeNotes: _o, nodeDeviceAddress: _d, muxCaseValue: _v, muxCaseNotes: _c, ...draft } = useCatalogEditorStore.getState().forms;
        return draft;
      }),
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

const sbrxxxMux = (key: string) => served("sbrxxx").frames.find((f) => f.key === key)!.mux as Mux;

const muxCases: Case[] = [
  {
    name: "Adding a mux: a blank name for the crate to mint, the owner the frame or case",
    input: [["frame", "can", "0x71F"], ["frame", "serial", "status"], ["frame", "can", "0x71F", "mux", "4"]],
    run: (paths: string[][]) =>
      paths.map((path) => {
        const { handlers, s } = muxHandlers();
        handlers.handleAddMux(path);
        return { path: s.setCurrentMuxPath.mock.calls[0][0], nested: s.setIsAddingNestedMux.mock.calls[0][0], fields: s.setMuxFields.mock.calls[0][0] };
      }),
  },
  {
    name: "Editing a mux read from the model",
    input: { catalogue: SERVED.sbrxxx, keys: ["0x70F", "0x71F"] },
    run: (p) =>
      p.keys.map((key: string) => {
        const { handlers, s } = muxHandlers();
        handlers.handleEditMux(["frame", "can", key, "mux"], sbrxxxMux(key));
        return s.setMuxFields.mock.calls[0][0];
      }),
  },
  {
    name: "Saving a mux: an existing mux's path loses its trailing mux",
    input: [
      { path: ["frame", "can", "0x100", "mux"], existing: true, fields: { name: "Page", start_bit: 0, bit_length: 8 } },
      { path: ["frame", "can", "0x100"], existing: false, fields: { name: "", start_bit: 0, bit_length: 8 } },
      { path: ["frame", "can", "0x100", "mux", "4"], existing: false, fields: { name: "", start_bit: 8, bit_length: 4 } },
    ],
    run: async (calls: { path: string[]; existing: boolean; fields: MuxFields }[]) => {
      setEditor({});
      const out = [];
      for (const { path, existing, fields } of calls) {
        const { handlers } = muxHandlers(fields, path, existing);
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
    name: "A signal read back into the form from the model",
    input: { catalogue: SERVED.modbus, key: "5000" },
    run: (p) => fixtureJson<Catalog>(p.catalogue).frames.find((f) => f.key === p.key)!.signals.map(signalFieldsFor),
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
      const open = renderHookOnce(() => useSignalHandlers({ ...s, signalFields: NEW_SIGNAL_FIELDS, currentIdForSignal: null, currentSignalPath: [], editingSignalIndex: null }));
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
