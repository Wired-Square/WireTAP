// Catalogue drafting from analysis: the knowledge Frame Order and Payload Changes
// leave for an export (`decoderKnowledge.ts`), as the Discovery toolbox merges it,
// and the Candidate Signals dialog's `byte_*` names.

import { describe, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../stores/discoveryUIStore", () => ({
  useDiscoveryUIStore: { getState: () => ({ setFramesViewActiveTab: () => {} }) },
}));

import i18n from "../i18n";
import {
  addNotesToFrameKnowledge,
  buildMuxKnowledge,
  createDefaultSignalsForFrame,
  createEmptyKnowledge,
  determineDefaultInterval,
  initializeKnowledgeFromFrames,
  updateKnowledgeFromMessageOrder,
  updateKnowledgeFromPayloadAnalysis,
  type DecoderKnowledge,
} from "../utils/decoderKnowledge";
import { useDiscoveryToolboxStore } from "../stores/discoveryToolboxStore";
import { candidateSignals } from "../apps/dashboard/dialogs/CandidateSignalsDialog";
import type { FrameInfo } from "../stores/discoveryFrameStore";
import type { MultiBytePattern } from "../generated/MultiBytePattern";
import { changesResult, expectGolden, frameOrders, type GoldenCase } from "./catalogGoldens";

const NOW = 1_700_000_000_000;
const t = i18n.t.bind(i18n);

const pattern = (start: number, len: number, kind: MultiBytePattern["kind"], extra: Partial<MultiBytePattern> = {}): MultiBytePattern => ({
  start,
  len,
  kind,
  endianness: null,
  rollover: false,
  correlatedRollover: false,
  slowUpperBytes: false,
  range: null,
  sampleText: null,
  ...extra,
});

const oneByteMux = buildMuxKnowledge({ muxPeriodMs: 100, interMessageMs: 10, frameId: 0x300, isExtended: false, selector: "oneByte", occurrences: { 0: 5, 1: 5 } });
const twoByteMux = buildMuxKnowledge({ muxPeriodMs: null, interMessageMs: 2.5, frameId: 0x301, isExtended: false, selector: "twoByte", occurrences: { 1: 1, 257: 1 } });

const DEFAULT_SIGNALS: { name: string; input: Parameters<typeof createDefaultSignalsForFrame> }[] = [
  { name: "eight unclaimed bytes", input: [8] },
  { name: "no bytes", input: [0] },
  { name: "one-byte mux claims byte 0", input: [8, oneByteMux] },
  { name: "two-byte mux claims bytes 0 and 1", input: [8, twoByteMux] },
  { name: "an existing signal claims the bytes it touches", input: [8, undefined, [{ name: "s", startBit: 12, bitLength: 8, source: "user", confidence: "high" }]] },
  {
    name: "patterns first: named by kind, endianness only off the default, correlated rollover is high, an overlap is skipped",
    input: [
      8,
      undefined,
      [],
      [
        pattern(0, 2, "counter16", { endianness: "little" }),
        pattern(2, 2, "sensor16", { endianness: "big", correlatedRollover: true }),
        pattern(3, 4, "sensor32", { endianness: "big" }),
        pattern(4, 3, "text"),
      ],
      "little",
    ],
  },
  { name: "a big default keeps a big pattern's endianness off", input: [6, undefined, [], [pattern(0, 4, "sensor32", { endianness: "big" })], "big"] },
  {
    name: "serial header, source and checksum bytes claimed, negative positions from the end",
    input: [
      10,
      undefined,
      [],
      undefined,
      "little",
      { frame_id_start_byte: 0, frame_id_bytes: 2, source_address_start_byte: -3, source_address_bytes: 1, checksum: { start_byte: -2, byte_length: 2 } } as any,
    ],
  },
  {
    name: "a serial checksum past the end clamps at the frame",
    input: [4, undefined, [], undefined, "little", { checksum: { start_byte: 3, byte_length: 4 } } as any],
  },
];

function knowledgeFor(ids: number[]): DecoderKnowledge {
  return initializeKnowledgeFromFrames(new Map(ids.map((id) => [id, { len: 8, isExtended: id > 0x7ff, bus: 0 }])));
}

const frameInfo = (entries: [string, Partial<FrameInfo>][]) => new Map<string, FrameInfo>(entries.map(([k, v]) => [k, { len: 8, ...v } as FrameInfo]));

async function viaToolbox(steps: ("order" | "changes")[], info: Map<string, FrameInfo>) {
  useDiscoveryToolboxStore.getState().resetKnowledge();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "frame_order_cmd") return frameOrders;
    if (cmd === "payload_changes_cmd") return { frameCount: changesResult.frameCount, frames: changesResult.frames, skippedFrames: 0, mirrors: changesResult.mirrors };
  });
  const source = { captureId: "c1", selection: [] };
  for (const step of steps) {
    const store = useDiscoveryToolboxStore.getState();
    await (step === "order" ? store.runMessageOrderAnalysis(source, info) : store.runChangesAnalysis(source, info));
  }
  return useDiscoveryToolboxStore.getState().knowledge;
}

