// ui/src/apps/graph/dialogs/SignalPickerDialog.tsx

import { useState, useMemo } from "react";
import { X, ChevronRight, ChevronDown, Check, Search } from "lucide-react";
import { iconSm, iconLg } from "../../../styles/spacing";
import { bgSurface, borderDivider, textSecondary, hoverLight, inputSimple } from "../../../styles";
import Dialog from "../../../components/Dialog";
import { useGraphStore } from "../../../stores/graphStore";
import { formatFrameId } from "../../../utils/frameIds";
import { getAllFrameSignals } from "../../../utils/frameSignals";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  panelId: string | null;
}

export default function SignalPickerDialog({ isOpen, onClose, panelId }: Props) {
  const frames = useGraphStore((s) => s.frames);
  const panels = useGraphStore((s) => s.panels);
  const addSignalToPanel = useGraphStore((s) => s.addSignalToPanel);
  const removeSignalFromPanel = useGraphStore((s) => s.removeSignalFromPanel);

  const [expandedFrames, setExpandedFrames] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  const panel = panels.find((p) => p.id === panelId);

  // Sort frames by ID, filter by search query — must be before early return
  const needle = search.toLowerCase();
  const sortedFrames = useMemo(() => {
    const all = Array.from(frames.entries()).sort(([a], [b]) => a - b);
    if (!needle) return all;
    return all.filter(([, frame]) =>
      getAllFrameSignals(frame).some(
        (s) => s.name && s.name.toLowerCase().includes(needle),
      ),
    );
  }, [frames, needle]);

  if (!panel) {
    return (
      <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-md">
        <div className={`${bgSurface} rounded-xl shadow-xl p-4`}>
          <p className="text-sm text-[color:var(--text-muted)]">Panel not found.</p>
        </div>
      </Dialog>
    );
  }

  const isSignalSelected = (frameId: number, signalName: string) =>
    panel.signals.some((s) => s.frameId === frameId && s.signalName === signalName);

  const toggleSignal = (frameId: number, signalName: string, unit?: string) => {
    if (isSignalSelected(frameId, signalName)) {
      removeSignalFromPanel(panel.id, frameId, signalName);
    } else {
      addSignalToPanel(panel.id, frameId, signalName, unit);
    }
  };

  const toggleFrame = (frameId: number) => {
    setExpandedFrames((prev) => {
      const next = new Set(prev);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      return next;
    });
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-md">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        {/* Header */}
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Select Signals
          </h2>
          <button
            onClick={onClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[var(--border-default)]">
          <div className="relative">
            <Search className={`${iconSm} absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]`} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search signals…"
              className={`${inputSimple} w-full pl-8`}
              autoFocus
            />
          </div>
        </div>

        {/* Signal list */}
        <div className="max-h-[50vh] overflow-y-auto">
          {sortedFrames.length === 0 ? (
            <div className="p-4 text-sm text-[color:var(--text-muted)]">
              {needle ? "No matching signals found." : "No catalog loaded. Load a catalog first."}
            </div>
          ) : (
            <div className="py-1">
              {sortedFrames.map(([frameId, frame]) => {
                const isExpanded = expandedFrames.has(frameId) || !!needle;
                const allNumeric = getAllFrameSignals(frame).filter(
                  (s) => s.name && s.format !== "ascii" && s.format !== "utf8" && s.format !== "hex",
                );
                const numericSignals = needle
                  ? allNumeric.filter((s) => s.name!.toLowerCase().includes(needle))
                  : allNumeric;
                if (numericSignals.length === 0) return null;

                const selectedCount = numericSignals.filter((s) =>
                  isSignalSelected(frameId, s.name!),
                ).length;

                return (
                  <div key={frameId}>
                    {/* Frame header */}
                    <button
                      onClick={() => toggleFrame(frameId)}
                      className={`w-full flex items-center gap-2 px-4 py-2 text-left ${hoverLight} transition-colors`}
                    >
                      {isExpanded ? (
                        <ChevronDown className={`${iconSm} text-[color:var(--text-muted)]`} />
                      ) : (
                        <ChevronRight className={`${iconSm} text-[color:var(--text-muted)]`} />
                      )}
                      <span className="text-sm font-mono font-medium text-[color:var(--text-primary)]">
                        {formatFrameId(frameId, "hex")}
                      </span>
                      <span className={`text-xs ${textSecondary}`}>
                        {numericSignals.length} signal{numericSignals.length !== 1 ? "s" : ""}
                      </span>
                      {selectedCount > 0 && (
                        <span className="text-xs text-[color:var(--text-success)] ml-auto">
                          {selectedCount} selected
                        </span>
                      )}
                    </button>

                    {/* Signal list */}
                    {isExpanded && (
                      <div className="pl-8">
                        {numericSignals.map((signal) => {
                          const selected = isSignalSelected(frameId, signal.name!);
                          return (
                            <button
                              key={signal.name}
                              onClick={() => toggleSignal(frameId, signal.name!, signal.unit)}
                              className={`w-full flex items-center gap-2 px-4 py-1.5 text-left ${hoverLight} transition-colors`}
                            >
                              <div
                                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                  selected
                                    ? "bg-blue-500 border-blue-500"
                                    : "border-[var(--border-default)]"
                                }`}
                              >
                                {selected && <Check className="w-3 h-3 text-white" />}
                              </div>
                              <span className="text-sm text-[color:var(--text-primary)]">
                                {signal.name}
                              </span>
                              {signal.unit && (
                                <span className={`text-xs ${textSecondary}`}>
                                  ({signal.unit})
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
