// src/apps/test-pattern/TestPattern.tsx
//
// Test Pattern panel — drives round-trip I/O tests through active sessions.
// Uses the shared AppTopBar + IOSessionControls. Either initiator or responder
// role, so two WireTAP instances can test against each other.

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Play, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  textPrimary,
  textSecondary,
  textDanger,
  bgSurface,
  borderDefault,
  monoBody,
  textDataGreen,
  textDataOrange,
} from "../../styles";
import { Table } from "../../components/Table";
import {
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../styles/typography";
import { iconSm } from "../../styles/spacing";
import { useTestPatternStore } from "./stores/testPatternStore";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useIOSourcePickerHandlers } from "../../hooks/useIOSourcePickerHandlers";
import { useDialogManager } from "../../hooks/useDialogManager";
import { useSettings } from "../../hooks/useSettings";
import { useAllIOProfiles } from "../../hooks/useAllIOProfiles";
import { useTransmitCandidates } from "../../hooks/useTransmitCandidates";
import { ioTestStart, ioTestStop } from "../../api/testPattern";
import type {
  TestConfig,
  IOTestState,
  AutoPhaseResult,
  PeerInfo,
  SweepRow,
  TestStatus,
} from "../../api/testPattern";
import { wsTransport } from "../../services/wsTransport";
import { MsgType, HEADER_SIZE } from "../../services/wsProtocol";
import AppLayout from "../../components/AppLayout";
import TestPatternTopBar from "./views/TestPatternTopBar";
import IoSourcePickerDialog from "../../dialogs/IoSourcePickerDialog";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";

const sharedTextDecoder = new TextDecoder();

