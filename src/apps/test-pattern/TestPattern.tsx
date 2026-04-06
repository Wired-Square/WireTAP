// src/apps/test-pattern/TestPattern.tsx
//
// Test Pattern panel — drives round-trip I/O tests through active sessions.
// Uses the shared AppTopBar + IOSessionControls. Either initiator or responder
// role, so two WireTAP instances can test against each other.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, Play, Square, Trash2 } from "lucide-react";
import {
  textPrimary,
  textSecondary,
  textDanger,
  bgSurface,
  borderDataView,
  monoBody,
  textDataGreen,
  textDataOrange,
  textDataSecondary,
} from "../../styles";
import {
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../styles/typography";
import { buttonBase } from "../../styles/buttonStyles";
import { iconSm } from "../../styles/spacing";
import { useTestPatternStore } from "./stores/testPatternStore";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useIOSourcePickerHandlers } from "../../hooks/useIOSourcePickerHandlers";
import { useDialogManager } from "../../hooks/useDialogManager";
import { useSettings } from "../../hooks/useSettings";
import { ioTestStart, ioTestStop } from "../../api/testPattern";
import type { TestConfig, IOTestState, AutoPhaseResult } from "../../api/testPattern";
import { wsTransport } from "../../services/wsTransport";
import { MsgType, HEADER_SIZE } from "../../services/wsProtocol";
import AppLayout from "../../components/AppLayout";
import TestPatternTopBar from "./views/TestPatternTopBar";
import IoSourcePickerDialog from "../../dialogs/IoSourcePickerDialog";

const sharedTextDecoder = new TextDecoder();

