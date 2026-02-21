// ui/src/apps/graph/dialogs/PanelConfigDialog.tsx

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { iconLg } from "../../../styles/spacing";
import { bgSurface, borderDivider, hoverLight, inputSimple, selectSimple, primaryButtonBase } from "../../../styles";
import Dialog from "../../../components/Dialog";
import { useGraphStore, getSignalLabel, getConfidenceColour } from "../../../stores/graphStore";
import { useSettings } from "../../../hooks/useSettings";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  panelId: string | null;
}

export default function PanelConfigDialog({ isOpen, onClose, panelId }: Props) {
  const panels = useGraphStore((s) => s.panels);
  const updatePanel = useGraphStore((s) => s.updatePanel);
  const updateSignalColour = useGraphStore((s) => s.updateSignalColour);
  const updateSignalDisplayName = useGraphStore((s) => s.updateSignalDisplayName);
  const { settings } = useSettings();

  const panel = panels.find((p) => p.id === panelId);

  const [title, setTitle] = useState("");
  const [minValue, setMinValue] = useState("0");
  const [maxValue, setMaxValue] = useState("100");
  const [primarySignalIndex, setPrimarySignalIndex] = useState("0");

  // Sync local state when dialog opens (or switches to a different panel)
  useEffect(() => {
    if (panel) {
      setTitle(panel.title);
      setMinValue(String(panel.minValue));
      setMaxValue(String(panel.maxValue));
      setPrimarySignalIndex(String(panel.primarySignalIndex ?? 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

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
            Panel Settings
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
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              className={`${inputSimple} w-full`}
              placeholder="Panel title"
            />
          </div>

          {/* Gauge range (only for gauge panels) */}
          {panel.type === "gauge" && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-1">
                  Min Value
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
                  Max Value
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
                Primary Display Value
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

          {/* Signals — colour + display name */}
          {panel.signals.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-[color:var(--text-secondary)] mb-2">
                Signals
              </label>
              <div className="space-y-2">
                {panel.signals.map((signal) => (
                  <div
                    key={`${signal.frameId}:${signal.signalName}`}
                    className="flex items-center gap-2"
                  >
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
                        title={`Confidence: ${signal.confidence}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Save button */}
          <button
            onClick={handleSave}
            className={`${primaryButtonBase} w-full`}
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}