describe("drafting golden", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("matches drafting.json", async () => {
    const changesIds = changesResult.frames.map((f) => f.frameId);
    const orderIds = [0x100, 0x101, 0x200, 0x108, 0x301, 0x400, 0x401, 0x10, 0x103, 0x18ff0010];
    const sharedInfo = frameInfo([
      ...orderIds.map((id): [string, Partial<FrameInfo>] => [`can:${id}`, { isExtended: id > 0x7ff, bus: 0 }]),
      ...changesIds.map((id): [string, Partial<FrameInfo>] => [`can:${id}`, {}]),
      ["serial:16", { protocol: "serial", len: 12 }],
    ]);

    const cases: GoldenCase[] = [
      ...DEFAULT_SIGNALS.map(({ name, input }) => ({ name: `default signals: ${name}`, input, expected: createDefaultSignalsForFrame(...input) })),
      {
        name: "default interval from the group with the most frames, first on a tie",
        input: [[], [{ intervalMs: 10, toleranceMs: 3, keys: [{ frameId: 1, isExtended: false }] }, { intervalMs: 100, toleranceMs: 30, keys: [{ frameId: 2, isExtended: false }] }]],
        expected: [determineDefaultInterval([]), determineDefaultInterval([{ intervalMs: 10, toleranceMs: 3, keys: [{ frameId: 1, isExtended: false }] }, { intervalMs: 100, toleranceMs: 30, keys: [{ frameId: 2, isExtended: false }] }])],
      },
      { name: "mux knowledge from message order", input: "one-byte and two-byte selectors", expected: [oneByteMux, twoByteMux] },
      {
        name: "Frame Order folded onto bare ids: every protocol and bus, last writer wins",
        input: { knows: orderIds, orders: "frameOrder.input.json" },
        expected: updateKnowledgeFromMessageOrder(knowledgeFor(orderIds), frameOrders),
      },
      {
        name: "Payload Changes folded onto bare ids: notes worded, mux kept from Frame Order, patterns deduplicated by start",
        input: { knows: changesIds, changes: "analysis/byteNotes.json profiles, ids 0x100 up" },
        expected: (() => {
          const once = updateKnowledgeFromPayloadAnalysis(knowledgeFor(changesIds), changesResult.frames, t);
          return [once, updateKnowledgeFromPayloadAnalysis(once, changesResult.frames, t)];
        })(),
      },
      {
        name: "Payload Changes default endianness: set when 67% of frames agree, so two of three is not enough",
        input: [["little", "little", "big"], ["little", "big"], ["mixed", "big"]],
        expected: [["little", "little", "big"], ["little", "big"], ["mixed", "big"]].map((orders) =>
          updateKnowledgeFromPayloadAnalysis(
            { ...createEmptyKnowledge(), meta: { ...createEmptyKnowledge().meta, defaultEndianness: "big" } },
            orders.map((endianness, i) => ({ ...changesResult.frames[1], frameId: i, endianness: endianness as "little" })),
            t,
          ).meta,
        ),
      },
      {
        name: "notes added once each",
        input: { frameId: 0x100, notes: ["a", "b", "a"] },
        expected: addNotesToFrameKnowledge(addNotesToFrameKnowledge(knowledgeFor([0x100]), 0x100, ["a", "b", "a"]), 0x100, ["b", "c"]).frames.get(0x100)?.notes,
      },
      {
        name: "toolbox: Frame Order then Payload Changes, seeded from the discovered frames",
        input: { frameInfo: [...sharedInfo.keys()], steps: ["order", "changes"] },
        expected: await viaToolbox(["order", "changes"], sharedInfo),
      },
      {
        name: "toolbox: Payload Changes then Frame Order",
        input: { frameInfo: [...sharedInfo.keys()], steps: ["changes", "order"] },
        expected: await viaToolbox(["changes", "order"], sharedInfo),
      },
      {
        name: "toolbox: the info view's protocol is the majority, a tie is CAN",
        input: [
          [["serial:1", { protocol: "serial" }], ["serial:2", { protocol: "serial" }], ["can:1", { protocol: "can" }]],
          [["serial:1", { protocol: "serial" }], ["can:2", {}]],
        ],
        expected: (
          [
            [["serial:1", { protocol: "serial" }], ["serial:2", { protocol: "serial" }], ["can:1", { protocol: "can" }]],
            [["serial:1", { protocol: "serial" }], ["can:2", {}]],
          ] as [string, Partial<FrameInfo>][][]
        ).map((entries) => {
          useDiscoveryToolboxStore.getState().resetKnowledge();
          useDiscoveryToolboxStore.getState().openInfoView(frameInfo(entries));
          return useDiscoveryToolboxStore.getState().knowledge;
        }),
      },
      ...(
        [
          ["the dialog's defaults", { startByte: "0", endByte: "7", bitLengths: [8, 16], endianness: ["le"] }],
          ["both byte orders, every width, a window past the payload", { startByte: "5", endByte: "9", bitLengths: [32, 8, 16], endianness: ["be", "le"] }],
          ["a blank start and an unreadable end", { startByte: "", endByte: "x", bitLengths: [16], endianness: ["be"] }],
          ["hints skip static and counter bytes", { startByte: "0", endByte: "7", bitLengths: [8, 16], endianness: ["le"], hints: 1 }],
        ] as const
      ).map(([label, p]) => ({
        name: `candidate signals: ${label}`,
        input: p,
        expected: candidateSignals(i18n.getFixedT(null, "dashboard"), {
          startByte: p.startByte,
          endByte: p.endByte,
          bitLengths: new Set<number>(p.bitLengths),
          endianness: new Set(p.endianness),
          analysis: "hints" in p ? changesResult.frames[p.hints] : undefined,
        }),
      })),
    ];
    await expectGolden("drafting.json", cases);
  });
});
