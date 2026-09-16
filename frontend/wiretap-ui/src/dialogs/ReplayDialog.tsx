// ui/src/dialogs/ReplayDialog.tsx
//
// Dialog for replaying a range of Discovery frames to a target session with
// time-accurate inter-frame timing scaled by a speed multiplier.
// The user specifies a frame index range (1-based) into the live capture.
// Duplicate frame IDs are preserved — each capture entry is replayed as-is.

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Dialog from "../components/Dialog";
import { DialogFooter } from "../components/forms/DialogFooter";
import { focusRingThin, helpText, inputSimple, labelSmall } from "../styles";
import { useTransmitStore } from "../stores/transmitStore";
import { getDiscoveryFrameBuffer, useDiscoveryFrameStore } from "../stores/discoveryFrameStore";
import { openPanel } from "../utils/windowCommunication";
import { useSessionStore } from "../stores/sessionStore";
import { getCaptureFramesPaginatedById } from "../api/capture";
import type { ReplayFrame } from "../api/transmit";

function formatDuration(us: number): string {
  const ms = us / 1000;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(1)}s`;
}

const SPEED_PRESETS = [
  { label: "0.25×", value: 0.25 },
  { label: "0.5×", value: 0.5 },
  { label: "1×", value: 1 },
  { label: "2×", value: 2 },
  { label: "10×", value: 10 },
];

const BUS_OPTIONS = [0, 1, 2, 3, 4] as const;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Capture ID for capture-first mode (when frames are stored in the Rust backend) */
  captureId?: string | null;
}

export default function ReplayDialog({ isOpen, onClose, captureId }: Props) {
  const { t, i18n } = useTranslation("dialogs");
  const startReplay = useTransmitStore((s) => s.startReplay);
  const captureMode = useDiscoveryFrameStore((s) => s.captureMode);
  const sessions = useSessionStore((s) => s.sessions);

  // Transmit-capable sessions currently connected
  const transmitSessions = useMemo(
    () =>
      Object.values(sessions).filter(
        (s) => s && s.lifecycleState === "connected" && s.capabilities?.traits.tx_frames === true
      ),
    [sessions]
  );

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [targetBus, setTargetBus] = useState<number | "original">("original");
  const [speed, setSpeed] = useState<number>(1);
  const [customSpeed, setCustomSpeed] = useState<string>("1");
  const [loop, setLoop] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [bufferLength, setBufferLength] = useState(0);
  const [startRaw, setStartRaw] = useState("1");
  const [endRaw, setEndRaw] = useState("1");

  // Reset state when dialog opens; snapshot capture length at open time
  useEffect(() => {
    if (!isOpen) return;
    const len = captureMode.enabled ? captureMode.totalFrames : getDiscoveryFrameBuffer().length;
    setBufferLength(len);
    setStartRaw("1");
    setEndRaw(String(len));
    setSpeed(1);
    setCustomSpeed("1");
    setLoop(false);
    setIsStarting(false);
    setTargetBus("original");
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select the first (or only) transmit session
  useEffect(() => {
    if (!isOpen) return;
    if (transmitSessions.length === 1) {
      setSelectedSessionId(transmitSessions[0].id);
    } else if (transmitSessions.length === 0) {
      setSelectedSessionId(null);
    } else {
      // Keep current selection if still valid; otherwise pick first
      setSelectedSessionId((prev) =>
        transmitSessions.some((s) => s.id === prev) ? prev : transmitSessions[0].id
      );
    }
  }, [isOpen, transmitSessions]);

  const startIdx = useMemo(() => {
    const n = parseInt(startRaw, 10);
    return isNaN(n) ? null : n;
  }, [startRaw]);

  const endIdx = useMemo(() => {
    const n = parseInt(endRaw, 10);
    return isNaN(n) ? null : n;
  }, [endRaw]);

  const rangeError =
    startIdx === null || endIdx === null
      ? t("replay.errors.invalidNumber")
      : startIdx < 1
      ? t("replay.errors.startMin")
      : endIdx > bufferLength
      ? t("replay.errors.endMax", { max: bufferLength })
      : startIdx > endIdx
      ? t("replay.errors.startEnd")
      : null;

  // Slice capture by 1-based index range; preserves order and duplicate frame IDs
  const replayFrames = useMemo<ReplayFrame[]>(() => {
    if (!isOpen || rangeError || startIdx === null || endIdx === null || captureMode.enabled) return [];
    const buffer = getDiscoveryFrameBuffer();
    return buffer.slice(startIdx - 1, endIdx).map((f) => ({
      timestamp_us: f.timestamp_us,
      frame: {
        frame_id: f.frame_id,
        data: [...f.bytes],
        bus: f.bus ?? 0,
        is_extended: f.is_extended ?? false,
        is_fd: f.is_fd ?? false,
        is_brs: false,
        is_rtr: false,
      },
    }));
  }, [isOpen, startIdx, endIdx, rangeError, captureMode.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const frameCount = replayFrames.length;
  const spanUs =
    frameCount >= 2
      ? replayFrames[frameCount - 1].timestamp_us - replayFrames[0].timestamp_us
      : 0;
  const effectiveSpanUs = speed > 0 ? spanUs / speed : spanUs;

  const expectedCount = captureMode.enabled
    ? startIdx !== null && endIdx !== null && !rangeError
      ? endIdx - startIdx + 1
      : 0
    : frameCount;

  const handleSpeedPreset = (v: number) => {
    setSpeed(v);
    setCustomSpeed(String(v));
  };

  const handleCustomSpeedChange = (raw: string) => {
    setCustomSpeed(raw);
    const parsed = parseFloat(raw);
    if (!isNaN(parsed) && parsed > 0) {
      setSpeed(parsed);
    }
  };

  const applyBusOverride = (frames: ReplayFrame[]): ReplayFrame[] => {
    if (targetBus === "original") return frames;
    return frames.map((f) => ({ ...f, frame: { ...f.frame, bus: targetBus } }));
  };

  const handleConfirm = async () => {
    if (!selectedSessionId || startIdx === null || endIdx === null || rangeError) return;
    const replayId = `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setIsStarting(true);
    try {
      let frames: ReplayFrame[];
      if (captureMode.enabled && captureId) {
        const count = endIdx - startIdx + 1;
        const response = await getCaptureFramesPaginatedById(captureId, startIdx - 1, count);
        frames = response.frames.map((f) => ({
          timestamp_us: f.timestamp_us,
          frame: {
            frame_id: f.frame_id,
            data: [...f.bytes],
            bus: f.bus ?? 0,
            is_extended: f.is_extended ?? false,
            is_fd: f.is_fd ?? false,
            is_brs: false,
            is_rtr: false,
          },
        }));
      } else {
        frames = replayFrames;
      }
      if (frames.length === 0) return;
      await startReplay(selectedSessionId, replayId, applyBusOverride(frames), speed, loop);
      useTransmitStore.setState({ activeTab: "replay" });
      openPanel("transmit");
      onClose();
    } finally {
      setIsStarting(false);
    }
  };

  const canConfirm =
    !!selectedSessionId && expectedCount > 0 && !isStarting && !rangeError &&
    transmitSessions.length > 0;

  const noSession = transmitSessions.length === 0;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          {t("replay.title")}
        </h2>

        {/* No transmit session warning */}
        {noSession ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <p className="text-sm text-amber-300 font-medium">{t("replay.noSessionTitle")}</p>
            <p className="text-xs text-amber-300/80 mt-0.5">{t("replay.noSessionBody")}</p>
          </div>
        ) : (
          <>
            {/* Frame index range */}
            <div className="space-y-2">
              <label className={labelSmall}>
                {t("replay.frameRangeLabel", { total: bufferLength.toLocaleString(i18n.language) })}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={bufferLength}
                  value={startRaw}
                  onChange={(e) => setStartRaw(e.target.value)}
                  placeholder={t("replay.startPlaceholder")}
                  className={`${inputSimple} flex-1 font-mono text-sm`}
                />
                <span className="text-[color:var(--text-secondary)] text-sm">–</span>
                <input
                  type="number"
                  min={1}
                  max={bufferLength}
                  value={endRaw}
                  onChange={(e) => setEndRaw(e.target.value)}
                  placeholder={t("replay.endPlaceholder")}
                  className={`${inputSimple} flex-1 font-mono text-sm`}
                />
                <button
                  onClick={() => { setStartRaw("1"); setEndRaw(String(bufferLength)); }}
                  className="px-2.5 py-1.5 text-xs rounded border border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95 transition-colors whitespace-nowrap"
                >
                  {t("replay.all")}
                </button>
              </div>
              {rangeError && bufferLength > 0 ? (
                <p className="text-xs text-[color:var(--status-danger-text)]">{rangeError}</p>
              ) : bufferLength === 0 ? (
                <p className={helpText}>{t("replay.noFrames")}</p>
              ) : captureMode.enabled ? (
                <p className={helpText}>
                  {t("replay.selectedSummary", { count: expectedCount })}
                </p>
              ) : (
                <p className={helpText}>
                  {t("replay.spanSummary", {
                    count: frameCount,
                    span: spanUs > 0 ? formatDuration(spanUs) : "—",
                  })}
                  {effectiveSpanUs !== spanUs && effectiveSpanUs > 0 && speed !== 1
                    ? t("replay.spanAtSpeed", { adjusted: formatDuration(effectiveSpanUs), speed })
                    : ""}
                </p>
              )}
            </div>

            {/* Transmit session — shown only when multiple options exist */}
            {transmitSessions.length > 1 && (
              <div className="space-y-1">
                <label className={labelSmall}>{t("replay.transmitSession")}</label>
                <select
                  value={selectedSessionId ?? ""}
                  onChange={(e) => setSelectedSessionId(e.target.value)}
                  className={inputSimple}
                >
                  {transmitSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.profileName || s.id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Bus picker */}
            <div className="space-y-1">
              <label className={labelSmall}>{t("replay.targetBus")}</label>
              <div className="flex gap-1 flex-wrap">
                <button
                  onClick={() => setTargetBus("original")}
                  className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                    targetBus === "original"
                      ? "border-blue-500 bg-blue-600/20 text-blue-400"
                      : "border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95"
                  }`}
                >
                  {t("replay.perFrame")}
                </button>
                {BUS_OPTIONS.map((b) => (
                  <button
                    key={b}
                    onClick={() => setTargetBus(b)}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      targetBus === b
                        ? "border-blue-500 bg-blue-600/20 text-blue-400"
                        : "border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95"
                    }`}
                  >
                    {t("replay.busLabel", { bus: b })}
                  </button>
                ))}
              </div>
              <p className={helpText}>
                {targetBus === "original"
                  ? t("replay.perFrameHelp")
                  : t("replay.fixedBusHelp", { bus: targetBus })}
              </p>
            </div>

            {/* Speed */}
            <div className="space-y-2">
              <label className={labelSmall}>{t("replay.speed")}</label>
              <div className="flex gap-1 flex-wrap">
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => handleSpeedPreset(p.value)}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      speed === p.value
                        ? "border-blue-500 bg-blue-600/20 text-blue-400"
                        : "border-[color:var(--border-default)] text-[color:var(--text-secondary)] hover:brightness-95"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <input
                  type="number"
                  min={0.01}
                  step={0.25}
                  value={customSpeed}
                  onChange={(e) => handleCustomSpeedChange(e.target.value)}
                  className={`w-16 text-xs px-2 py-1 rounded border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] ${focusRingThin}`}
                  placeholder="1.0"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) => setLoop(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-[color:var(--text-secondary)]">{t("replay.loopLabel")}</span>
            </label>
          </>
        )}

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleConfirm}
          confirmLabel={
            isStarting
              ? t("replay.starting")
              : expectedCount > 0
                ? t("replay.replayFrames", { count: expectedCount.toLocaleString(i18n.language) })
                : t("replay.replayFramesEmpty")
          }
          confirmDisabled={!canConfirm}
        />
      </div>
    </Dialog>
  );
}
