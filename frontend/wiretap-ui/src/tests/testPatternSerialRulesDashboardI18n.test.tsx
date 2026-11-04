// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IOTestState } from "../api/testPattern";
import type { TestStatus } from "../generated/TestStatus";
import type { TestMode } from "../generated/TestMode";
import type { FlashPhase } from "../apps/serial/stores/flasherStore";
import type { TransformerDescriptor } from "../generated/TransformerDescriptor";
import type { DashboardPanel } from "../stores/dashboardStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../hooks/useIOSessionManager", () => ({
  useIOSessionManager: () => ({
    session: { sessionId: "f_1", state: "running", start: () => {} },
    effectiveSessionId: "f_1",
    sessionReady: true,
    isStreaming: true,
    isStopped: false,
    canReturnToLive: false,
    multiBusProfiles: [],
  }),
}));
vi.mock("../hooks/useIOSourcePickerHandlers", () => ({ useIOSourcePickerHandlers: () => ({}) }));
vi.mock("../hooks/useAllIOProfiles", () => ({ useAllIOProfiles: () => [] }));
vi.mock("../hooks/useTransmitCandidates", () => ({ useTransmitCandidates: () => ({ profiles: [], status: new Map() }) }));
vi.mock("../apps/test-pattern/views/TestPatternTopBar", () => ({ default: () => null }));
vi.mock("../dialogs/IoSourcePickerDialog", () => ({ default: () => null }));

const { default: i18n } = await import("../i18n");
const { FALLBACK_LANGUAGE, PSEUDO_LANGUAGE } = await import("../locales");
const { default: TestPattern, AutoSummary } = await import("../apps/test-pattern/TestPattern");
const { useTestPatternStore } = await import("../apps/test-pattern/stores/testPatternStore");
const { default: FlashView } = await import("../apps/serial/views/FlashView");
const { useFlasherStore } = await import("../apps/serial/stores/flasherStore");
const { useRulesStore } = await import("../apps/rules/stores/rulesStore");
const { default: TransformersView } = await import("../apps/rules/views/TransformersView");
const { default: SignalCombobox } = await import("../apps/rules/components/SignalCombobox");
const { default: SignalList } = await import("../apps/rules/components/SignalList");
const { default: BitGrid } = await import("../apps/rules/components/BitGrid");
const { default: HeatmapPanel } = await import("../apps/dashboard/views/panels/heatmap/HeatmapPanel");
const { default: BitfieldPanel } = await import("../apps/dashboard/views/panels/bitfield/BitfieldPanel");
const { default: StatsOverlay } = await import("../apps/dashboard/views/panels/StatsOverlay");
const { useDashboardStore } = await import("../stores/dashboardStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sweepState: IOTestState = {
  test_id: "tp_1",
  status: "failed",
  mode: "sweep",
  role: "initiator",
  tx_count: 2,
  rx_count: 1,
  drops: 1,
  duplicates: 0,
  out_of_order: 0,
  sequence_gaps: [],
  latency_us: null,
  elapsed_sec: 1,
  frames_per_sec: 2,
  errors: [],
  remote: null,
  peer: { fd: true, extended: false, bus: 0 },
  sweep: [
    { code: 8, expected_len: 8, received_len: 8, passed: true },
    { code: 9, expected_len: 12, received_len: null, passed: false },
  ],
  expected_tx: 2,
  auto_results: null,
  auto_phase: null,
};

const deviceTransformer: TransformerDescriptor = {
  transformer_id: 1,
  name: "Xform",
  description: null,
  source_frame_def_id: 2,
  source_frame_def_name: "Body",
  source_interface: 0,
  source_interface_name: "CAN0",
  dest_frame_def_id: 0xffff,
  dest_frame_def_name: "Device Signals",
  dest_interface: 0xff,
  dest_interface_name: "IF255",
  enabled: true,
  mappings: [],
};

const heatmap = { id: "h", type: "heatmap", title: "", signals: [], minValue: 0, maxValue: 0 } as DashboardPanel;

