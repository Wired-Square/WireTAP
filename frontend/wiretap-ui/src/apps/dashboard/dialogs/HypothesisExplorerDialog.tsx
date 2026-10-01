// ui/src/apps/dashboard/dialogs/HypothesisExplorerDialog.tsx

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, ChevronRight, ChevronLeft, CheckSquare, Square, ChevronsUp } from "lucide-react";
import { iconSm } from "../../../styles/spacing";
import { textSecondary } from "../../../styles";
import Dialog, { DialogBody } from "../../../components/Dialog";
import { useDashboardStore } from "../../../stores/dashboardStore";
import { rankHypotheses, type RankedCandidate } from "../../../api/adhoc";
import { candidateLabel, reasonText } from "../utils/hypothesisText";
import { Alert } from "../../../components/Alert";
import { useFrameIdFormat } from "../../../hooks/useFrameIdFormat";
import { Button } from "../../../components/Button";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { PrimaryButton, SecondaryButton, Select, Checkbox, Input } from "../../../components/forms";
import { Listbox, Option } from "../../../components/Listbox";

interface Props {
  sessionId: string;
  isOpen: boolean;
  onClose: () => void;
}

const BIT_LENGTH_OPTIONS = [8, 12, 16, 24, 32];

const scoreTone = (score: number): BadgeTone => (score >= 70 ? "success" : score >= 30 ? "warning" : "neutral");

