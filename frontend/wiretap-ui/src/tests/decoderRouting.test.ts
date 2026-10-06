// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useDecoderStore,
  getDecodedFrames,
  getUnmatchedFrames,
  getFilteredFrames,
  getTunnelTransactions,
} from "../stores/decoderStore";
import type { DecodedFrameMsg, DecodedSignalsEntry, DecodedTunnelMessage, UnroutedFrameMsg } from "../services/wsProtocol";
import type { ParsedCatalog } from "../utils/catalogParser";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const decoded = (over: Partial<DecodedFrameMsg> = {}): DecodedFrameMsg => ({
  frameId: 0x1a5,
  maskedFrameId: 0x100,
  bus: 0,
  t: 2_000_000,
  signals: [{ name: "Level", value: 7, scaled: 7, display: "7", unit: null, format: null, muxValue: null, mirrorMismatch: true }],
  selectors: [],
  headerFields: [],
  bytes: [7, 0, 0, 0],
  sourceAddress: null,
  checksum: { extracted: 0x2a, calculated: 0x2a, valid: true },
  dlc: 4,
  isFd: false,
  isBrs: false,
  ...over,
});

const unrouted = (over: Partial<UnroutedFrameMsg> = {}): UnroutedFrameMsg => ({
  kind: "unmatched",
  frameId: 0x2a5,
  bus: 0,
  t: 3_000_000,
  bytes: [1, 2],
  dlc: 2,
  protocol: "can",
  isFd: false,
  isBrs: false,
  isRtr: false,
  ...over,
});

const tunnelMessage: DecodedTunnelMessage = {
  protocol: "modbus_rtu", direction: "response", directionBasis: "layout", device: 1, function: 4,
  functionLabel: "0x04", payload: "registers", values: [1], coils: [], data: [], raw: [1],
  frames: 2, crcValid: true, latencyUs: 4_000, register: null, quantity: null, exception: null,
  exceptionLabel: null, frame: null,
};

const apply = (entries: DecodedSignalsEntry[]) => useDecoderStore.getState().applyDecodedBatch(entries);

describe("decoderStore.applyDecodedBatch", () => {
  beforeEach(() => {
    useDecoderStore.getState().clearDecoded();
    useDecoderStore.getState().setFrameIdFilter("");
    useDecoderStore.getState().setMinFrameLength(0);
  });

  it("a decoded and an unmatched frame keep the received FD and BRS flags", () => {
    apply([decoded({ isFd: true, isBrs: true }), unrouted({ isFd: true, isBrs: true })]);

    expect(getDecodedFrames().peek(0x100)).toMatchObject({ isFd: true, isBrs: true });
    expect(getUnmatchedFrames()[0]).toMatchObject({ isFd: true, isBrs: true, isRtr: false });
  });

  it("an unmatched RTR keeps the length it asks for", () => {
    apply([unrouted({ isRtr: true, dlc: 6, bytes: [] })]);

    expect(getUnmatchedFrames()[0]).toMatchObject({ isRtr: true, dlc: 6, bytes: [] });
  });

  it("routes each kind to its tab", () => {
    apply([
      decoded(),
      unrouted(),
      unrouted({ kind: "short", frameId: 0x01, bus: 1, t: 4_000_000, bytes: [1], dlc: 1, protocol: "serial", sourceAddress: 9 }),
    ]);

    const frame = getDecodedFrames().peek(0x100);
    expect(frame?.rawBytes).toEqual([7, 0, 0, 0]);
    expect(frame?.checksum?.valid).toBe(true);
    expect(frame?.signals[0]).toMatchObject({ name: "Level", timestamp: 2, mirrorMismatch: true });
    expect(getUnmatchedFrames()).toEqual([
      { frameId: 0x2a5, bytes: [1, 2], dlc: 2, timestamp: 3, sourceAddress: undefined, protocol: "can", isFd: false, isBrs: false, isRtr: false },
    ]);
    expect(getFilteredFrames()).toEqual([
      { frameId: 0x01, bytes: [1], dlc: 1, timestamp: 4, sourceAddress: 9, protocol: "serial", isFd: false, isBrs: false, isRtr: false, reason: "too_short" },
    ]);
  });

  it("keys a decoded frame by its masked id and stamps signals from the stream clock", () => {
    apply([decoded({ t: 5_000_000 }), decoded({ frameId: 0x1b7, t: 9_000_000 })]);
    expect(getDecodedFrames().size).toBe(1);
    expect(getDecodedFrames().peek(0x100)?.signals[0].timestamp).toBe(9);
    expect(useDecoderStore.getState().streamStartTimeSeconds).toBe(5);
  });

  it("sends an id the Decoder's own filter names to Filtered, decoded or not", () => {
    useDecoderStore.getState().setFrameIdFilter("0x1A5");
    apply([decoded()]);
    expect(getDecodedFrames().size).toBe(0);
    expect(getFilteredFrames()).toMatchObject([{ frameId: 0x1a5, reason: "id_filter" }]);
  });

  it("sends an entry under the panel's own minimum length to Filtered, decoded or not", () => {
    useDecoderStore.getState().setMinFrameLength(3);
    apply([
      decoded({ bytes: [1, 2] }),
      unrouted({ bytes: [1], dlc: 1 }),
      decoded({ t: 4_000_000 }),
    ]);
    expect(getFilteredFrames()).toMatchObject([
      { frameId: 0x1a5, reason: "too_short" },
      { frameId: 0x2a5, reason: "too_short" },
    ]);
    expect(getUnmatchedFrames()).toEqual([]);
    expect(getDecodedFrames().peek(0x100)?.rawBytes).toEqual([7, 0, 0, 0]);
  });

  it("logs tunnel transactions with the latency Rust measured", () => {
    apply([
      decoded({ tunnel: [tunnelMessage] }),
    ]);
    expect(getTunnelTransactions()).toMatchObject([
      { frameId: 0x100, bus: 0, timestampUs: 2_000_000, latencyUs: 4_000 },
    ]);
  });

  it("replaces the Modbus rows with an attach's backlog rather than adding to them", () => {
    apply([decoded({ tunnel: [tunnelMessage] }), unrouted({ bytes: [1], dlc: 1 })]);
    const backlog = [decoded({ tunnel: [tunnelMessage] })];
    useDecoderStore.getState().applyDecodedBatch(backlog, true);
    useDecoderStore.getState().applyDecodedBatch(backlog, true);
    expect(getTunnelTransactions()).toHaveLength(1);
    expect(getUnmatchedFrames()).toHaveLength(1);

    useDecoderStore.getState().applyDecodedBatch([], true);
    expect(getTunnelTransactions()).toEqual([]);
  });

  it("leaves no Modbus rows behind a swap to a catalogue with no tunnel", () => {
    apply([decoded({ tunnel: [tunnelMessage] })]);
    useDecoderStore.getState().applyParsedCatalog(
      { frames: new Map(), protocol: "can", modbusConfig: null, serialConfig: null, pollGroups: [] } as unknown as ParsedCatalog,
      "plain.toml",
    );
    expect(getTunnelTransactions()).toEqual([]);
  });
});
