// ui/src/apps/dashboard/dialogs/CandidateSignalsDialog.tsx

import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ChevronRight } from "lucide-react";
import { iconSm } from "../../../styles/spacing";
import Dialog, { DialogBody } from "../../../components/Dialog";
import { useDashboardStore } from "../../../stores/dashboardStore";
import { useDiscoveryToolboxStore } from "../../../stores/discoveryToolboxStore";
import type { ChangesFrame } from "../../../api/byteRoles";
import { candidateSignals } from "../../../api/drafting";
import type { ByteOrder } from "../../../generated/ByteOrder";
import type { CandidateSignal } from "../../../generated/CandidateSignal";
import { useFrameIdFormat } from "../../../hooks/useFrameIdFormat";
import { Button } from "../../../components/Button";
import { PrimaryButton, SecondaryButton, Select, Input, Checkbox } from "../../../components/forms";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const SIGNAL_COLOURS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#a855f7", "#06b6d4", "#f97316", "#ec4899",
  "#84cc16", "#14b8a6", "#6366f1", "#e879f9",
];

/** A typed byte index, or null for anything that is not one. */
function byteIndex(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
}

export default function CandidateSignalsDialog({ isOpen, onClose }: Props) {
  const { t } = useTranslation("dashboard");
  const { format: formatFrameId } = useFrameIdFormat();
  const discoveredFrameIds = useDashboardStore((s) => s.discoveredFrameIds);
  const addPanel = useDashboardStore((s) => s.addPanel);
  const updatePanel = useDashboardStore((s) => s.updatePanel);
  const addSignalToPanel = useDashboardStore((s) => s.addSignalToPanel);
  const changesResults = useDiscoveryToolboxStore((s) => s.toolbox.changesResults);

  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [bitLengths, setBitLengths] = useState<Set<number>>(new Set([8, 16]));
  const [endianness, setEndianness] = useState<Set<ByteOrder>>(new Set(["little"]));
  const [startByte, setStartByte] = useState("0");
  const [endByte, setEndByte] = useState("7");
  const [useAnalysisHints, setUseAnalysisHints] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);

  const sortedFrameIds = useMemo(
    () => Array.from(discoveredFrameIds).sort((a, b) => a - b),
    [discoveredFrameIds],
  );

  // Find analysis results for selected frame
  const analysisResult: ChangesFrame | undefined = useMemo(() => {
    if (!changesResults || !selectedFrameId) return undefined;
    const fid = parseInt(selectedFrameId, 10);
    return changesResults.frames.find((r) => r.frameId === fid);
  }, [changesResults, selectedFrameId]);

  const toggleBitLength = useCallback((bits: number) => {
    setBitLengths((prev) => {
      const next = new Set(prev);
      if (next.has(bits)) next.delete(bits);
      else next.add(bits);
      return next;
    });
  }, []);

  const toggleEndianness = useCallback((e: ByteOrder) => {
    setEndianness((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }, []);

  const [candidates, setCandidates] = useState<CandidateSignal[]>([]);
  useEffect(() => {
    const [start, end] = [byteIndex(startByte), byteIndex(endByte)];
    if (!selectedFrameId || start === null || end === null) {
      setCandidates([]);
      return;
    }
    const hints = useAnalysisHints ? analysisResult?.columns.map(({ position, role }) => ({ position, role })) : undefined;
    let current = true;
    candidateSignals(start, end, [...bitLengths], [...endianness], hints).then(
      (found) => current && setCandidates(found),
      () => current && setCandidates([]),
    );
    return () => {
      current = false;
    };
  }, [selectedFrameId, startByte, endByte, bitLengths, endianness, useAnalysisHints, analysisResult]);

  const label = useCallback(
    (c: CandidateSignal) =>
      c.bits > 8
        ? t("candidates.byteLabelEndian", { offset: c.offset, bits: c.bits, endian: c.endianness === "little" ? "LE" : "BE" })
        : t("candidates.byteLabel", { offset: c.offset, bits: c.bits }),
    [t],
  );

  const handleGenerate = useCallback(() => {
    if (candidates.length === 0 || !selectedFrameId) return;
    const frameId = parseInt(selectedFrameId, 10);

    // Group candidates into panels of up to 4 signals each
    const chunkSize = 4;
    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);

      // Create a new line-chart panel
      const panelId = addPanel("line-chart");

      // Set a descriptive title
      const title = chunk.length === 1
        ? t("candidates.panelTitle", { label: label(chunk[0]) })
        : t("candidates.panelTitleRange", { from: label(chunk[0]), to: label(chunk[chunk.length - 1]) });
      updatePanel(panelId, { title });

      // Add each candidate signal
      for (const candidate of chunk) {
        addSignalToPanel(panelId, frameId, candidate.name);
      }
    }

    onClose();
  }, [candidates, selectedFrameId, addPanel, updatePanel, addSignalToPanel, onClose, label, t]);

  const handleClose = useCallback(() => {
    setStep(1);
    onClose();
  }, [onClose]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title={t("candidates.title")}
      icon={<Sparkles className="text-amber" />}
    >
      <DialogBody className="space-y-4">
        {step === 1 && (
          <>
            {/* Frame ID */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("candidates.fields.frameId")}
              </label>
              <Select
                value={selectedFrameId}
                onChange={(e) => setSelectedFrameId(e.target.value)}
                size="lg"
              >
                <option value="">{t("candidates.fields.selectFrameId")}</option>
                {sortedFrameIds.map((id) => (
                  <option key={id} value={String(id)}>
                    {formatFrameId(id)}
                  </option>
                ))}
              </Select>
              {sortedFrameIds.length === 0 && (
                <p className="text-2xs text-muted mt-1">
                  {t("candidates.fields.noFrames")}
                </p>
              )}
            </div>

            {/* Bit lengths */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("candidates.fields.bitLengths")}
              </label>
              <div className="flex gap-2">
                {[8, 16, 32].map((bits) => (
                  <Button
                    key={bits}
                    onClick={() => toggleBitLength(bits)}
                    variant="outline"
                    size="sm"
                    pressed={bitLengths.has(bits)}
                  >
                    {t("candidates.fields.bitLabel", { bits })}
                  </Button>
                ))}
              </div>
            </div>

            {/* Endianness */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("candidates.fields.endianness")}
              </label>
              <div className="flex gap-2">
                <Button
                  onClick={() => toggleEndianness("little")}
                  variant="outline"
                  size="sm"
                  pressed={endianness.has("little")}
                >
                  {t("candidates.fields.littleEndian")}
                </Button>
                <Button
                  onClick={() => toggleEndianness("big")}
                  variant="outline"
                  size="sm"
                  pressed={endianness.has("big")}
                >
                  {t("candidates.fields.bigEndian")}
                </Button>
              </div>
            </div>

            {/* Byte range */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-secondary mb-1">
                  {t("candidates.fields.startByte")}
                </label>
                <Input
                  type="number"
                  min={0}
                  max={7}
                  value={startByte}
                  onChange={(e) => setStartByte(e.target.value)}
                  size="lg"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-secondary mb-1">
                  {t("candidates.fields.endByte")}
                </label>
                <Input
                  type="number"
                  min={0}
                  max={7}
                  value={endByte}
                  onChange={(e) => setEndByte(e.target.value)}
                  size="lg"
                />
              </div>
            </div>

            {/* Analysis hints toggle */}
            {analysisResult && (
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={useAnalysisHints}
                  onChange={(e) => setUseAnalysisHints(e.target.checked)}
                />
                <span className="text-xs text-secondary">
                  {t("candidates.fields.useHints")}
                </span>
              </label>
            )}

            {/* Next button */}
            <PrimaryButton
              onClick={() => setStep(2)}
              disabled={!selectedFrameId || bitLengths.size === 0 || endianness.size === 0}
              className="w-full"
            >
              {t("candidates.actions.next")}
              <ChevronRight className={iconSm} />
            </PrimaryButton>
          </>
        )}

        {step === 2 && (
          <>
            {/* Preview list */}
            <div>
              <p className="text-xs text-secondary mb-2">
                {t("candidates.preview.summary", { count: candidates.length })}
              </p>
              <div className="max-h-48 overflow-y-auto space-y-0.5 text-xs">
                {candidates.map((c, i) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-2 px-2 py-1 rounded bg-primary"
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: SIGNAL_COLOURS[i % SIGNAL_COLOURS.length] }}
                    />
                    <span className="text-primary font-mono">
                      {c.name}
                    </span>
                    <span className="text-muted ml-auto">
                      {label(c)}
                    </span>
                  </div>
                ))}
              </div>
              {candidates.length === 0 && (
                <p className="text-xs text-muted text-center py-4">
                  {t("candidates.preview.noMatches")}
                </p>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <SecondaryButton
                onClick={() => setStep(1)}
              >
                {t("candidates.actions.back")}
              </SecondaryButton>
              <PrimaryButton
                onClick={handleGenerate}
                disabled={candidates.length === 0}
                className="flex-1"
              >
                <Sparkles className={iconSm} />
                {t("candidates.actions.generate", { count: candidates.length })}
              </PrimaryButton>
            </div>
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}