export default function HypothesisExplorerDialog({ sessionId, isOpen, onClose }: Props) {
  const { t } = useTranslation("dashboard");
  const { format: formatFrameId } = useFrameIdFormat();
  const discoveredFrameIds = useDashboardStore((s) => s.discoveredFrameIds);
  const addPanel = useDashboardStore((s) => s.addPanel);
  const updatePanel = useDashboardStore((s) => s.updatePanel);
  const addSignalToPanel = useDashboardStore((s) => s.addSignalToPanel);
  const registerHypotheses = useDashboardStore((s) => s.registerHypotheses);

  // ── Step 1: Configuration state ──
  const [step, setStep] = useState<1 | 2>(1);
  const [frameMode, setFrameMode] = useState<'single' | 'all'>('single');
  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [bitLengths, setBitLengths] = useState<Set<number>>(new Set([8, 16]));
  const [endianness, setEndianness] = useState<Set<'little' | 'big'>>(new Set(['little']));
  const [byteAligned, setByteAligned] = useState(true);
  const [startBit, setStartBit] = useState("0");
  const [endBit, setEndBit] = useState("");
  const [signed, setSigned] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [factor, setFactor] = useState("1");
  const [offset, setOffset] = useState("0");
  const [useAnalysisHints, setUseAnalysisHints] = useState(true);

  // ── Step 2: Ranked candidates and selection ──
  const [candidates, setCandidates] = useState<RankedCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [ranking, setRanking] = useState(false);
  const [rankError, setRankError] = useState<string | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());

  const sortedFrameIds = useMemo(
    () => Array.from(discoveredFrameIds).sort((a, b) => a - b),
    [discoveredFrameIds],
  );

  const toggleBitLength = useCallback((bits: number) => {
    setBitLengths((prev) => {
      const next = new Set(prev);
      if (next.has(bits)) next.delete(bits);
      else next.add(bits);
      return next;
    });
  }, []);

  const toggleEndianness = useCallback((e: 'little' | 'big') => {
    setEndianness((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }, []);

  // ── Step transition ──
  const handlePreview = useCallback(async () => {
    const frameIds = frameMode === 'all'
      ? sortedFrameIds
      : selectedFrameId ? [parseInt(selectedFrameId, 10)] : [];
    const parsedStart = parseInt(startBit, 10) || 0;
    const parsedEnd = endBit.trim() === "" ? undefined : parseInt(endBit, 10);
    setRanking(true);
    setRankError(null);
    try {
      const ranked = await rankHypotheses(sessionId, {
        frameIds,
        startBit: byteAligned ? Math.ceil(parsedStart / 8) * 8 : parsedStart,
        endBit: parsedEnd !== undefined && byteAligned ? Math.floor(parsedEnd / 8) * 8 : parsedEnd,
        bitStep: byteAligned ? 8 : 1,
        bitLengths: Array.from(bitLengths).sort((a, b) => a - b),
        endiannesses: Array.from(endianness),
        signed,
        factor: parseFloat(factor) || 1,
        offset: parseFloat(offset) || 0,
        useProfile: useAnalysisHints,
      });
      setCandidates(ranked.candidates);
      setTotal(ranked.total);
      setSelectedCandidates(new Set(ranked.candidates.map((c) => c.name)));
      setStep(2);
    } catch (e) {
      setRankError(String(e));
    } finally {
      setRanking(false);
    }
  }, [sessionId, frameMode, selectedFrameId, sortedFrameIds, bitLengths, endianness, byteAligned, startBit, endBit, signed, factor, offset, useAnalysisHints]);

  const handleSelectAll = useCallback(() => {
    setSelectedCandidates(new Set(candidates.map((c) => c.name)));
  }, [candidates]);

  const handleDeselectAll = useCallback(() => {
    setSelectedCandidates(new Set());
  }, []);

  const handleSelectTopN = useCallback((n: number) => {
    setSelectedCandidates(new Set(candidates.slice(0, n).map((c) => c.name)));
  }, [candidates]);

  const toggleCandidate = useCallback((signalName: string) => {
    setSelectedCandidates((prev) => {
      const next = new Set(prev);
      if (next.has(signalName)) next.delete(signalName);
      else next.add(signalName);
      return next;
    });
  }, []);

  // ── Generate panels ──
  const handleGenerate = useCallback(() => {
    const selected = candidates
      .filter((c) => selectedCandidates.has(c.name))
      .map((c) => ({ ...c, label: candidateLabel(c.params) }));
    if (selected.length === 0) return;

    // Register all hypothesis params
    registerHypotheses(
      selected.map((c) => ({ signalName: c.name, params: c.params })),
    );

    // Group candidates into panels of up to 4 signals each
    const chunkSize = 4;
    for (let i = 0; i < selected.length; i += chunkSize) {
      const chunk = selected.slice(i, i + chunkSize);
      const panelId = addPanel("line-chart");

      // Set a descriptive title
      const frameLabel = chunk.length === 1 || new Set(chunk.map((c) => c.frameId)).size === 1
        ? formatFrameId(chunk[0].frameId)
        : "multi";
      const rangeLabel = chunk.length === 1
        ? chunk[0].label
        : `${chunk[0].label} … ${chunk[chunk.length - 1].label}`;
      updatePanel(panelId, { title: `Hypothesis ${frameLabel}: ${rangeLabel}` });

      for (const candidate of chunk) {
        addSignalToPanel(panelId, candidate.frameId, candidate.name);
      }
    }

    handleClose();
  }, [candidates, selectedCandidates, registerHypotheses, addPanel, updatePanel, addSignalToPanel]);

  const handleClose = useCallback(() => {
    setStep(1);
    onClose();
  }, [onClose]);

  const selectedCount = selectedCandidates.size;
  const estimatedPanels = Math.ceil(selectedCount / 4);
  const canPreview = frameMode === 'all'
    ? sortedFrameIds.length > 0 && bitLengths.size > 0 && endianness.size > 0
    : !!selectedFrameId && bitLengths.size > 0 && endianness.size > 0;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      size="lg"
      title={t("hypothesis.title")}
      icon={<FlaskConical className="text-purple" />}
    >
      <DialogBody className="space-y-4">
        {step === 1 && (
          <>
            {/* Frame ID selection */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("hypothesis.fields.frameId")}
              </label>
              <div className="flex gap-2 mb-2">
                <Button
                  onClick={() => setFrameMode('single')}
                  variant="outline"
                  size="sm"
                  pressed={frameMode === 'single'}
                >
                  {t("hypothesis.fields.single")}
                </Button>
                <Button
                  onClick={() => setFrameMode('all')}
                  variant="outline"
                  size="sm"
                  pressed={frameMode === 'all'}
                >
                  {t("hypothesis.fields.allDiscovered", { count: sortedFrameIds.length })}
                </Button>
              </div>
              {frameMode === 'single' && (
                <Select
                  value={selectedFrameId}
                  onChange={(e) => setSelectedFrameId(e.target.value)}
                  size="lg"
                >
                  <option value="">{t("hypothesis.fields.selectFrameId")}</option>
                  {sortedFrameIds.map((id) => (
                    <option key={id} value={String(id)}>
                      {formatFrameId(id)}
                    </option>
                  ))}
                </Select>
              )}
              {sortedFrameIds.length === 0 && (
                <p className="text-2xs text-muted mt-1">
                  {t("hypothesis.fields.noFrames")}
                </p>
              )}
            </div>

            {/* Bit lengths */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("hypothesis.fields.bitLengths")}
              </label>
              <div className="flex gap-2 flex-wrap">
                {BIT_LENGTH_OPTIONS.map((bits) => (
                  <Button
                    key={bits}
                    onClick={() => toggleBitLength(bits)}
                    variant="outline"
                    size="sm"
                    pressed={bitLengths.has(bits)}
                  >
                    {t("hypothesis.fields.bitLabel", { bits })}
                  </Button>
                ))}
              </div>
            </div>

            {/* Endianness */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {t("hypothesis.fields.endianness")}
              </label>
              <div className="flex gap-2">
                <Button
                  onClick={() => toggleEndianness("little")}
                  variant="outline"
                  size="sm"
                  pressed={endianness.has("little")}
                >
                  {t("hypothesis.fields.littleEndian")}
                </Button>
                <Button
                  onClick={() => toggleEndianness("big")}
                  variant="outline"
                  size="sm"
                  pressed={endianness.has("big")}
                >
                  {t("hypothesis.fields.bigEndian")}
                </Button>
              </div>
            </div>

            {/* Bit range */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-secondary">
                  {t("hypothesis.fields.bitRange")}
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={byteAligned}
                    onChange={(e) => setByteAligned(e.target.checked)}
                  />
                  <span className="text-2xs text-muted">
                    {t("hypothesis.fields.byteAligned")}
                  </span>
                </label>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <Input
                    type="number"
                    min={0}
                    step={byteAligned ? 8 : 1}
                    value={startBit}
                    onChange={(e) => setStartBit(e.target.value)}
                    size="lg"
                    placeholder={t("hypothesis.fields.startBit")}
                  />
                </div>
                <span className="text-muted self-center text-xs">{t("hypothesis.fields.rangeTo")}</span>
                <div className="flex-1">
                  <Input
                    type="number"
                    min={0}
                    step={byteAligned ? 8 : 1}
                    value={endBit}
                    onChange={(e) => setEndBit(e.target.value)}
                    size="lg"
                    placeholder={t("hypothesis.fields.endBit")}
                  />
                </div>
              </div>
            </div>

            {/* Signed toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={signed}
                onChange={(e) => setSigned(e.target.checked)}
              />
              <span className="text-xs text-secondary">
                {t("hypothesis.fields.signed")}
              </span>
            </label>

            {/* Analysis hints toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={useAnalysisHints}
                onChange={(e) => setUseAnalysisHints(e.target.checked)}
              />
              <span className="text-xs text-secondary">
                {t("hypothesis.fields.useHints")}
              </span>
            </label>

            {/* Advanced: Factor / Offset */}
            <div>
              <Button
                onClick={() => setShowAdvanced(!showAdvanced)}
                variant="link"
                className="text-xs"
              >
                {showAdvanced ? t("hypothesis.fields.advancedShown") : t("hypothesis.fields.advancedHidden")}
              </Button>
              {showAdvanced && (
                <div className="flex gap-3 mt-2">
                  <div className="flex-1">
                    <label className="block text-2xs text-muted mb-0.5">
                      {t("hypothesis.fields.factor")}
                    </label>
                    <Input
                      type="number"
                      step="any"
                      value={factor}
                      onChange={(e) => setFactor(e.target.value)}
                      size="lg"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-2xs text-muted mb-0.5">
                      {t("hypothesis.fields.offset")}
                    </label>
                    <Input
                      type="number"
                      step="any"
                      value={offset}
                      onChange={(e) => setOffset(e.target.value)}
                      size="lg"
                    />
                  </div>
                </div>
              )}
            </div>

            {rankError && <Alert tone="danger" size="sm">{rankError}</Alert>}

            {/* Next button */}
            <PrimaryButton
              onClick={handlePreview}
              disabled={!canPreview || !sessionId || ranking}
              className="w-full"
            >
              {t("hypothesis.actions.next")}
              <ChevronRight className={iconSm} />
            </PrimaryButton>
          </>
        )}

        {step === 2 && (
          <>
            <p className="text-2xs text-muted">
              {t("hypothesis.preview.summary", { count: total })}
              {total > candidates.length && t("hypothesis.preview.cap")}
            </p>

            {/* Selection controls */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={handleSelectAll}
                variant="outline"
                size="sm"
              >
                <CheckSquare className="w-3 h-3" />
                {t("hypothesis.actions.selectAll")}
              </Button>
              <Button
                onClick={handleDeselectAll}
                variant="outline"
                size="sm"
              >
                <Square className="w-3 h-3" />
                {t("hypothesis.actions.selectNone")}
              </Button>
              <Button
                onClick={() => handleSelectTopN(20)}
                variant="outline"
                size="sm"
              >
                <ChevronsUp className="w-3 h-3" />
                {t("hypothesis.actions.topN", { count: 20 })}
              </Button>
              <span className={`text-2xs ${textSecondary} ml-auto`}>
                {t("hypothesis.actions.selectionSummary", { count: selectedCount, panels: estimatedPanels })}
              </span>
            </div>

            {/* Candidate list */}
            <Listbox className="max-h-64 overflow-y-auto p-0 gap-0.5 text-xs">
              {candidates.map((c) => (
                <Option
                  key={c.name}
                  size="sm"
                  selected={selectedCandidates.has(c.name)}
                  mark="check"
                  className="gap-2 px-2"
                  onClick={() => toggleCandidate(c.name)}
                >
                  <span className="text-primary font-mono truncate flex-1">
                    {c.name}
                  </span>
                  {frameMode === 'all' && (
                    <span className="text-muted shrink-0 tabular-nums">
                      {formatFrameId(c.frameId)}
                    </span>
                  )}
                  <Badge tone={scoreTone(c.score)} size="sm" className="tabular-nums" title={reasonText(t, c.reasons)}>
                    {c.score}
                  </Badge>
                </Option>
              ))}
              {candidates.length === 0 && (
                <p className="text-xs text-muted text-center py-4">
                  {t("hypothesis.preview.noMatches")}
                </p>
              )}
            </Listbox>

            {/* Action buttons */}
            <div className="flex gap-2">
              <SecondaryButton
                onClick={() => setStep(1)}
              >
                <ChevronLeft className={iconSm} />
                {t("hypothesis.actions.back")}
              </SecondaryButton>
              <PrimaryButton
                onClick={handleGenerate}
                disabled={selectedCount === 0}
                className="flex-1"
              >
                <FlaskConical className={iconSm} />
                {t("hypothesis.actions.generate", { count: selectedCount })}
              </PrimaryButton>
            </div>
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}