function generateTestId(): string {
  return `tp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Main component
// ============================================================================

export default function TestPattern() {
  const { settings } = useSettings();
  const ioProfiles = settings?.io_profiles ?? [];

  // All profiles that could potentially be used — including non-transmit ones
  // which will be shown greyed out with a reason.
  const testProfiles = useMemo(
    () =>
      ioProfiles.filter((p) => {
        const k = p.kind;
        return ["slcan", "gvret_tcp", "gvret_usb", "gs_usb", "socketcan",
                "serial", "virtual", "framelink"].includes(k);
      }),
    [ioProfiles],
  );

  // Map of profile ID → transmit status (greyed out with reason if can't transmit)
  const transmitStatusMap = useMemo(
    () => new Map(testProfiles.map((p) => {
      const k = p.kind;
      if (k === "slcan" && p.connection?.silent_mode) {
        return [p.id, { canTransmit: false, reason: "Silent mode — cannot transmit" }];
      }
      if (k === "gs_usb" && p.connection?.listen_only !== false) {
        return [p.id, { canTransmit: false, reason: "Listen-only mode — cannot transmit" }];
      }
      // Read-only sources
      if (!["slcan", "gvret_tcp", "gvret_usb", "gs_usb", "socketcan",
            "serial", "virtual", "framelink"].includes(k)) {
        return [p.id, { canTransmit: false, reason: "Not a transmit interface" }];
      }
      return [p.id, { canTransmit: true }];
    })),
    [testProfiles],
  );

  // Store state
  const mode = useTestPatternStore((s) => s.mode);
  const role = useTestPatternStore((s) => s.role);
  const durationSec = useTestPatternStore((s) => s.durationSec);
  const rateHz = useTestPatternStore((s) => s.rateHz);
  const bus = useTestPatternStore((s) => s.bus);
  const useFd = useTestPatternStore((s) => s.useFd);
  const useExtended = useTestPatternStore((s) => s.useExtended);
  const testId = useTestPatternStore((s) => s.testId);
  const isRunning = useTestPatternStore((s) => s.isRunning);
  const testState = useTestPatternStore((s) => s.testState);

  const setMode = useTestPatternStore((s) => s.setMode);
  const setRole = useTestPatternStore((s) => s.setRole);
  const setDurationSec = useTestPatternStore((s) => s.setDurationSec);
  const setRateHz = useTestPatternStore((s) => s.setRateHz);
  const setBus = useTestPatternStore((s) => s.setBus);
  const setUseFd = useTestPatternStore((s) => s.setUseFd);
  const setUseExtended = useTestPatternStore((s) => s.setUseExtended);
  const setTestId = useTestPatternStore((s) => s.setTestId);
  const setIsRunning = useTestPatternStore((s) => s.setIsRunning);
  const updateTestState = useTestPatternStore((s) => s.updateTestState);
  const clearTestState = useTestPatternStore((s) => s.clearTestState);

  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const dialogs = useDialogManager(["ioSessionPicker"] as const);

  // IO session manager
  const handleError = useCallback((err: string) => {
    console.error("[TestPattern] Session error:", err);
    setError(err);
  }, []);

  const manager = useIOSessionManager({
    appName: "test-pattern",
    ioProfiles: testProfiles,
    onError: handleError,
  });

  const {
    ioProfile,
    multiBusProfiles,
    effectiveSessionId,
    session,
    isStreaming,
    isStopped,
    canReturnToLive,
    sessionReady,
    handleLeave: managerLeave,
    watchFrameCount,
    watchUniqueFrameCount,
  } = manager;

  const isConnected = sessionReady && (isStreaming || isStopped || canReturnToLive);

  // IO picker dialog handlers
  const ioPickerProps = useIOSourcePickerHandlers({
    manager,
    closeDialog: () => dialogs.ioSessionPicker.close(),
  });

  // Subscribe to WS TestPatternState messages
  useEffect(() => {
    if (!wsTransport.isConnected) return;

    const unsub = wsTransport.onGlobalMessage(
      MsgType.TestPatternState,
      (_payload, raw) => {
        try {
          const jsonBytes = new Uint8Array(raw, HEADER_SIZE);
          const text = sharedTextDecoder.decode(jsonBytes);
          const state: IOTestState = JSON.parse(text);
          const currentTestId = useTestPatternStore.getState().testId;
          if (state.test_id === currentTestId) {
            updateTestState(state);
          }
        } catch {
          // Ignore malformed payloads
        }
      },
    );

    return unsub;
  }, [updateTestState]);

  const setExpectedTxCount = useTestPatternStore((s) => s.setExpectedTxCount);

  const handleStart = useCallback(async () => {
    if (!effectiveSessionId) return;
    setError(null);

    const id = generateTestId();
    const config: TestConfig = {
      mode,
      role,
      duration_sec: durationSec,
      rate_hz: rateHz,
      bus,
      use_fd: useFd,
      use_extended: useExtended,
    };

    // Pre-calculate expected TX for gauge scale
    // For throughput mode (unlimited rate), use 0 to signal auto-scale
    const expected = mode === "throughput" ? 0 : Math.ceil(rateHz * durationSec);
    setExpectedTxCount(expected);

    try {
      setTestId(id);
      setIsRunning(true);
      await ioTestStart(effectiveSessionId, id, config);
    } catch (e) {
      setError(String(e));
      setIsRunning(false);
      setTestId(null);
    }
  }, [effectiveSessionId, mode, role, durationSec, rateHz, bus, useFd, useExtended,
      setTestId, setIsRunning, setExpectedTxCount]);

  const handleStop = useCallback(async () => {
    if (!testId) return;
    try {
      await ioTestStop(testId);
    } catch (e) {
      setError(String(e));
    }
  }, [testId]);

  return (
    <AppLayout
      topBar={
        <TestPatternTopBar
          ioProfiles={testProfiles}
          ioProfile={ioProfile}
          defaultReadProfileId={settings?.default_read_profile}
          sessionId={session.sessionId}
          multiBusProfiles={session.sessionId ? multiBusProfiles : []}
          isStreaming={isStreaming}
          isPaused={false}
          isStopped={isStopped || canReturnToLive}
          ioState={session.state}
          frameCount={watchUniqueFrameCount}
          totalFrameCount={watchFrameCount}
          onOpenIoPicker={() => dialogs.ioSessionPicker.open()}
          onPause={() => session.stop()}
          onPlay={() => session.start()}
          onLeave={managerLeave}
          role={role}
          mode={mode}
          rateHz={rateHz}
          durationSec={durationSec}
          bus={bus}
          useFd={useFd}
          useExtended={useExtended}
          isRunning={isRunning}
          isConnected={isConnected}
          onRoleChange={setRole}
          onModeChange={setMode}
          onRateChange={setRateHz}
          onDurationChange={setDurationSec}
          onBusChange={setBus}
          onFdChange={setUseFd}
          onExtendedChange={setUseExtended}
          error={error}
        />
      }
    >
      {/* IO Source Picker Dialog */}
      <IoSourcePickerDialog
        {...ioPickerProps}
        isOpen={dialogs.ioSessionPicker.isOpen}
        onClose={() => dialogs.ioSessionPicker.close()}
        ioProfiles={testProfiles}
        selectedId={ioProfile ?? null}
        defaultId={settings?.default_read_profile}
        onSelect={() => {}}
        disabledProfiles={transmitStatusMap}
      />

      {/* Main content */}
      <div className={`flex-1 flex flex-col min-h-0 rounded-lg border ${borderDataView} overflow-hidden`}>
        {!isConnected ? (
          <div className={emptyStateContainer}>
            <FlaskConical size={48} className={textDataSecondary} />
            <div className={emptyStateText}>
              <p className={emptyStateHeading}>No Session Connected</p>
              <p className={emptyStateDescription}>
                Select a transmit-capable IO profile to start testing.
              </p>
            </div>
          </div>
        ) : (
          <div className={`flex flex-col h-full ${bgSurface} ${textPrimary} p-3 gap-3 overflow-y-auto`}>
            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <button
                className={`${buttonBase} gap-1.5`}
                onClick={isRunning ? handleStop : handleStart}
              >
                {isRunning ? (
                  <>
                    <Square className={`${iconSm} text-red-400`} />
                    <span>Stop</span>
                  </>
                ) : (
                  <>
                    <Play className={`${iconSm} text-emerald-400`} />
                    <span>Start</span>
                  </>
                )}
              </button>
              {testState && !isRunning && (
                <button
                  className={`${buttonBase} gap-1.5`}
                  onClick={() => { clearTestState(); setError(null); }}
                  title="Clear results"
                >
                  <Trash2 className={`${iconSm} text-[color:var(--text-muted)]`} />
                  <span>Clear</span>
                </button>
              )}
              {error && (
                <span className={`text-xs ${textDanger} truncate`}>{error}</span>
              )}
            </div>

            {/* Results */}
            {testState ? (
              <TestResults state={testState} />
            ) : (
              <div className={`flex-1 flex items-center justify-center ${textSecondary} text-sm`}>
                Choose a role and mode in the toolbar, then click Start.
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

// ============================================================================
// SVG Gauge (same arc maths as graph/GaugePanel)
// ============================================================================

const GAUGE_START = 225;
const GAUGE_END = 495;
const GAUGE_SWEEP = GAUGE_END - GAUGE_START;

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

function formatGaugeValue(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

function formatGaugeMax(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

/** Round up to a "nice" gauge maximum. */
function nearestRound(v: number): number {
  if (v <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function Gauge({
  value,
  max,
  label,
  unit,
  colour,
  warn,
}: {
  value: number;
  max: number;
  label: string;
  unit: string;
  colour: string;
  warn?: boolean;
}) {
  const cx = 100, cy = 95, r = 72, sw = 10;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const valueAngle = GAUGE_START + GAUGE_SWEEP * pct;
  const minPt = polarToCartesian(cx, cy, r + 14, GAUGE_START);
  const maxPt = polarToCartesian(cx, cy, r + 14, GAUGE_END);

  return (
    <div className="flex flex-col items-center min-w-0">
      <svg viewBox="0 0 200 160" className="w-full max-w-[200px]" overflow="visible">
        {/* Background arc */}
        <path
          d={describeArc(cx, cy, r, GAUGE_START, GAUGE_END)}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth={sw}
          strokeLinecap="round"
        />
        {/* Value arc */}
        {pct > 0.001 && (
          <path
            d={describeArc(cx, cy, r, GAUGE_START, valueAngle)}
            fill="none"
            stroke={colour}
            strokeWidth={sw}
            strokeLinecap="round"
          />
        )}
        {/* Value text */}
        <text
          x={cx} y={cy - 6}
          textAnchor="middle" dominantBaseline="middle"
          fill={warn ? "var(--status-danger-text)" : "var(--text-primary)"}
          fontSize="26" fontWeight="600" fontFamily="ui-monospace, monospace"
          stroke="var(--bg-primary)" strokeWidth={2} paintOrder="stroke"
        >
          {formatGaugeValue(value)}
        </text>
        {/* Unit */}
        <text
          x={cx} y={cy + 16}
          textAnchor="middle" dominantBaseline="middle"
          fill="var(--text-secondary)" fontSize="11"
        >
          {unit}
        </text>
        {/* Min / Max labels */}
        <text x={minPt.x} y={minPt.y} textAnchor="end" fill="var(--text-muted)" fontSize="9">
          0
        </text>
        <text x={maxPt.x} y={maxPt.y} textAnchor="start" fill="var(--text-muted)" fontSize="9">
          {formatGaugeMax(max)}
        </text>
      </svg>
      <span className={`text-xs -mt-2 ${textSecondary}`}>{label}</span>
    </div>
  );
}

// ============================================================================
// Results display
// ============================================================================

function TestResults({ state }: { state: IOTestState }) {
  // Auto mode has its own display
  if (state.mode === "auto") {
    return <AutoResults state={state} />;
  }

  const expectedTxCount = useTestPatternStore((s) => s.expectedTxCount);

  const isThroughput = state.mode === "throughput";
  // Detect loopback echo — if we received frames during throughput, the
  // interface echoes transmitted frames and we can show bus delivery metrics.
  const hasLoopback = isThroughput && state.rx_count > 0;
  const passed = state.status === "completed"
    && state.tx_count > 0
    && state.errors.length === 0
    && (isThroughput || (state.drops === 0 && state.duplicates === 0));
  const failed = state.status === "completed" && !passed;

  const statusColour = passed
    ? textDataGreen
    : failed || state.status === "failed"
      ? textDanger
      : state.status === "completed"
        ? textDataOrange
        : textPrimary;

  const fpsMax = Math.max(100, nearestRound(state.frames_per_sec * 1.2));
  // Use pre-calculated expected TX count for gauge scale (fixed at test start).
  // For throughput mode (expectedTxCount === 0), auto-scale from the live value.
  const txMax = expectedTxCount > 0
    ? nearestRound(expectedTxCount)
    : Math.max(100, nearestRound(state.tx_count * 1.2));
  const dropMax = Math.max(10, expectedTxCount > 0 ? expectedTxCount : (state.tx_count || 10));
  const latMax = state.latency_us
    ? Math.max(100, nearestRound(state.latency_us.p99_us * 1.2))
    : 1000;

  return (
    <div className="flex flex-col gap-3 flex-1">
      {/* Status bar */}
      <div className="flex items-center gap-3">
        <span className={`text-sm font-semibold uppercase ${statusColour}`}>
          {state.status}
        </span>
        <span className={`text-xs ${textSecondary}`}>
          {state.mode} / {state.role} — {state.elapsed_sec.toFixed(1)}s
        </span>
        {state.status === "completed" && (
          <span className={`text-xs font-semibold ${passed ? textDataGreen : textDanger}`}>
            {passed ? "PASS" : "FAIL"}
          </span>
        )}
      </div>

      {/* Gauge row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {isThroughput ? (
          <>
            {hasLoopback && (
              <Gauge
                value={state.elapsed_sec > 0 ? state.rx_count / state.elapsed_sec : 0}
                max={fpsMax}
                label="Bus Rate"
                unit="fps"
                colour="#22c55e"
              />
            )}
            <Gauge
              value={state.frames_per_sec}
              max={Math.max(fpsMax, nearestRound(state.frames_per_sec * 1.2))}
              label={hasLoopback ? "Queue Rate" : "Throughput"}
              unit="fps"
              colour={hasLoopback ? "#3b82f6" : "#22c55e"}
            />
            {hasLoopback && (
              <Gauge
                value={state.rx_count}
                max={txMax}
                label="Delivered"
                unit="frames"
                colour="#06b6d4"
              />
            )}
            <Gauge
              value={state.tx_count}
              max={txMax}
              label={hasLoopback ? "Queued" : "Transmitted"}
              unit="frames"
              colour={hasLoopback ? "#8b5cf6" : "#3b82f6"}
            />
          </>
        ) : (
          <>
            <Gauge
              value={state.frames_per_sec}
              max={fpsMax}
              label="Throughput"
              unit="fps"
              colour="#22c55e"
            />
            <Gauge
              value={state.tx_count}
              max={txMax}
              label="Transmitted"
              unit="frames"
              colour="#3b82f6"
            />
          </>
        )}
        {!isThroughput && (
          <>
            <Gauge
              value={state.drops}
              max={dropMax}
              label="Drops"
              unit="frames"
              colour={state.drops > 0 ? "#ef4444" : "#22c55e"}
              warn={state.drops > 0}
            />
            {state.latency_us ? (
              <Gauge
                value={state.latency_us.mean_us}
                max={latMax}
                label="Latency (mean)"
                unit="μs"
                colour="#a855f7"
              />
            ) : (
              <Gauge
                value={state.rx_count}
                max={txMax}
                label="Received"
                unit="frames"
                colour="#06b6d4"
              />
            )}
          </>
        )}
      </div>

      {/* Detail counters */}
      <div className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 ${monoBody}`}>
        <Stat label="TX" value={state.tx_count} />
        <Stat label="Rate" value={`${state.frames_per_sec.toFixed(0)} fps`} />
        {hasLoopback && (
          <>
            <Stat label="Delivered" value={state.rx_count} />
            <Stat label="Bus Rate" value={`${(state.elapsed_sec > 0 ? state.rx_count / state.elapsed_sec : 0).toFixed(0)} fps`} />
          </>
        )}
        {!isThroughput && (
          <>
            <Stat label="RX" value={state.rx_count} />
            <Stat label="Drops" value={state.drops} warn={state.drops > 0} />
            <Stat label="Duplicates" value={state.duplicates} warn={state.duplicates > 0} />
            <Stat label="Out-of-order" value={state.out_of_order} warn={state.out_of_order > 0} />
          </>
        )}
      </div>

      {/* Latency breakdown */}
      {!isThroughput && state.latency_us && (
        <div>
          <div className={`text-xs mb-1 ${textSecondary}`}>Latency (μs)</div>
          <div className={`grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1 ${monoBody}`}>
            <Stat label="min" value={state.latency_us.min_us} />
            <Stat label="max" value={state.latency_us.max_us} />
            <Stat label="mean" value={state.latency_us.mean_us} />
            <Stat label="p50" value={state.latency_us.p50_us} />
            <Stat label="p95" value={state.latency_us.p95_us} />
            <Stat label="p99" value={state.latency_us.p99_us} />
          </div>
        </div>
      )}

      {/* Sequence gaps */}
      {!isThroughput && state.sequence_gaps.length > 0 && (
        <div>
          <div className={`text-xs mb-1 ${textSecondary}`}>
            Sequence gaps ({state.sequence_gaps.length})
          </div>
          <div className={`text-xs ${monoBody} max-h-24 overflow-y-auto`}>
            {state.sequence_gaps.slice(0, 20).map(([expected, got], i) => (
              <div key={i}>expected {expected}, got {got}</div>
            ))}
            {state.sequence_gaps.length > 20 && (
              <div className={textSecondary}>... and {state.sequence_gaps.length - 20} more</div>
            )}
          </div>
        </div>
      )}

      {/* Remote endpoint stats */}
      {state.remote && (
        <div>
          <div className={`text-xs mb-1 ${textSecondary}`}>Remote Endpoint</div>
          <div className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 ${monoBody}`}>
            <Stat label="RX" value={state.remote.rx_count} />
            <Stat label="TX" value={state.remote.tx_count} />
            <Stat label="Rate" value={`${state.remote.fps} fps`} />
            {state.remote.drops > 0 && (
              <Stat label="Drops" value={state.remote.drops} warn />
            )}
          </div>
        </div>
      )}

      {/* Errors */}
      {state.errors.length > 0 && (
        <div>
          <div className={`text-xs mb-1 ${textDanger}`}>
            Errors ({state.errors.length})
          </div>
          <div className={`text-xs ${monoBody} max-h-24 overflow-y-auto`}>
            {state.errors.slice(0, 10).map((err, i) => (
              <div key={i}>{err}</div>
            ))}
          </div>
        </div>
      )}

      {/* Plain English summary */}
      {state.status !== "running" && (
        <div className={`text-sm ${textSecondary} border-t border-[color:var(--border-default)] pt-2 mt-1`}>
          <TestSummary state={state} passed={passed} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Auto mode results
// ============================================================================

function AutoResults({ state }: { state: IOTestState }) {
  const results = state.auto_results ?? [];
  const allPassed = results.length > 0 && results.every((r) => r.passed);
  const isRunning = state.status === "running";

  const statusColour = isRunning
    ? textPrimary
    : allPassed
      ? textDataGreen
      : textDanger;

  return (
    <div className="flex flex-col gap-3 flex-1">
      {/* Status */}
      <div className="flex items-center gap-3">
        <span className={`text-sm font-semibold uppercase ${statusColour}`}>
          {state.status}
        </span>
        {state.auto_phase && (
          <span className={`text-xs ${textSecondary}`}>
            {state.auto_phase}
          </span>
        )}
        {!isRunning && (
          <span className={`text-xs font-semibold ${allPassed ? textDataGreen : textDanger}`}>
            {allPassed ? "ALL PASS" : "FAIL"}
          </span>
        )}
        <span className={`text-xs ${textSecondary}`}>
          {state.elapsed_sec.toFixed(1)}s
        </span>
      </div>

      {/* Phase results table */}
      {results.length > 0 && (
        <div className="border border-[color:var(--border-default)] rounded overflow-hidden">
          <table className={`w-full text-xs ${monoBody}`}>
            <thead>
              <tr className="bg-[var(--bg-primary)]">
                <th className="text-left px-3 py-1.5 font-medium">Phase</th>
                <th className="text-left px-3 py-1.5 font-medium">Result</th>
                <th className="text-right px-3 py-1.5 font-medium">TX</th>
                <th className="text-right px-3 py-1.5 font-medium">RX</th>
                <th className="text-right px-3 py-1.5 font-medium">Drops</th>
                <th className="text-right px-3 py-1.5 font-medium">Rate</th>
                <th className="text-right px-3 py-1.5 font-medium">Latency</th>
                <th className="text-right px-3 py-1.5 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="border-t border-[color:var(--border-default)]">
                  <td className="px-3 py-1.5">{r.phase}</td>
                  <td className={`px-3 py-1.5 font-semibold ${r.passed ? textDataGreen : textDanger}`}>
                    {r.passed ? "PASS" : "FAIL"}
                  </td>
                  <td className="text-right px-3 py-1.5">{r.tx_count.toLocaleString()}</td>
                  <td className="text-right px-3 py-1.5">{r.rx_count.toLocaleString()}</td>
                  <td className={`text-right px-3 py-1.5 ${r.drops > 0 ? textDanger : ""}`}>
                    {r.phase === "Throughput" ? "—" : r.drops.toLocaleString()}
                  </td>
                  <td className="text-right px-3 py-1.5">{r.frames_per_sec.toFixed(0)} fps</td>
                  <td className="text-right px-3 py-1.5">
                    {r.latency_us ? `${r.latency_us.mean_us.toLocaleString()} μs` : "—"}
                  </td>
                  <td className="text-right px-3 py-1.5">{r.elapsed_sec.toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Remote stats from last phase that has them */}
      {(() => {
        const remotePhase = [...results].reverse().find((r) => r.remote);
        if (!remotePhase?.remote) return null;
        return (
          <div>
            <div className={`text-xs mb-1 ${textSecondary}`}>
              Remote Endpoint (from {remotePhase.phase})
            </div>
            <div className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 ${monoBody}`}>
              <Stat label="RX" value={remotePhase.remote.rx_count} />
              <Stat label="TX" value={remotePhase.remote.tx_count} />
              <Stat label="Rate" value={`${remotePhase.remote.fps} fps`} />
            </div>
          </div>
        );
      })()}

      {/* Plain English summary */}
      {!isRunning && results.length > 0 && (
        <div className={`text-sm ${textSecondary} border-t border-[color:var(--border-default)] pt-2 mt-1`}>
          <AutoSummary results={results} elapsed={state.elapsed_sec} />
        </div>
      )}
    </div>
  );
}

