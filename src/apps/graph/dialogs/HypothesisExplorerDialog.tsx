// ui/src/apps/graph/dialogs/HypothesisExplorerDialog.tsx

import { useState, useCallback, useMemo } from "react";
import { X, FlaskConical, ChevronRight, ChevronLeft, CheckSquare, Square, ChevronsUp } from "lucide-react";
import { iconSm, iconLg } from "../../../styles/spacing";
import {
  bgSurface, borderDivider, hoverLight, inputSimple,
  selectSimple, primaryButtonBase, textSecondary,
} from "../../../styles";
import Dialog from "../../../components/Dialog";
import { useGraphStore } from "../../../stores/graphStore";
import { useDiscoveryToolboxStore } from "../../../stores/discoveryToolboxStore";
import type { PayloadAnalysisResult } from "../../../utils/analysis/payloadAnalysis";
import { generateHypotheses, type HypothesisConfig } from "../../../utils/hypothesisRanking";
import { formatFrameId } from "../../../utils/frameIds";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const BIT_LENGTH_OPTIONS = [8, 12, 16, 24, 32];

const toggleCls = (active: boolean) =>
  active
    ? "bg-blue-600 text-white border-blue-600"
    : "bg-transparent text-[color:var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--hover-bg)]";

const scoreBadgeCls = (score: number) => {
  if (score >= 70) return "bg-emerald-600/20 text-emerald-400 border-emerald-600/30";
  if (score >= 30) return "bg-amber-600/20 text-amber-400 border-amber-600/30";
  return "bg-[var(--bg-secondary)] text-[color:var(--text-muted)] border-[var(--border-default)]";
};

