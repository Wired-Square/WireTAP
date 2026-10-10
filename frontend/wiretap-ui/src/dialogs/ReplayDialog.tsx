// ui/src/dialogs/ReplayDialog.tsx
//
// Dialog for replaying a range of Discovery frames to a target session with
// time-accurate inter-frame timing scaled by a speed multiplier.
// The user specifies a frame index range (1-based) into the live capture.
// Duplicate frame IDs are preserved — each capture entry is replayed as-is.

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import { helpText, labelSmall } from "../styles";
import { useTransmitStore } from "../stores/transmitStore";
import { openPanel } from "../utils/windowCommunication";
import { useSessionStore } from "../stores/sessionStore";
import { getCaptureMetadataById } from "../api/capture";
import { replayEstimate, type ReplayEstimate, type ReplaySource } from "../api/transmit";
import { Button } from "../components/Button";
import { Input, Select, Checkbox, SecondaryButton, PrimaryButton } from "../components/forms";
import { Alert } from "../components/Alert";
export function formatDuration(us: number): string {
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
  /** The capture the frames are replayed from. */
  captureId: string | null;
}

export default function ReplayDialog({ isOpen, onClose, captureId }: Props) {
  const { t, i18n } = useTranslation("dialogs");
  const startReplay = useTransmitStore((s) => s.startReplay);
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
    let cancelled = false;
    setBufferLength(0);
    if (captureId) {
      void getCaptureMetadataById(captureId).then((meta) => {
        if (cancelled || !meta) return;
        setBufferLength(meta.count);
        setEndRaw(String(meta.count));
      });
    }
    setStartRaw("1");
    setEndRaw("1");
    setSpeed(1);
    setCustomSpeed("1");
    setLoop(false);
    setIsStarting(false);
    setTargetBus("original");
    return () => { cancelled = true; };
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

  const expectedCount = startIdx !== null && endIdx !== null && !rangeError ? endIdx - startIdx + 1 : 0;

  const source = useMemo<ReplaySource | null>(
    () =>
      captureId && startIdx !== null && expectedCount > 0
        ? { capture_id: captureId, offset: startIdx - 1, count: expectedCount, bus: targetBus === "original" ? null : targetBus }
        : null,
    [captureId, startIdx, expectedCount, targetBus]
  );

  // The span and the time one pass takes on the replay's own schedule.
  const [estimate, setEstimate] = useState<ReplayEstimate | null>(null);
  useEffect(() => {
    setEstimate(null);
    if (!isOpen || !source) return;
    let cancelled = false;
    void replayEstimate(source, speed).then((e) => {
      if (!cancelled) setEstimate(e);
    });
    return () => { cancelled = true; };
  }, [isOpen, source, speed]);
  const spanUs = estimate?.span_us ?? 0;
  const passUs = estimate?.pass_duration_us ?? 0;

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

  const handleConfirm = async () => {
    if (!selectedSessionId || !source || rangeError) return;
    const replayId = `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setIsStarting(true);
    try {
      await startReplay(selectedSessionId, replayId, source, speed, loop);
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
    <Dialog isOpen={isOpen} onClose={onClose} size="sm" title={t("replay.title")}>
      <DialogBody className="space-y-4">
        {/* No transmit session warning */}
        {noSession ? (
          <Alert tone="warning">
            <p className="font-medium">{t("replay.noSessionTitle")}</p>
            <p className="text-xs mt-0.5">{t("replay.noSessionBody")}</p>
          </Alert>
        ) : (
          <>
            {/* Frame index range */}
            <div className="space-y-2">
              <label className={labelSmall}>
                {t("replay.frameRangeLabel", { total: bufferLength.toLocaleString(i18n.language) })}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={bufferLength}
                  value={startRaw}
                  onChange={(e) => setStartRaw(e.target.value)}
                  placeholder={t("replay.startPlaceholder")}
                  size="lg"
                  mono
                  className="flex-1"
                />
                <span className="text-secondary text-sm">–</span>
                <Input
                  type="number"
                  min={1}
                  max={bufferLength}
                  value={endRaw}
                  onChange={(e) => setEndRaw(e.target.value)}
                  placeholder={t("replay.endPlaceholder")}
                  size="lg"
                  mono
                  className="flex-1"
                />
                <Button
                  onClick={() => { setStartRaw("1"); setEndRaw(String(bufferLength)); }}
                  variant="outline"
                  size="sm"
                >
                  {t("replay.all")}
                </Button>
              </div>
              {rangeError && bufferLength > 0 ? (
                <p className="text-xs text-danger">{rangeError}</p>
              ) : bufferLength === 0 ? (
                <p className={helpText}>{t("replay.noFrames")}</p>
              ) : (
                <p className={helpText}>
                  {t("replay.spanSummary", {
                    count: expectedCount,
                    span: spanUs > 0 ? formatDuration(spanUs) : "—",
                  })}
                  {passUs !== spanUs && passUs > 0
                    ? t("replay.spanAtSpeed", { adjusted: formatDuration(passUs), speed })
                    : ""}
                </p>
              )}
            </div>

            {/* Transmit session — shown only when multiple options exist */}
            {transmitSessions.length > 1 && (
              <div className="space-y-1">
                <label className={labelSmall}>{t("replay.transmitSession")}</label>
                <Select
                  value={selectedSessionId ?? ""}
                  onChange={(e) => setSelectedSessionId(e.target.value)}
                  size="lg"
                >
                  {transmitSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.profileName || s.id}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {/* Bus picker */}
            <div className="space-y-1">
              <label className={labelSmall}>{t("replay.targetBus")}</label>
              <div className="flex gap-1 flex-wrap">
                <Button
                  onClick={() => setTargetBus("original")}
                  variant="outline"
                  size="sm"
                  pressed={targetBus === "original"}
                >
                  {t("replay.perFrame")}
                </Button>
                {BUS_OPTIONS.map((b) => (
                  <Button
                    key={b}
                    onClick={() => setTargetBus(b)}
                    variant="outline"
                    size="sm"
                    pressed={targetBus === b}
                  >
                    {t("replay.busLabel", { bus: b })}
                  </Button>
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
                  <Button
                    key={p.value}
                    onClick={() => handleSpeedPreset(p.value)}
                    variant="outline"
                    size="sm"
                    pressed={speed === p.value}
                  >
                    {p.label}
                  </Button>
                ))}
                <Input
                  type="number"
                  min={0.01}
                  step={0.25}
                  value={customSpeed}
                  onChange={(e) => handleCustomSpeedChange(e.target.value)}
                  size="sm"
                  className="w-16"
                  placeholder="1.0"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={loop}
                onChange={(e) => setLoop(e.target.checked)}
              />
              <span className="text-sm text-secondary">{t("replay.loopLabel")}</span>
            </label>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={handleConfirm} disabled={!canConfirm}>{isStarting
              ? t("replay.starting")
              : expectedCount > 0
                ? t("replay.replayFrames", { count: expectedCount.toLocaleString(i18n.language) })
                : t("replay.replayFramesEmpty")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