function AutoSummary({ results, elapsed }: { results: AutoPhaseResult[]; elapsed: number }) {
  const allPassed = results.every((r) => r.passed);
  const echoResult = results.find((r) => r.phase === "Echo");
  const latResult = results.find((r) => r.phase === "Latency");
  const tpResult = results.find((r) => r.phase === "Throughput");
  const relResult = results.find((r) => r.phase === "Reliability");

  const parts: string[] = [];

  parts.push(`Full test suite completed in ${elapsed.toFixed(0)}s — ${allPassed ? "ALL PASS" : "FAILURES DETECTED"}.`);

  if (echoResult) {
    parts.push(echoResult.passed
      ? `Echo: ${echoResult.frames_per_sec.toFixed(0)} fps, zero drops.`
      : `Echo: FAILED (${echoResult.drops} drops, ${echoResult.errors.length} errors).`);
  }

  if (latResult?.latency_us) {
    parts.push(`Latency: ${latResult.latency_us.mean_us.toLocaleString()} μs mean, ${latResult.latency_us.p95_us.toLocaleString()} μs p95.`);
  }

  if (tpResult) {
    const remote = tpResult.remote;
    if (remote && remote.rx_count > 0) {
      parts.push(`Throughput: ${tpResult.frames_per_sec.toFixed(0)} fps queue rate, ${remote.fps} fps bus rate.`);
    } else {
      parts.push(`Throughput: ${tpResult.frames_per_sec.toFixed(0)} fps.`);
    }
  }

  if (relResult) {
    parts.push(relResult.passed
      ? `Reliability: ${relResult.tx_count.toLocaleString()} frames over ${relResult.elapsed_sec.toFixed(0)}s, zero drops.`
      : `Reliability: FAILED — ${relResult.drops} drops in ${relResult.elapsed_sec.toFixed(0)}s.`);
  }

  return <p>{parts.join(" ")}</p>;
}