export default function HypothesisExplorerDialog({ isOpen, onClose }: Props) {
  const discoveredFrameIds = useGraphStore((s) => s.discoveredFrameIds);
  const addPanel = useGraphStore((s) => s.addPanel);
  const updatePanel = useGraphStore((s) => s.updatePanel);
  const addSignalToPanel = useGraphStore((s) => s.addSignalToPanel);
  const registerHypotheses = useGraphStore((s) => s.registerHypotheses);
  const changesResults = useDiscoveryToolboxStore((s) => s.toolbox.changesResults);

  // ── Step 1: Configuration state ──
  const [step, setStep] = useState<1 | 2>(1);
  const [frameMode, setFrameMode] = useState<'single' | 'all'>('single');
  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [bitLengths, setBitLengths] = useState<Set<number>>(new Set([8, 16]));
  const [endianness, setEndianness] = useState<Set<'little' | 'big'>>(new Set(['little']));
  const [byteAligned, setByteAligned] = useState(true);
  const [startBit, setStartBit] = useState("0");
  const [endBit, setEndBit] = useState("63");
  const [signed, setSigned] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [factor, setFactor] = useState("1");
  const [offset, setOffset] = useState("0");
  const [useAnalysisHints, setUseAnalysisHints] = useState(false);

  // ── Step 2: Selection state ──
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());

  const sortedFrameIds = useMemo(
    () => Array.from(discoveredFrameIds).sort((a, b) => a - b),
    [discoveredFrameIds],
  );

  // Build analysis results map for scoring
  const analysisMap = useMemo(() => {
    const map = new Map<number, PayloadAnalysisResult>();
    if (changesResults?.analysisResults) {
      for (const r of changesResults.analysisResults) {
        map.set(r.frameId, r);
      }
    }
    return map;
  }, [changesResults]);

  const hasAnalysis = analysisMap.size > 0;

  // Generate candidates from current config
  const candidates = useMemo(() => {
    const frameIds: number[] = frameMode === 'all'
      ? sortedFrameIds
      : selectedFrameId ? [parseInt(selectedFrameId, 10)] : [];

    if (frameIds.length === 0 || bitLengths.size === 0 || endianness.size === 0) return [];

    const parsedFactor = parseFloat(factor) || 1;
    const parsedOffset = parseFloat(offset) || 0;
    const parsedStart = parseInt(startBit, 10) || 0;
    const parsedEnd = parseInt(endBit, 10) || 63;

    const config: HypothesisConfig = {
      frameIds,
      startBitMin: byteAligned ? Math.ceil(parsedStart / 8) * 8 : parsedStart,
      startBitMax: byteAligned ? Math.floor(parsedEnd / 8) * 8 : parsedEnd,
      bitStep: byteAligned ? 8 : 1,
      bitLengths: Array.from(bitLengths).sort((a, b) => a - b),
      endiannesses: Array.from(endianness),
      signed,
      factor: parsedFactor,
      offset: parsedOffset,
    };

    return generateHypotheses(config, useAnalysisHints ? analysisMap : new Map());
  }, [frameMode, selectedFrameId, sortedFrameIds, bitLengths, endianness, byteAligned, startBit, endBit, signed, factor, offset, useAnalysisHints, analysisMap]);

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
  const handlePreview = useCallback(() => {
    // Pre-select all candidates by default
    setSelectedCandidates(new Set(candidates.map((c) => c.signalName)));
    setStep(2);
  }, [candidates]);

  const handleSelectAll = useCallback(() => {
    setSelectedCandidates(new Set(candidates.map((c) => c.signalName)));
  }, [candidates]);

  const handleDeselectAll = useCallback(() => {
    setSelectedCandidates(new Set());
  }, []);

  const handleSelectTopN = useCallback((n: number) => {
    setSelectedCandidates(new Set(candidates.slice(0, n).map((c) => c.signalName)));
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
    const selected = candidates.filter((c) => selectedCandidates.has(c.signalName));
    if (selected.length === 0) return;

    // Register all hypothesis params
    registerHypotheses(
      selected.map((c) => ({ signalName: c.signalName, params: c.params })),
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
        addSignalToPanel(panelId, candidate.frameId, candidate.signalName);
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
    <Dialog isOpen={isOpen} onBackdropClick={handleClose} maxWidth="max-w-lg">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        {/* Header */}
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            <FlaskConical className={`${iconSm} text-purple-400`} />
            <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
              Hypothesis Explorer
            </h2>
          </div>
          <button
            onClick={handleClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {step === 1 && (
            <>
              {/* Frame ID selection */}
              <div>
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  Frame ID
                </label>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => setFrameMode('single')}
                    className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(frameMode === 'single')}`}
                  >
                    Single
                  </button>
                  <button
                    onClick={() => setFrameMode('all')}
                    className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(frameMode === 'all')}`}
                  >
                    All discovered ({sortedFrameIds.length})
                  </button>
                </div>
                {frameMode === 'single' && (
                  <select
                    value={selectedFrameId}
                    onChange={(e) => setSelectedFrameId(e.target.value)}
                    className={`${selectSimple} w-full`}
                  >
                    <option value="">Select a frame ID…</option>
                    {sortedFrameIds.map((id) => (
                      <option key={id} value={String(id)}>
                        {formatFrameId(id)} ({id})
                      </option>
                    ))}
                  </select>
                )}
                {sortedFrameIds.length === 0 && (
                  <p className="text-[10px] text-[color:var(--text-muted)] mt-1">
                    Start a session to discover frame IDs
                  </p>
                )}
              </div>

              {/* Bit lengths */}
              <div>
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  Bit Lengths
                </label>
                <div className="flex gap-2 flex-wrap">
                  {BIT_LENGTH_OPTIONS.map((bits) => (
                    <button
                      key={bits}
                      onClick={() => toggleBitLength(bits)}
                      className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(bitLengths.has(bits))}`}
                    >
                      {bits}-bit
                    </button>
                  ))}
                </div>
              </div>

              {/* Endianness */}
              <div>
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  Endianness
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => toggleEndianness("little")}
                    className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(endianness.has("little"))}`}
                  >
                    Little-endian
                  </button>
                  <button
                    onClick={() => toggleEndianness("big")}
                    className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(endianness.has("big"))}`}
                  >
                    Big-endian
                  </button>
                </div>
              </div>

              {/* Bit range */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-[color:var(--text-secondary)]">
                    Bit Range
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={byteAligned}
                      onChange={(e) => setByteAligned(e.target.checked)}
                      className="rounded border-gray-500"
                    />
                    <span className="text-[10px] text-[color:var(--text-muted)]">
                      Byte-aligned only
                    </span>
                  </label>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <input
                      type="number"
                      min={0}
                      max={63}
                      step={byteAligned ? 8 : 1}
                      value={startBit}
                      onChange={(e) => setStartBit(e.target.value)}
                      className={`${inputSimple} w-full`}
                      placeholder="Start bit"
                    />
                  </div>
                  <span className="text-[color:var(--text-muted)] self-center text-xs">to</span>
                  <div className="flex-1">
                    <input
                      type="number"
                      min={0}
                      max={63}
                      step={byteAligned ? 8 : 1}
                      value={endBit}
                      onChange={(e) => setEndBit(e.target.value)}
                      className={`${inputSimple} w-full`}
                      placeholder="End bit"
                    />
                  </div>
                </div>
              </div>

              {/* Signed toggle */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={signed}
                  onChange={(e) => setSigned(e.target.checked)}
                  className="rounded border-gray-500"
                />
                <span className="text-xs text-[color:var(--text-secondary)]">
                  Signed interpretation
                </span>
              </label>

              {/* Analysis hints toggle */}
              {hasAnalysis && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useAnalysisHints}
                    onChange={(e) => setUseAnalysisHints(e.target.checked)}
                    className="rounded border-gray-500"
                  />
                  <span className="text-xs text-[color:var(--text-secondary)]">
                    Rank using analysis hints
                  </span>
                </label>
              )}

              {/* Advanced: Factor / Offset */}
              <div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className={`text-xs ${textSecondary} hover:text-[color:var(--text-primary)] transition-colors`}
                >
                  {showAdvanced ? "▾ " : "▸ "}Scale &amp; offset
                </button>
                {showAdvanced && (
                  <div className="flex gap-3 mt-2">
                    <div className="flex-1">
                      <label className="block text-[10px] text-[color:var(--text-muted)] mb-0.5">
                        Factor
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={factor}
                        onChange={(e) => setFactor(e.target.value)}
                        className={`${inputSimple} w-full`}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-[10px] text-[color:var(--text-muted)] mb-0.5">
                        Offset
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={offset}
                        onChange={(e) => setOffset(e.target.value)}
                        className={`${inputSimple} w-full`}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Candidate count preview */}
              {canPreview && (
                <p className="text-[10px] text-[color:var(--text-muted)]">
                  {candidates.length} candidate{candidates.length !== 1 ? 's' : ''} will be generated
                  {candidates.length >= 500 && ' (capped at 500)'}
                </p>
              )}

              {/* Next button */}
              <button
                onClick={handlePreview}
                disabled={!canPreview || candidates.length === 0}
                className={`${primaryButtonBase} w-full flex items-center justify-center gap-1`}
              >
                Preview
                <ChevronRight className={iconSm} />
              </button>
            </>
          )}

          {step === 2 && (
            <>
              {/* Selection controls */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleSelectAll}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--border-default)] text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  <CheckSquare className="w-3 h-3" />
                  All
                </button>
                <button
                  onClick={handleDeselectAll}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--border-default)] text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  <Square className="w-3 h-3" />
                  None
                </button>
                <button
                  onClick={() => handleSelectTopN(20)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--border-default)] text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  <ChevronsUp className="w-3 h-3" />
                  Top 20
                </button>
                <span className={`text-[10px] ${textSecondary} ml-auto`}>
                  {selectedCount} selected → {estimatedPanels} panel{estimatedPanels !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Candidate list */}
              <div className="max-h-64 overflow-y-auto space-y-0.5 text-xs">
                {candidates.map((c) => (
                  <button
                    key={c.signalName}
                    onClick={() => toggleCandidate(c.signalName)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-left ${
                      selectedCandidates.has(c.signalName)
                        ? "bg-blue-600/10 border border-blue-600/30"
                        : "bg-[var(--bg-primary)] border border-transparent hover:bg-[var(--hover-bg)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedCandidates.has(c.signalName)}
                      readOnly
                      className="rounded border-gray-500 pointer-events-none"
                    />
                    <span className="text-[color:var(--text-primary)] font-mono truncate flex-1">
                      {c.signalName}
                    </span>
                    {frameMode === 'all' && (
                      <span className="text-[color:var(--text-muted)] shrink-0 tabular-nums">
                        {formatFrameId(c.frameId)}
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-medium rounded border shrink-0 tabular-nums ${scoreBadgeCls(c.score)}`}
                      title={c.reason}
                    >
                      {c.score}
                    </span>
                  </button>
                ))}
                {candidates.length === 0 && (
                  <p className="text-xs text-[color:var(--text-muted)] text-center py-4">
                    No candidates match the current configuration
                  </p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1 px-4 py-2 text-sm rounded border border-[var(--border-default)] text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  <ChevronLeft className={iconSm} />
                  Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={selectedCount === 0}
                  className={`${primaryButtonBase} flex-1 flex items-center justify-center gap-1`}
                >
                  <FlaskConical className={iconSm} />
                  Generate {selectedCount} Signal{selectedCount !== 1 ? 's' : ''}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
