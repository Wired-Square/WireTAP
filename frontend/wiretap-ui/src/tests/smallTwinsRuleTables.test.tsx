// P5's small twins: rule tables shared with the Rust tests (`io_test::tests`,
// `io::framelink::rules::tests`, `small_twin_tables`). Where the `ts` and `rust`
// columns of a row differ, the two languages disagree today.

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { AutoSummary, gaugeExpectedTx, nearestRound } from "../apps/test-pattern/TestPattern";
import { INTERFACE_TYPE_NAMES } from "../apps/rules/views/FrameDefEditor";
import { VALUE_TYPES, nextSignalId, signalBitPositions, type PlacedSignal } from "../apps/rules/utils/bitGrid";
import { nextAvailableId } from "../apps/rules/utils/framelinkConstants";
import { interpretPair, interpretRegister, type WordOrder } from "../utils/modbusValues";
import { CAN_FD_DLC_VALUES } from "../constants";
import type { AutoPhaseResult, TestMode } from "../api/testPattern";
import { fixtureJson } from "./catalogGoldens";

const table = <Row,>(file: string) => fixtureJson<{ rows: Row[] }>(`data/${file}`).rows;
const named = <Row,>(rows: Row[], name: (row: Row) => unknown) => rows.map((row) => [JSON.stringify(name(row)), row] as const);

describe("test pattern TX gauge scale", () => {
  type Row = { mode: TestMode; rate_hz: number; duration_sec: number; ts: { expected_tx: number; gauge_max: number | null } };
  it.each(named(table<Row>("testPatternGauge.json"), (r) => [r.mode, r.rate_hz, r.duration_sec]))("%s", (_, row) => {
    const expected = gaugeExpectedTx(row.mode, row.rate_hz, row.duration_sec);
    expect({ expected_tx: expected, gauge_max: expected > 0 ? nearestRound(expected) : null }).toEqual(row.ts);
  });
});

describe("test pattern suite verdict", () => {
  const { phases, rows } = fixtureJson<{
    phases: string[];
    rows: { name: string; phases_passed: boolean[]; rust: "completed" | "stopped" | "failed"; ts: string | null }[];
  }>("data/testPatternSuite.json");

  const phase = (name: string, passed: boolean): AutoPhaseResult => ({
    phase: name, passed, tx_count: 10, rx_count: passed ? 10 : 0, drops: passed ? 0 : 10, frames_per_sec: 10,
    elapsed_sec: 1, latency_us: null, remote: null, sweep: null, errors: [],
  });

  // AutoResults shows the summary only once the status is settled and a phase has reported.
  const summaryVerdict = (status: string, results: AutoPhaseResult[]) => {
    if (status === "running" || results.length === 0) return null;
    const text = renderToStaticMarkup(createElement(AutoSummary, { results, elapsed: 1 }));
    return text.includes("ALL PASS") ? "ALL PASS" : "FAILURES DETECTED";
  };

  it.each(rows.map((row) => [row.name, row] as const))("%s", (_, row) => {
    const results = row.phases_passed.map((passed, i) => phase(phases[i], passed));
    expect(summaryVerdict(row.rust, results)).toBe(row.ts);
  });
});

describe("FrameLink value types", () => {
  type Row = { value_type: number; ts: string | null };
  it.each(named(table<Row>("framelinkValueTypes.json"), (r) => r.value_type))("%s", (_, row) => {
    expect(VALUE_TYPES.find((t) => t.value === row.value_type)?.label ?? null).toBe(row.ts);
  });
});

describe("FrameLink bit positions", () => {
  type Row = { start_bit: number; bit_length: number; byte_order: number; positions: number[] };
  it.each(named(table<Row>("framelinkBitPositions.json"), (r) => [r.start_bit, r.bit_length, r.byte_order]))("%s", (_, row) => {
    expect(signalBitPositions(row.start_bit, row.bit_length, row.byte_order)).toEqual(row.positions);
  });
});

describe("FrameLink next id", () => {
  type Row = { used: number[]; ts: number };
  const placed = (signalId: number) => ({ signalId }) as PlacedSignal;
  it.each(named(table<Row>("framelinkNextId.json"), (r) => r.used))("%s", (_, row) => {
    expect(nextAvailableId(new Set(row.used))).toBe(row.ts);
    expect(nextSignalId(row.used.map(placed))).toBe(row.ts);
  });
});

describe("Modbus register words", () => {
  type Row = { name: string; first: number[]; second: number[]; word_order: WordOrder; ts: object };
  it.each(table<Row>("modbusWords.json").map((row) => [row.name, row] as const))("%s", (_, row) => {
    const { u16, s16 } = interpretRegister(row.first);
    const { f32, ...pair } = interpretPair(row.first, row.second, row.word_order);
    expect({ u16, s16, ...pair, f32: Number.isNaN(f32) ? null : f32 }).toEqual(row.ts);
  });
});

describe("CAN FD lengths offered", () => {
  type Row = { length: number; ts: boolean };
  it.each(named(table<Row>("canFdDlc.json"), (r) => r.length))("%s", (_, row) => {
    expect((CAN_FD_DLC_VALUES as readonly number[]).includes(row.length)).toBe(row.ts);
  });
});

describe("FrameLink interface type names", () => {
  type Row = { interface_type: number; ts: string | null };
  it.each(named(table<Row>("interfaceTypeNames.json"), (r) => r.interface_type))("%s", (_, row) => {
    expect(INTERFACE_TYPE_NAMES[row.interface_type] ?? null).toBe(row.ts);
  });
});