function TestSummary({ state, passed }: { state: IOTestState; passed: boolean }) {
  const mode = state.mode;
  const dur = state.elapsed_sec.toFixed(1);
  const fps = state.frames_per_sec.toFixed(0);

  if (state.status === "failed" && state.errors.length > 0 && state.tx_count === 0) {
    return <p>Test failed — could not transmit any frames. Check that the session supports transmit and is connected.</p>;
  }

  if (mode === "throughput") {
    const remote = state.remote;
    if (remote && remote.rx_count > 0) {
      const busRate = (remote.rx_count / state.elapsed_sec).toFixed(0);
      return (
        <p>
          Transmitted {state.tx_count.toLocaleString()} frames in {dur}s at {fps} fps (queue rate).
          The remote endpoint received {remote.rx_count.toLocaleString()} frames at {busRate} fps (bus rate).
          {remote.rx_count < state.tx_count
            ? ` ${(state.tx_count - remote.rx_count).toLocaleString()} frames were lost due to buffer overflow between the software queue and the bus.`
            : ""}
        </p>
      );
    }
    return <p>Transmitted {state.tx_count.toLocaleString()} frames in {dur}s at {fps} fps.</p>;
  }

  if (mode === "latency") {
    const lat = state.latency_us;
    if (passed && lat) {
      return (
        <p>
          Sent {state.tx_count.toLocaleString()} latency probes in {dur}s.
          All {state.rx_count.toLocaleString()} replies received with zero drops.
          Round-trip: {lat.mean_us.toLocaleString()} μs mean, {lat.p95_us.toLocaleString()} μs p95.
          {state.remote ? ` Remote received ${state.remote.rx_count.toLocaleString()} probes at ${state.remote.fps} fps.` : ""}
        </p>
      );
    }
    return (
      <p>
        Sent {state.tx_count.toLocaleString()} latency probes in {dur}s.
        {state.drops > 0 ? ` ${state.drops.toLocaleString()} probes were lost (${(state.drops / state.tx_count * 100).toFixed(1)}% loss).` : ""}
        {lat ? ` Round-trip: ${lat.mean_us.toLocaleString()} μs mean, ${lat.p99_us.toLocaleString()} μs p99.` : ""}
      </p>
    );
  }

  // Echo / reliability
  if (passed) {
    return (
      <p>
        Sent {state.tx_count.toLocaleString()} pings in {dur}s at {fps} fps.
        All {state.rx_count.toLocaleString()} responses received with zero drops.
        {state.remote ? ` Remote endpoint received ${state.remote.rx_count.toLocaleString()} frames at ${state.remote.fps} fps.` : ""}
      </p>
    );
  }

  return (
    <p>
      Sent {state.tx_count.toLocaleString()} frames in {dur}s.
      Received {state.rx_count.toLocaleString()} responses.
      {state.drops > 0 ? ` ${state.drops.toLocaleString()} dropped.` : ""}
      {state.duplicates > 0 ? ` ${state.duplicates} duplicates.` : ""}
      {state.errors.length > 0 ? ` ${state.errors.length} errors.` : ""}
    </p>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number | string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-xs ${textSecondary}`}>{label}</span>
      <span className={warn ? textDanger : ""}>{value}</span>
    </div>
  );
}
