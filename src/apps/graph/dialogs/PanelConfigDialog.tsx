// ui/src/apps/graph/dialogs/PanelConfigDialog.tsx

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X, GripVertical, ArrowLeftRight, Plus, Trash2 } from "lucide-react";
import { iconLg, iconSm } from "../../../styles/spacing";
import { bgSurface, borderDivider, hoverLight, inputSimple, selectSimple, primaryButtonBase } from "../../../styles";
import { iconButtonHover, iconButtonDanger } from "../../../styles/buttonStyles";
import Dialog from "../../../components/Dialog";
import { useGraphStore, getSignalLabel, getConfidenceColour } from "../../../stores/graphStore";
import { useSettings } from "../../../hooks/useSettings";
import { formatFrameId } from "../../../utils/frameIds";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  panelId: string | null;
  onAddSignals?: (panelId: string) => void;
  onReplaceSignal?: (panelId: string, signalIndex: number) => void;
}

export default function PanelConfigDialog({ isOpen, onClose, panelId, onAddSignals, onReplaceSignal }: Props) {
  const { t } = useTranslation("graph");
  const panels = useGraphStore((s) => s.panels);
  const updatePanel = useGraphStore((s) => s.updatePanel);
  const updateSignalColour = useGraphStore((s) => s.updateSignalColour);
  const updateSignalDisplayName = useGraphStore((s) => s.updateSignalDisplayName);
  const updateSignalYAxis = useGraphStore((s) => s.updateSignalYAxis);
  const reorderSignals = useGraphStore((s) => s.reorderSignals);
  const removeSignalFromPanel = useGraphStore((s) => s.removeSignalFromPanel);
  const discoveredFrameIds = useGraphStore((s) => s.discoveredFrameIds);
  const { settings } = useSettings();

  const panel = panels.find((p) => p.id === panelId);

  const [title, setTitle] = useState("");
  const [minValue, setMinValue] = useState("0");
  const [maxValue, setMaxValue] = useState("100");
  const [primarySignalIndex, setPrimarySignalIndex] = useState("0");
  const [targetFrameId, setTargetFrameId] = useState("");
  const [byteCount, setByteCount] = useState("8");
  const [histogramBins, setHistogramBins] = useState("20");

  const sortedFrameIds = useMemo(
    () => Array.from(discoveredFrameIds).sort((a, b) => a - b),
    [discoveredFrameIds],
  );

  // Drag-and-drop state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Sync local state when dialog opens (or switches to a different panel)
  useEffect(() => {
    if (panel) {
      setTitle(panel.title);
      setMinValue(String(panel.minValue));
      setMaxValue(String(panel.maxValue));
      setPrimarySignalIndex(String(panel.primarySignalIndex ?? 0));
      setTargetFrameId(panel.targetFrameId != null ? String(panel.targetFrameId) : "");
      setByteCount(String(panel.byteCount ?? 8));
      setHistogramBins(String(panel.histogramBins ?? 20));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

  // Reset drag state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setDragIndex(null);
      setDragOverIndex(null);
    }
  }, [isOpen]);

  const handleDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (panel && dragIndex !== null && dragIndex !== targetIndex) {
      reorderSignals(panel.id, dragIndex, targetIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [panel, dragIndex, reorderSignals]);

  if (!panel) {
    return null;
  }

  const handleSave = () => {
    // Strip trailing whitespace from display names before saving
    for (const signal of panel.signals) {
      const raw = signal.displayName;
      if (raw && raw !== raw.trimEnd()) {
        updateSignalDisplayName(panel.id, signal.frameId, signal.signalName, raw.trimEnd());
      }
    }

    updatePanel(panel.id, {
      title: title.trim() || panel.title,
      minValue: parseFloat(minValue) || 0,
      maxValue: parseFloat(maxValue) || 100,
      ...(panel.type === "gauge" ? { primarySignalIndex: parseInt(primarySignalIndex, 10) || 0 } : {}),
      ...((panel.type === "flow" || panel.type === "heatmap") ? {
        targetFrameId: targetFrameId ? parseInt(targetFrameId, 10) : undefined,
        byteCount: Math.max(1, Math.min(8, parseInt(byteCount, 10) || 8)),
      } : {}),
      ...(panel.type === "histogram" ? {
        histogramBins: Math.max(5, Math.min(200, parseInt(histogramBins, 10) || 20)),
      } : {}),
    });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    }
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        {/* Header */}
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            {t("panelConfig.title")}
          </h2>
          <button
            onClick={onClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Form */}
        <div className="p-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
              {t("panelConfig.fields.title")}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              className={`${inputSimple} w-full`}
              placeholder={t("panelConfig.fields.titlePlaceholder")}
            />
          </div>

          {/* Gauge range (only for gauge panels) */}
          {panel.type === "gauge" && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  {t("panelConfig.fields.minValue")}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={minValue}
                  onChange={(e) => setMinValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={`${inputSimple} w-full`}
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  {t("panelConfig.fields.maxValue")}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={maxValue}
                  onChange={(e) => setMaxValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className={`${inputSimple} w-full`}
                />
              </div>
            </div>
          )}

          {/* Primary signal selector (gauge with multiple signals) */}
          {panel.type === "gauge" && panel.signals.length > 1 && (
            <div>
              <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                {t("panelConfig.fields.primaryDisplay")}
              </label>
              <select
                value={primarySignalIndex}
                onChange={(e) => setPrimarySignalIndex(e.target.value)}
                className={`${selectSimple} w-full`}
              >
                {panel.signals.map((sig, i) => (
                  <option key={`${sig.frameId}:${sig.signalName}`} value={String(i)}>
                    {getSignalLabel(sig)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Frame ID picker (flow + heatmap panels) */}
          {(panel.type === "flow" || panel.type === "heatmap") && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  {t("panelConfig.fields.frameId")}
                </label>
                <select
                  value={targetFrameId}
                  onChange={(e) => setTargetFrameId(e.target.value)}
                  className={`${selectSimple} w-full`}
                >
                  <option value="">{t("panelConfig.fields.selectFrameId")}</option>
                  {sortedFrameIds.map((id) => (
                    <option key={id} value={String(id)}>
                      {formatFrameId(id)} ({id})
                    </option>
                  ))}
                </select>
                {sortedFrameIds.length === 0 && (
                  <p className="text-[10px] text-[color:var(--text-muted)] mt-1">
                    {t("panelConfig.fields.noFrames")}
                  </p>
                )}
              </div>
              {panel.type === "flow" && (
                <div>
                  <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                    {t("panelConfig.fields.byteCount")}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={byteCount}
                    onChange={(e) => setByteCount(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className={`${inputSimple} w-24`}
                  />
                </div>
              )}
            </div>
          )}

          {/* Histogram bin count */}
          {panel.type === "histogram" && (
            <div>
              <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                {t("panelConfig.fields.binCount")}
              </label>
              <input
                type="number"
                min={5}
                max={200}
                value={histogramBins}
                onChange={(e) => setHistogramBins(e.target.value)}
                onKeyDown={handleKeyDown}
                className={`${inputSimple} w-24`}
              />
            </div>
          )}

          {/* Signals — drag reorder, colour, display name, replace */}
          {panel.type !== "flow" && panel.type !== "heatmap" && panel.signals.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-2">
                {t("panelConfig.fields.signals")}
              </label>
              <div className="space-y-1">
                {panel.signals.map((signal, index) => (
                  <div
                    key={`${signal.frameId}:${signal.signalName}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverIndex(index);
                    }}
                    onDragLeave={() => setDragOverIndex(null)}
                    onDrop={(e) => handleDrop(e, index)}
                    className={`flex items-center gap-2 rounded px-1 py-1 transition-colors ${
                      dragOverIndex === index ? "bg-[var(--hover-bg)]" : ""
                    } ${dragIndex === index ? "opacity-50" : ""}`}
                  >
                    {/* Drag handle */}
                    <div
                      draggable
                      onDragStart={(e) => {
                        setDragIndex(index);
                        e.dataTransfer.effectAllowed = "move";
                        // Use the parent row as drag image
                        const row = e.currentTarget.parentElement;
                        if (row) e.dataTransfer.setDragImage(row, 0, 0);
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setDragOverIndex(null);
                      }}
                      className="cursor-grab active:cursor-grabbing shrink-0"
                      title={t("panelConfig.actions.dragReorder")}
                    >
                      <GripVertical className={`${iconSm} text-[color:var(--text-muted)]`} />
                    </div>

                    {panel.type !== "list" && (
                      <input
                        type="color"
                        value={signal.colour}
                        onChange={(e) =>
                          updateSignalColour(panel.id, signal.frameId, signal.signalName, e.target.value)
                        }
                        className="h-7 w-10 cursor-pointer bg-transparent border border-[color:var(--border-default)] rounded shrink-0"
                      />
                    )}
                    {/* Y-axis toggle (line-chart with 2+ signals) */}
                    {panel.type === "line-chart" && panel.signals.length >= 2 && (
                      <div className="flex shrink-0 rounded border border-[color:var(--border-default)] overflow-hidden">
                        <button
                          onClick={() => updateSignalYAxis(panel.id, signal.frameId, signal.signalName, 'left')}
                          className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                            (signal.yAxis ?? 'left') === 'left'
                              ? 'bg-blue-600 text-white'
                              : 'text-[color:var(--text-muted)] hover:bg-[var(--hover-bg)]'
                          }`}
                          title={t("panelConfig.actions.leftAxis")}
                        >
                          L
                        </button>
                        <button
                          onClick={() => updateSignalYAxis(panel.id, signal.frameId, signal.signalName, 'right')}
                          className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                            signal.yAxis === 'right'
                              ? 'bg-blue-600 text-white'
                              : 'text-[color:var(--text-muted)] hover:bg-[var(--hover-bg)]'
                          }`}
                          title={t("panelConfig.actions.rightAxis")}
                        >
                          R
                        </button>
                      </div>
                    )}
                    <input
                      type="text"
                      value={signal.displayName ?? ""}
                      onChange={(e) =>
                        updateSignalDisplayName(panel.id, signal.frameId, signal.signalName, e.target.value)
                      }
                      placeholder={signal.signalName}
                      className={`${inputSimple} flex-1 text-sm`}
                    />
                    {/* Confidence indicator */}
                    {signal.confidence && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: getConfidenceColour(signal.confidence, settings) }}
                        title={t("panelConfig.actions.confidence", { level: signal.confidence })}
                      />
                    )}
                    {/* Replace signal source */}
                    {onReplaceSignal && (
                      <button
                        onClick={() => onReplaceSignal(panel.id, index)}
                        className={`${iconButtonHover} p-1 shrink-0`}
                        title={t("panelConfig.actions.changeSource")}
                      >
                        <ArrowLeftRight className={iconSm} />
                      </button>
                    )}
                    {/* Remove signal */}
                    <button
                      onClick={() => removeSignalFromPanel(panel.id, signal.frameId, signal.signalName)}
                      className={`${iconButtonDanger} p-1 shrink-0`}
                      title={t("panelConfig.actions.removeSignal")}
                    >
                      <Trash2 className={iconSm} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            {onAddSignals && panel.type !== "flow" && panel.type !== "heatmap" && (
              <button
                onClick={() => onAddSignals(panel.id)}
                className={`${iconButtonHover} flex items-center gap-1.5 px-3 py-2 rounded text-sm text-[color:var(--text-secondary)] border border-[var(--border-default)]`}
                title={t("panelConfig.actions.addSignals")}
              >
                <Plus className={iconSm} />
                {t("panelConfig.actions.addSignalsLabel")}
              </button>
            )}
            <button
              onClick={handleSave}
              className={`${primaryButtonBase} flex-1`}
            >
              {t("panelConfig.actions.save")}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
