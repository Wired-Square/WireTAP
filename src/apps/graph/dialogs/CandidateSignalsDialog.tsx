// ui/src/apps/graph/dialogs/CandidateSignalsDialog.tsx

import { useState, useCallback, useMemo } from "react";
import { X, Sparkles, ChevronRight } from "lucide-react";
import { iconLg, iconSm } from "../../../styles/spacing";
import { bgSurface, borderDivider, hoverLight, inputSimple, selectSimple, primaryButtonBase } from "../../../styles";
import Dialog from "../../../components/Dialog";
import { useGraphStore } from "../../../stores/graphStore";
import { useDiscoveryToolboxStore } from "../../../stores/discoveryToolboxStore";
import type { PayloadAnalysisResult, ByteRole } from "../../../utils/analysis/payloadAnalysis";
import { formatFrameId } from "../../../utils/frameIds";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

interface CandidateSignal {
  label: string;
  signalName: string; // pattern: byte_<offset>_<bits>b_<endian>
  offset: number;
  bits: number;
  endianness: "le" | "be";
}

const SIGNAL_COLOURS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#a855f7", "#06b6d4", "#f97316", "#ec4899",
  "#84cc16", "#14b8a6", "#6366f1", "#e879f9",
];

export default function CandidateSignalsDialog({ isOpen, onClose }: Props) {
  const discoveredFrameIds = useGraphStore((s) => s.discoveredFrameIds);
  const addPanel = useGraphStore((s) => s.addPanel);
  const updatePanel = useGraphStore((s) => s.updatePanel);
  const addSignalToPanel = useGraphStore((s) => s.addSignalToPanel);
  const changesResults = useDiscoveryToolboxStore((s) => s.toolbox.changesResults);

  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [bitLengths, setBitLengths] = useState<Set<number>>(new Set([8, 16]));
  const [endianness, setEndianness] = useState<Set<"le" | "be">>(new Set(["le"]));
  const [startByte, setStartByte] = useState("0");
  const [endByte, setEndByte] = useState("7");
  const [useAnalysisHints, setUseAnalysisHints] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);

  const sortedFrameIds = useMemo(
    () => Array.from(discoveredFrameIds).sort((a, b) => a - b),
    [discoveredFrameIds],
  );

  // Find analysis results for selected frame
  const analysisResult: PayloadAnalysisResult | undefined = useMemo(() => {
    if (!changesResults?.analysisResults || !selectedFrameId) return undefined;
    const fid = parseInt(selectedFrameId, 10);
    return changesResults.analysisResults.find((r) => r.frameId === fid);
  }, [changesResults, selectedFrameId]);

  const toggleBitLength = useCallback((bits: number) => {
    setBitLengths((prev) => {
      const next = new Set(prev);
      if (next.has(bits)) next.delete(bits);
      else next.add(bits);
      return next;
    });
  }, []);

  const toggleEndianness = useCallback((e: "le" | "be") => {
    setEndianness((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });
  }, []);

  // Generate candidate signals
  const candidates: CandidateSignal[] = useMemo(() => {
    if (!selectedFrameId) return [];
    const start = parseInt(startByte, 10) || 0;
    const end = parseInt(endByte, 10) || 7;
    const result: CandidateSignal[] = [];

    // Roles to include when using analysis hints
    const interestingRoles = new Set<ByteRole>(["sensor", "value", "unknown"]);

    for (let offset = start; offset <= end; offset++) {
      // If using analysis hints, skip bytes classified as static or counter
      if (useAnalysisHints && analysisResult) {
        const byteStat = analysisResult.byteStats.find((b) => b.byteIndex === offset);
        if (byteStat && !interestingRoles.has(byteStat.role)) continue;
      }

      for (const bits of Array.from(bitLengths).sort((a, b) => a - b)) {
        // For multi-byte signals, check that offset + byte span doesn't exceed end
        const byteSpan = bits / 8;
        if (offset + byteSpan - 1 > end) continue;

        for (const e of Array.from(endianness)) {
          // 8-bit signals are endianness-agnostic — only generate once (as LE)
          if (bits === 8 && e === "be") continue;

          const signalName = `byte_${offset}_${bits}b_${e}`;
          const endiannessLabel = bits > 8 ? (e === "le" ? " LE" : " BE") : "";
          const label = `byte ${offset}, ${bits}-bit${endiannessLabel}`;
          result.push({ label, signalName, offset, bits, endianness: e });
        }
      }
    }
    return result;
  }, [selectedFrameId, startByte, endByte, bitLengths, endianness, useAnalysisHints, analysisResult]);

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
      const rangeLabel = chunk.length === 1
        ? chunk[0].label
        : `${chunk[0].label} … ${chunk[chunk.length - 1].label}`;
      updatePanel(panelId, { title: `Candidates: ${rangeLabel}` });

      // Add each candidate signal
      for (const candidate of chunk) {
        addSignalToPanel(panelId, frameId, candidate.signalName);
      }
    }

    onClose();
  }, [candidates, selectedFrameId, addPanel, updatePanel, addSignalToPanel, onClose]);

  const handleClose = useCallback(() => {
    setStep(1);
    onClose();
  }, [onClose]);

  const toggleCls = (active: boolean) =>
    active
      ? "bg-blue-600 text-white border-blue-600"
      : "bg-transparent text-[color:var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--hover-bg)]";

  return (
    <Dialog isOpen={isOpen} onBackdropClick={handleClose} maxWidth="max-w-md">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        {/* Header */}
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            <Sparkles className={`${iconSm} text-amber-400`} />
            <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
              Candidate Signals
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
              {/* Frame ID */}
              <div>
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  Frame ID
                </label>
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
                <div className="flex gap-2">
                  {[8, 16, 32].map((bits) => (
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
                    onClick={() => toggleEndianness("le")}
                    className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(endianness.has("le"))}`}
                  >
                    Little-endian
                  </button>
                  <button
                    onClick={() => toggleEndianness("be")}
                    className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${toggleCls(endianness.has("be"))}`}
                  >
                    Big-endian
                  </button>
                </div>
              </div>

              {/* Byte range */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                    Start Byte
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={7}
                    value={startByte}
                    onChange={(e) => setStartByte(e.target.value)}
                    className={`${inputSimple} w-full`}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                    End Byte
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={7}
                    value={endByte}
                    onChange={(e) => setEndByte(e.target.value)}
                    className={`${inputSimple} w-full`}
                  />
                </div>
              </div>

              {/* Analysis hints toggle */}
              {analysisResult && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useAnalysisHints}
                    onChange={(e) => setUseAnalysisHints(e.target.checked)}
                    className="rounded border-gray-500"
                  />
                  <span className="text-xs text-[color:var(--text-secondary)]">
                    Use analysis hints (skip static/counter bytes)
                  </span>
                </label>
              )}

              {/* Next button */}
              <button
                onClick={() => setStep(2)}
                disabled={!selectedFrameId || bitLengths.size === 0 || endianness.size === 0}
                className={`${primaryButtonBase} w-full flex items-center justify-center gap-1`}
              >
                Preview
                <ChevronRight className={iconSm} />
              </button>
            </>
          )}

          {step === 2 && (
            <>
              {/* Preview list */}
              <div>
                <p className="text-xs text-[color:var(--text-secondary)] mb-2">
                  {candidates.length} candidate signal{candidates.length !== 1 ? "s" : ""} will be created as line-chart panels (up to 4 per panel):
                </p>
                <div className="max-h-48 overflow-y-auto space-y-0.5 text-xs">
                  {candidates.map((c) => (
                    <div
                      key={c.signalName}
                      className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--bg-primary)]"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: SIGNAL_COLOURS[candidates.indexOf(c) % SIGNAL_COLOURS.length] }}
                      />
                      <span className="text-[color:var(--text-primary)] font-mono">
                        {c.signalName}
                      </span>
                      <span className="text-[color:var(--text-muted)] ml-auto">
                        {c.label}
                      </span>
                    </div>
                  ))}
                </div>
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
                  className="px-4 py-2 text-sm rounded border border-[var(--border-default)] text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={candidates.length === 0}
                  className={`${primaryButtonBase} flex-1 flex items-center justify-center gap-1`}
                >
                  <Sparkles className={iconSm} />
                  Generate {candidates.length} Signal{candidates.length !== 1 ? "s" : ""}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