function generateTestId(): string {
  return `tp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Main component
// ============================================================================

export default function TestPattern() {
  const { t } = useTranslation("testPattern");
  const { settings } = useSettings();
  const ioProfiles = useAllIOProfiles();

  const { profiles: testProfiles, status: transmitStatusMap } = useTransmitCandidates(ioProfiles);

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
    handleDestroy: managerDestroy,
    stopWatch,
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
      setTestId, setIsRunning]);

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
          onPlay={() => session.start()}
          onLeave={managerLeave}
          onStop={isStreaming ? stopWatch : undefined}
          onDestroy={managerDestroy}
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
      <div className={`flex-1 flex flex-col min-h-0 rounded-lg border ${borderDefault} overflow-hidden`}>
        {!isConnected ? (
          <div className={emptyStateContainer}>
            <FlaskConical size={48} className={textSecondary} />
            <div className={emptyStateText}>
              <p className={emptyStateHeading}>{t("states.noSession")}</p>
              <p className={emptyStateDescription}>{t("states.noSessionHelp")}</p>
            </div>
          </div>
        ) : (
          <div className={`flex flex-col h-full ${bgSurface} ${textPrimary} p-3 gap-3 overflow-y-auto`}>
            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <Button
                onClick={isRunning ? handleStop : handleStart}
              >
                {isRunning ? (
                  <>
                    <Square className={`${iconSm} ${textDanger}`} />
                    <span>{t("actions.stop")}</span>
                  </>
                ) : (
                  <>
                    <Play className={`${iconSm} text-success`} />
                    <span>{t("actions.start")}</span>
                  </>
                )}
              </Button>
              {testState && !isRunning && (
                <Button
                  onClick={() => { clearTestState(); setError(null); }}
                  title={t("actions.clearResults")}
                >
                  <Trash2 className={`${iconSm} text-muted`} />
                  <span>{t("actions.clear")}</span>
                </Button>
              )}
              {error && (
                <span className={`text-xs ${textDanger} truncate`}>{error}</span>
              )}
            </div>

            {/* Results — Auto and Sweep have their own displays */}
            {testState ? (
              testState.mode === "auto" ? (
                <AutoResults state={testState} />
              ) : testState.mode === "sweep" ? (
                <SweepResults state={testState} />
              ) : (
                <TestResults state={testState} />
              )
            ) : (
              <div className={`flex-1 flex items-center justify-center ${textSecondary} text-sm`}>
                {t("states.selectMode")}
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

// ============================================================================
// SVG Gauge (same arc maths as dashboard/GaugePanel)
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

/** The run's own expected count, so a full run fills the gauge; an unpaced run auto-scales. */
export function txGaugeMax(state: Pick<IOTestState, "expected_tx" | "tx_count">): number {
  return state.expected_tx ?? Math.max(100, nearestRound(state.tx_count * 1.2));
}

/** Round up to a "nice" gauge maximum. */
export function nearestRound(v: number): number {
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
      <svg viewBox="0 0 200 160" className="w-full max-w-50" overflow="visible">
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

/**
 * What a status says about the run. `settled` means the backend will not move
 * off it; `hasVerdict` means it reached a pass or a fail — a run stopped by
 * hand is settled without either.
 */
function verdict(status: TestStatus) {
  const passed = status === "completed";
  const failed = status === "failed";
  return { passed, hasVerdict: passed || failed, settled: passed || failed || status === "stopped" };
}

/**
 * The status bar every result view shares. The backend derives the status from
 * its own pass predicate, so PASS/FAIL is read off it rather than recomputed
 * here — the two could disagree.
 */
function StatusBar({
  status,
  detail,
  elapsedSec,
  passLabel,
}: {
  status: TestStatus;
  detail: string;
  elapsedSec: number;
  passLabel?: string;
}) {
  const { t } = useTranslation("testPattern");
  const { passed, hasVerdict } = verdict(status);
  const colour = passed ? textDataGreen : status === "failed" ? textDanger : textPrimary;
  return (
    <div className="flex items-center gap-3">
      <span className={`text-sm font-semibold uppercase ${colour}`}>{t(`statuses.${status}`)}</span>
      <span className={`text-xs ${textSecondary}`}>
        {detail} — {elapsedSec.toFixed(1)}s
      </span>
      {hasVerdict && (
        <span className={`text-xs font-semibold ${passed ? textDataGreen : textDanger}`}>
          {passed ? passLabel ?? t("results.pass") : t("results.fail")}
        </span>
      )}
    </div>
  );
}

function useRunDetail(state: IOTestState) {
  const { t } = useTranslation("testPattern");
  return t("results.runDetail", { mode: t(`modes.${state.mode}`), role: t(`roles.${state.role}`) });
}

/** What the Hello handshake found, before any traffic went out. */
function PeerSummary({ peer }: { peer: PeerInfo | null }) {
  const { t } = useTranslation("testPattern");
  if (!peer) {
    return <div className={`text-xs ${textDataOrange}`}>{t("peer.none")}</div>;
  }
  const yesNo = (flag: boolean) => t(flag ? "peer.yes" : "peer.no");
  return (
    <div className={`text-xs ${textSecondary}`}>
      {t("peer.answered", { bus: peer.bus, fd: yesNo(peer.fd), extended: yesNo(peer.extended) })}
    </div>
  );
}

/**
 * Per-length-code results. A failure names the byte count that broke, which is
 * the whole reason the sweep exists: every other message is 8 bytes, and 8 is
 * where a payload length and a data length code are the same number.
 */
function SweepTable({ rows }: { rows: SweepRow[] }) {
  const { t } = useTranslation("testPattern");
  return (
    <Card padding="none" className="overflow-x-auto">
      <Table mono>
        <thead>
          <tr>
            <th>{t("sweep.columns.code")}</th>
            <th className="text-right">{t("sweep.columns.expected")}</th>
            <th className="text-right">{t("sweep.columns.received")}</th>
            <th>{t("auto.phaseColumns.result")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td>{r.code}</td>
              <td className="text-right">{r.expected_len} B</td>
              <td className={`text-right ${r.passed ? "" : textDanger}`}>
                {r.received_len === null ? "—" : `${r.received_len} B`}
              </td>
              <td className={`font-semibold ${r.passed ? textDataGreen : textDanger}`}>
                {t(r.passed ? "results.pass" : r.received_len === null ? "sweep.noEcho" : "sweep.mismatch")}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function SweepResults({ state }: { state: IOTestState }) {
  const { t } = useTranslation("testPattern");
  const run = useRunDetail(state);
  const rows = state.sweep ?? [];
  const failures = rows.filter((r) => !r.passed);
  return (
    <div className="flex flex-col gap-3 flex-1">
      <StatusBar
        status={state.status}
        detail={t("sweep.detail", { run, count: rows.length })}
        elapsedSec={state.elapsed_sec}
      />
      <PeerSummary peer={state.peer} />
      {rows.length > 0 && <SweepTable rows={rows} />}
      {verdict(state.status).settled && (
        <div className={`text-sm ${textSecondary} border-t border-default pt-2 mt-1`}>
          <p>
            {failures.length === 0 && rows.length > 0
              ? t(rows.length > 9 ? "sweep.allPassedFd" : "sweep.allPassedClassic")
              : t("sweep.failed", {
                  failed: failures.length,
                  count: rows.length,
                  list: failures
                    .map((f) =>
                      f.received_len === null
                        ? t("sweep.neverEchoed", { code: f.code, length: f.expected_len })
                        : t("sweep.wrongLength", { code: f.code, expected: f.expected_len, received: f.received_len }),
                    )
                    .join("; "),
                })}
          </p>
        </div>
      )}
    </div>
  );
}

function TestResults({ state }: { state: IOTestState }) {
  const { t } = useTranslation("testPattern");
  const run = useRunDetail(state);
  const isThroughput = state.mode === "throughput";
  // Detect loopback echo — if we received frames during throughput, the
  // interface echoes transmitted frames and we can show bus delivery metrics.
  const hasLoopback = isThroughput && state.rx_count > 0;
  const passed = state.status === "completed";
  const frames = t("results.gauges.unitFrames");

  const fpsMax = Math.max(100, nearestRound(state.frames_per_sec * 1.2));
  const txMax = txGaugeMax(state);
  const dropMax = Math.max(10, state.expected_tx ?? state.tx_count);
  const latMax = state.latency_us
    ? Math.max(100, nearestRound(state.latency_us.p99_us * 1.2))
    : 1000;

  return (
    <div className="flex flex-col gap-3 flex-1">
      <StatusBar
        status={state.status}
        detail={run}
        elapsedSec={state.elapsed_sec}
      />
      {state.role === "initiator" && state.mode !== "loopback" && (
        <PeerSummary peer={state.peer} />
      )}

      {/* Gauge row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {isThroughput ? (
          <>
            {hasLoopback && (
              <Gauge
                value={state.elapsed_sec > 0 ? state.rx_count / state.elapsed_sec : 0}
                max={fpsMax}
                label={t("results.gauges.busRate")}
                unit="fps"
                colour="#22c55e"
              />
            )}
            <Gauge
              value={state.frames_per_sec}
              max={Math.max(fpsMax, nearestRound(state.frames_per_sec * 1.2))}
              label={t(hasLoopback ? "results.gauges.queueRate" : "results.gauges.throughput")}
              unit="fps"
              colour={hasLoopback ? "#3b82f6" : "#22c55e"}
            />
            {hasLoopback && (
              <Gauge
                value={state.rx_count}
                max={txMax}
                label={t("results.gauges.delivered")}
                unit={frames}
                colour="#06b6d4"
              />
            )}
            <Gauge
              value={state.tx_count}
              max={txMax}
              label={t(hasLoopback ? "results.gauges.queued" : "results.gauges.transmitted")}
              unit={frames}
              colour={hasLoopback ? "#8b5cf6" : "#3b82f6"}
            />
          </>
        ) : (
          <>
            <Gauge
              value={state.frames_per_sec}
              max={fpsMax}
              label={t("results.gauges.throughput")}
              unit="fps"
              colour="#22c55e"
            />
            <Gauge
              value={state.tx_count}
              max={txMax}
              label={t("results.gauges.transmitted")}
              unit={frames}
              colour="#3b82f6"
            />
          </>
        )}
        {!isThroughput && (
          <>
            <Gauge
              value={state.drops}
              max={dropMax}
              label={t("results.gauges.drops")}
              unit={frames}
              colour={state.drops > 0 ? "#ef4444" : "#22c55e"}
              warn={state.drops > 0}
            />
            {state.latency_us ? (
              <Gauge
                value={state.latency_us.mean_us}
                max={latMax}
                label={t("results.gauges.latencyMean")}
                unit="μs"
                colour="#a855f7"
              />
            ) : (
              <Gauge
                value={state.rx_count}
                max={txMax}
                label={t("results.gauges.received")}
                unit={frames}
                colour="#06b6d4"
              />
            )}
          </>
        )}
      </div>

      {/* Detail counters */}
      <div className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 ${monoBody}`}>
        <Stat label={t("results.stats.tx")} value={state.tx_count} />
        <Stat label={t("results.stats.rate")} value={`${state.frames_per_sec.toFixed(0)} fps`} />
        {hasLoopback && (
          <>
            <Stat label={t("results.stats.delivered")} value={state.rx_count} />
            <Stat label={t("results.stats.busRate")} value={`${(state.elapsed_sec > 0 ? state.rx_count / state.elapsed_sec : 0).toFixed(0)} fps`} />
          </>
        )}
        {!isThroughput && (
          <>
            <Stat label={t("results.stats.rx")} value={state.rx_count} />
            <Stat label={t("results.stats.drops")} value={state.drops} warn={state.drops > 0} />
            <Stat label={t("results.stats.duplicates")} value={state.duplicates} warn={state.duplicates > 0} />
            <Stat label={t("results.stats.outOfOrder")} value={state.out_of_order} warn={state.out_of_order > 0} />
          </>
        )}
      </div>

      {/* Latency breakdown */}
      {!isThroughput && state.latency_us && (
        <div>
          <div className={`text-xs mb-1 ${textSecondary}`}>{t("results.latencyTitle")}</div>
          <div className={`grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1 ${monoBody}`}>
            <Stat label={t("results.latencyMin")} value={state.latency_us.min_us} />
            <Stat label={t("results.latencyMax")} value={state.latency_us.max_us} />
            <Stat label={t("results.latencyMean")} value={state.latency_us.mean_us} />
            <Stat label={t("results.latencyP50")} value={state.latency_us.p50_us} />
            <Stat label={t("results.latencyP95")} value={state.latency_us.p95_us} />
            <Stat label={t("results.latencyP99")} value={state.latency_us.p99_us} />
          </div>
        </div>
      )}

      {/* Sequence gaps */}
      {!isThroughput && state.sequence_gaps.length > 0 && (
        <div>
          {/* The backend sends the first hundred, not all of them — a run
              losing frames fast enough accumulates more than anyone can read.
              Drops is the authoritative count. */}
          <div className={`text-xs mb-1 ${textSecondary}`}>
            {t("results.sequenceGapsTitle", { shown: Math.min(state.sequence_gaps.length, 20), count: state.drops })}
          </div>
          <div className={`text-xs ${monoBody} max-h-24 overflow-y-auto`}>
            {state.sequence_gaps.slice(0, 20).map(([expected, got], i) => (
              <div key={i}>{t("results.expectedGotFmt", { expected, got })}</div>
            ))}
          </div>
        </div>
      )}

      {/* Remote endpoint stats */}
      {state.remote && (
        <div>
          <div className={`text-xs mb-1 ${textSecondary}`}>{t("results.remoteEndpointTitle")}</div>
          <div className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 ${monoBody}`}>
            <Stat label={t("results.stats.rx")} value={state.remote.rx_count} />
            <Stat label={t("results.stats.tx")} value={state.remote.tx_count} />
            <Stat label={t("results.stats.rate")} value={`${state.remote.fps} fps`} />
            {state.remote.drops > 0 && (
              <Stat label={t("results.stats.drops")} value={state.remote.drops} warn />
            )}
          </div>
        </div>
      )}

      {/* Errors */}
      {state.errors.length > 0 && (
        <div>
          <div className={`text-xs mb-1 ${textDanger}`}>
            {t("results.errorsTitle", { count: state.errors.length })}
          </div>
          <div className={`text-xs ${monoBody} max-h-24 overflow-y-auto`}>
            {state.errors.slice(0, 10).map((err, i) => (
              <div key={i}>{err}</div>
            ))}
          </div>
        </div>
      )}

      {/* Plain English summary */}
      {verdict(state.status).settled && (
        <div className={`text-sm ${textSecondary} border-t border-default pt-2 mt-1`}>
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
  const { t } = useTranslation("testPattern");
  const results = state.auto_results ?? [];
  const settled = verdict(state.status).settled;

  return (
    <div className="flex flex-col gap-3 flex-1">
      <StatusBar
        status={state.status}
        detail={state.auto_phase ?? t("auto.fullSuite")}
        elapsedSec={state.elapsed_sec}
        passLabel={t("results.allPass")}
      />
      <PeerSummary peer={state.peer} />

      {/* Phase results table */}
      {results.length > 0 && (
        <Card padding="none" className="overflow-hidden">
          <Table mono>
            <thead>
              <tr>
                <th>{t("auto.phaseColumns.phase")}</th>
                <th>{t("auto.phaseColumns.result")}</th>
                <th className="text-right">{t("auto.phaseColumns.tx")}</th>
                <th className="text-right">{t("auto.phaseColumns.rx")}</th>
                <th className="text-right">{t("auto.phaseColumns.drops")}</th>
                <th className="text-right">{t("auto.phaseColumns.rate")}</th>
                <th className="text-right">{t("auto.phaseColumns.latency")}</th>
                <th className="text-right">{t("auto.phaseColumns.time")}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>{r.phase}</td>
                  <td className={`font-semibold ${r.passed ? textDataGreen : textDanger}`}>
                    {t(r.passed ? "results.pass" : "results.fail")}
                  </td>
                  <td className="text-right">{r.tx_count.toLocaleString()}</td>
                  <td className="text-right">{r.rx_count.toLocaleString()}</td>
                  <td className={`text-right ${r.drops > 0 ? textDanger : ""}`}>
                    {r.phase === "Throughput" ? "—" : r.drops.toLocaleString()}
                  </td>
                  <td className="text-right">{r.frames_per_sec.toFixed(0)} fps</td>
                  <td className="text-right">
                    {r.latency_us ? `${r.latency_us.mean_us.toLocaleString()} μs` : "—"}
                  </td>
                  <td className="text-right">{r.elapsed_sec.toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* Per-length-code detail, so a sweep failure names the byte count */}
      {!!state.sweep?.length && (
        <div>
          <div className={`text-xs mb-1 ${textSecondary}`}>{t("auto.sweepTitle")}</div>
          <SweepTable rows={state.sweep} />
        </div>
      )}

      {/* Remote stats from last phase that has them */}
      {(() => {
        const remotePhase = [...results].reverse().find((r) => r.remote);
        if (!remotePhase?.remote) return null;
        return (
          <div>
            <div className={`text-xs mb-1 ${textSecondary}`}>
              {t("auto.remoteFromPhase", { phase: remotePhase.phase })}
            </div>
            <div className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 ${monoBody}`}>
              <Stat label={t("results.stats.rx")} value={remotePhase.remote.rx_count} />
              <Stat label={t("results.stats.tx")} value={remotePhase.remote.tx_count} />
              <Stat label={t("results.stats.rate")} value={`${remotePhase.remote.fps} fps`} />
            </div>
          </div>
        );
      })()}

      {/* Plain English summary */}
      {settled && results.length > 0 && (
        <div className={`text-sm ${textSecondary} border-t border-default pt-2 mt-1`}>
          <AutoSummary results={results} status={state.status} elapsed={state.elapsed_sec} />
        </div>
      )}
    </div>
  );
}