describe("Test Pattern, Serial, Rules and Dashboard labels", () => {
  let root: Root | undefined;

  const render = (element: ReactElement) => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(element));
    return document.body.textContent ?? "";
  };

  beforeEach(async () => {
    await i18n.changeLanguage(PSEUDO_LANGUAGE);
  });

  afterEach(async () => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    useTestPatternStore.setState({ testState: null, isRunning: false });
    useFlasherStore.setState({ activeDriverId: null });
    useRulesStore.getState().reset();
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  it("translates a sweep's status, peer, table and verdict", () => {
    useTestPatternStore.setState({ testState: sweepState, isRunning: false });
    const text = render(<TestPattern />);
    expect(text).toContain("⟦failed⟧");
    expect(text).toContain("⟦⟦⟦Sweep⟧ / ⟦Initiator⟧⟧ — 2 length codes⟧");
    expect(text).toContain("⟦Peer answered on bus 0 — CAN FD ⟦yes⟧, extended IDs ⟦no⟧.⟧");
    expect(text).toContain("⟦Expected⟧");
    expect(text).toContain("⟦NO ECHO⟧");
    expect(text).toContain("⟦1 of 2 length codes failed: ⟦code 9 (12 B) never echoed⟧.⟧");
  });

  it("translates the auto suite summary", () => {
    const text = render(
      <AutoSummary
        status="stopped"
        elapsed={3}
        results={[{ phase: "Echo", passed: true, tx_count: 5, rx_count: 5, drops: 0, frames_per_sec: 5, elapsed_sec: 1, latency_us: null, remote: null, sweep: null, errors: [] }]}
      />,
    );
    expect(text).toBe("⟦Full test suite stopped after 3s — ⟦STOPPED⟧.⟧ ⟦Echo: 5 fps, zero drops.⟧");
  });

  it("translates the flash view's modes, options and hint", () => {
    useFlasherStore.setState({ activeDriverId: "stm32-uart" });
    const text = render(<FlashView serialPort="/dev/ttyUSB0" dfuDevice={null} isTerminalOpen onBeforeFlash={async () => {}} />);
    for (const label of ["⟦Flash⟧", "⟦Backup⟧", "⟦Erase⟧", "⟦BOOT0 pin⟧", "⟦Active low⟧", "⟦Image⟧", "⟦Chip not detected — click Detect to try again⟧"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("⟦Pick an image and click Flash to begin. The terminal will be disconnected for the duration of the flash.⟧");
  });

  it("translates the flash view's empty state", () => {
    const text = render(<FlashView serialPort={null} dfuDevice={null} isTerminalOpen={false} onBeforeFlash={async () => {}} />);
    expect(text).toContain("⟦Pick a serial port or a DFU device from the top bar to begin.⟧");
  });

  it("names a transformer's device destination by id, not by Rust's label", () => {
    useRulesStore.setState({ transformers: [deviceTransformer] });
    const text = render(<TransformersView />);
    expect(text).toContain("⟦Device Signals⟧");
    expect(text).not.toContain("IF255");
  });

  it("translates the rules editor's signal pickers and grid", () => {
    const text = render(
      <>
        <SignalCombobox signals={[]} value={null} onChange={() => {}} />
        <SignalList signals={[]} selectedIndex={null} onSelect={() => {}} />
        <BitGrid payloadBytes={1} signals={[]} ownerMap={[]} selectionAnchor={null} selectedSignalIndex={null} onBitClick={() => {}} onByteClick={() => {}} scrollToByte={null} />
      </>,
    );
    expect(document.querySelector('[placeholder="⟦Select signal...⟧"]')).not.toBeNull();
    expect(text).toContain("⟦No signals defined. Click bits in the grid to add signals.⟧");
    expect(text).toContain("⟦Byte⟧");
  });

  it("translates a rules store failure", async () => {
    await useRulesStore.getState().addFrameDef({ frame_def_id: 1 });
    expect(useRulesStore.getState().error).toBe("⟦⟦Adding frame def 0x0001⟧ failed: Error: ⟦Not connected to device⟧⟧");
  });

  it("translates the dashboard panels' empty states, tooltips and legend", () => {
    useDashboardStore.getState().setBitToggles([{ frameId: 0x100, counts: Array(8).fill(0), frames: 1 }]);
    const text = render(
      <>
        <HeatmapPanel panel={heatmap} />
        <HeatmapPanel panel={{ ...heatmap, targetFrameId: 0x100 }} />
        <BitfieldPanel panel={{ ...heatmap, type: "bitfield" }} />
        <StatsOverlay signals={[]} stats={[]} />
      </>,
    );
    expect(text).toContain("⟦Select a frame ID in Configure Panel⟧");
    expect(text).toContain("⟦Byte 0, Bit 7 | 0 changes (0.0%)⟧ | ⟦1 frame⟧");
    expect(text).toContain("⟦Configure a target frame ID⟧");
    expect(text).toContain("⟦min / avg / max⟧");
  });

  it("has an English label for every test status, mode and flash phase", async () => {
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
    const missing = (key: string) => !i18n.exists(key);
    const statuses: TestStatus[] = ["running", "listening", "completed", "stopped", "failed"];
    const modes: TestMode[] = ["echo", "sweep", "throughput", "latency", "reliability", "loopback", "auto"];
    const phases: (FlashPhase | "reading")[] = ["idle", "connecting", "erasing", "writing", "reading", "verifying", "done", "error", "cancelled"];
    expect(statuses.map((s) => `testPattern:statuses.${s}`).filter(missing)).toEqual([]);
    expect(modes.map((m) => `testPattern:modes.${m}`).filter(missing)).toEqual([]);
    expect(phases.map((p) => `serial:flash.phases.${p}`).filter(missing)).toEqual([]);
  });
});