const counted = (n: number) => ({ count: n, formatted: n.toLocaleString() });

export function AutoSummary({ results, status, elapsed }: { results: AutoPhaseResult[]; status: TestStatus; elapsed: number }) {
  const { t } = useTranslation("testPattern");
  const stopped = status === "stopped";
  const outcome = t(status === "completed" ? "results.allPass" : stopped ? "results.stopped" : "results.failuresDetected");
  const echoResult = results.find((r) => r.phase === "Echo");
  const latResult = results.find((r) => r.phase === "Latency");
  const tpResult = results.find((r) => r.phase === "Throughput");
  const relResult = results.find((r) => r.phase === "Reliability");

  const parts: string[] = [];

  parts.push(t(stopped ? "summary.suiteStopped" : "summary.suiteCompleted", { seconds: elapsed.toFixed(0), outcome }));

  if (echoResult) {
    parts.push(echoResult.passed
      ? t("summary.echoPassed", { fps: echoResult.frames_per_sec.toFixed(0) })
      : t("summary.echoFailed", { drops: echoResult.drops, errors: echoResult.errors.length }));
  }

  const sweepResult = results.find((r) => r.phase === "Sweep");
  if (sweepResult) {
    const rows = sweepResult.sweep ?? [];
    const bad = rows.filter((r) => !r.passed);
    parts.push(sweepResult.passed
      ? t("summary.sweepPassed", { count: rows.length })
      : t("summary.sweepFailed", { lengths: bad.map((r) => `${r.expected_len} B`).join(", ") }));
  }

  if (latResult?.latency_us) {
    parts.push(t("summary.latency", { mean: latResult.latency_us.mean_us.toLocaleString(), p95: latResult.latency_us.p95_us.toLocaleString() }));
  }

  if (tpResult) {
    const remote = tpResult.remote;
    const fps = tpResult.frames_per_sec.toFixed(0);
    parts.push(remote && remote.rx_count > 0
      ? t("summary.throughputWithBus", { fps, busFps: remote.fps })
      : t("summary.throughput", { fps }));
  }

  if (relResult) {
    const seconds = relResult.elapsed_sec.toFixed(0);
    parts.push(relResult.passed
      ? t("summary.reliabilityPassed", { ...counted(relResult.tx_count), seconds })
      : t("summary.reliabilityFailed", { count: relResult.drops, seconds }));
  }

  return <p>{parts.join(" ")}</p>;
}

function TestSummary({ state, passed }: { state: IOTestState; passed: boolean }) {
  const { t } = useTranslation("testPattern");
  const mode = state.mode;
  const seconds = state.elapsed_sec.toFixed(1);
  const fps = state.frames_per_sec.toFixed(0);
  const sentences = (...parts: (string | false | null | undefined)[]) => <p>{parts.filter(Boolean).join(" ")}</p>;

  if (state.status === "failed" && state.errors.length > 0 && state.tx_count === 0) {
    return <p>{t("summary.noTransmit")}</p>;
  }

  if (mode === "throughput") {
    const remote = state.remote;
    if (remote && remote.rx_count > 0) {
      return sentences(
        t("summary.transmittedQueueRate", { ...counted(state.tx_count), seconds, fps }),
        t("summary.remoteBusRate", { ...counted(remote.rx_count), fps: (remote.rx_count / state.elapsed_sec).toFixed(0) }),
        remote.rx_count < state.tx_count && t("summary.framesLost", counted(state.tx_count - remote.rx_count)),
      );
    }
    return sentences(t("summary.transmitted", { ...counted(state.tx_count), seconds, fps }));
  }

  if (mode === "latency") {
    const lat = state.latency_us;
    if (passed && lat) {
      return sentences(
        t("summary.probesSent", { ...counted(state.tx_count), seconds }),
        t("summary.allReplies", counted(state.rx_count)),
        t("summary.roundTripP95", { mean: lat.mean_us.toLocaleString(), p95: lat.p95_us.toLocaleString() }),
        state.remote && t("summary.remoteProbes", { ...counted(state.remote.rx_count), fps: state.remote.fps }),
      );
    }
    return sentences(
      t("summary.probesSent", { ...counted(state.tx_count), seconds }),
      state.drops > 0 && t("summary.probesLost", { ...counted(state.drops), percent: (state.drops / state.tx_count * 100).toFixed(1) }),
      lat && t("summary.roundTripP99", { mean: lat.mean_us.toLocaleString(), p99: lat.p99_us.toLocaleString() }),
    );
  }

  // Echo / reliability
  if (passed) {
    return sentences(
      t("summary.pingsSent", { ...counted(state.tx_count), seconds, fps }),
      t("summary.allResponses", counted(state.rx_count)),
      state.remote && t("summary.remoteFrames", { ...counted(state.remote.rx_count), fps: state.remote.fps }),
    );
  }

  return sentences(
    t("summary.framesSent", { ...counted(state.tx_count), seconds }),
    t("summary.responses", counted(state.rx_count)),
    state.drops > 0 && t("summary.dropped", counted(state.drops)),
    state.duplicates > 0 && t("summary.duplicates", { count: state.duplicates }),
    state.errors.length > 0 && t("summary.errors", { count: state.errors.length }),
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
