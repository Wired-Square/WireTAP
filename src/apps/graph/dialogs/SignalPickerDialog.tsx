// ui/src/apps/graph/dialogs/SignalPickerDialog.tsx

import { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown, Check, Search } from "lucide-react";
import { iconSm } from "../../../styles/spacing";
import { bgSurface, borderDivider, textSecondary, hoverLight, inputSimple, primaryButtonBase } from "../../../styles";
import Dialog from "../../../components/Dialog";
import { useGraphStore } from "../../../stores/graphStore";
import { formatFrameId } from "../../../utils/frameIds";
import { getAllFrameSignals } from "../../../utils/frameSignals";

/** Key used to identify a signal selection. */
function signalKey(frameId: number, signalName: string): string {
  return `${frameId}:${signalName}`;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  panelId: string | null;
  /** When set, the picker is in "replace" mode for the signal at this index */
  replacingSignalIndex?: number | null;
  onReplaceDone?: () => void;
}

export default function SignalPickerDialog({ isOpen, onClose, panelId, replacingSignalIndex, onReplaceDone }: Props) {
  const { t } = useTranslation("graph");
  const frames = useGraphStore((s) => s.frames);
  const panels = useGraphStore((s) => s.panels);
  const addSignalToPanel = useGraphStore((s) => s.addSignalToPanel);
  const removeSignalFromPanel = useGraphStore((s) => s.removeSignalFromPanel);
  const replaceSignalSource = useGraphStore((s) => s.replaceSignalSource);

  const [expandedFrames, setExpandedFrames] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");

  // Buffered selection state — changes only apply on OK
  const [initialKeys, setInitialKeys] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [unitMap, setUnitMap] = useState<Map<string, string | undefined>>(new Map());

  // Replace mode: the signal the user picked as replacement
  const [replacementTarget, setReplacementTarget] = useState<{ frameId: number; signalName: string; unit?: string } | null>(null);

  const panel = panels.find((p) => p.id === panelId);
  const isReplaceMode = replacingSignalIndex !== null && replacingSignalIndex !== undefined;
  const replacingSignal = isReplaceMode && panel ? panel.signals[replacingSignalIndex] : null;

  // Snapshot current signals when dialog opens
  useEffect(() => {
    if (isOpen && panel) {
      const keys = new Set(panel.signals.map((s) => signalKey(s.frameId, s.signalName)));
      setInitialKeys(keys);
      setSelectedKeys(new Set(keys));
      setUnitMap(new Map(panel.signals.map((s) => [signalKey(s.frameId, s.signalName), s.unit])));
      setReplacementTarget(null);
    }
    if (!isOpen) {
      setExpandedFrames(new Set());
      setSearch("");
      setReplacementTarget(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, panelId]);

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

  const handleSignalClick = useCallback((frameId: number, signalName: string, unit?: string) => {
    const key = signalKey(frameId, signalName);
    if (isReplaceMode) {
      setReplacementTarget({ frameId, signalName, unit });
    } else {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      setUnitMap((prev) => {
        const next = new Map(prev);
        next.set(key, unit);
        return next;
      });
    }
  }, [isReplaceMode]);

  const handleOk = useCallback(() => {
    if (!panel) { onClose(); return; }

    if (isReplaceMode && replacingSignal && replacementTarget) {
      replaceSignalSource(
        panel.id,
        replacingSignal.frameId,
        replacingSignal.signalName,
        replacementTarget.frameId,
        replacementTarget.signalName,
        replacementTarget.unit,
      );
      onReplaceDone?.();
    } else {
      // Apply diff: add new, remove old
      for (const key of selectedKeys) {
        if (!initialKeys.has(key)) {
          const [fid, ...rest] = key.split(":");
          const name = rest.join(":");
          addSignalToPanel(panel.id, Number(fid), name, unitMap.get(key));
        }
      }
      for (const key of initialKeys) {
        if (!selectedKeys.has(key)) {
          const [fid, ...rest] = key.split(":");
          const name = rest.join(":");
          removeSignalFromPanel(panel.id, Number(fid), name);
        }
      }
    }
    onClose();
  }, [panel, isReplaceMode, replacingSignal, replacementTarget, selectedKeys, initialKeys, unitMap, addSignalToPanel, removeSignalFromPanel, replaceSignalSource, onReplaceDone, onClose]);

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

  if (!panel) {
    return (
      <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-md">
        <div className={`${bgSurface} rounded-xl shadow-xl p-4`}>
          <p className="text-sm text-[color:var(--text-muted)]">{t("signalPicker.panelNotFound")}</p>
        </div>
      </Dialog>
    );
  }

  const isSignalSelected = (frameId: number, signalName: string) =>
    selectedKeys.has(signalKey(frameId, signalName));

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-md">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        {/* Header */}
        <div className={`p-4 ${borderDivider}`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            {isReplaceMode ? t("signalPicker.titleReplace") : t("signalPicker.titleSelect")}
          </h2>
          {isReplaceMode && replacingSignal && (
            <p className={`text-xs ${textSecondary} mt-0.5`}>
              {t("signalPicker.replacing", { name: replacingSignal.displayName || replacingSignal.signalName })}
            </p>
          )}
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[var(--border-default)]">
          <div className="relative">
            <Search className={`${iconSm} absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]`} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("signalPicker.search")}
              className={`${inputSimple} w-full pl-8`}
              autoFocus
            />
          </div>
        </div>

        {/* Signal list */}
        <div className="max-h-[50vh] overflow-y-auto">
          {sortedFrames.length === 0 ? (
            <div className="p-4 text-sm text-[color:var(--text-muted)]">
              {needle ? t("signalPicker.noMatching") : t("signalPicker.noCatalog")}
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
                        {t("signalPicker.signalsCount", { count: numericSignals.length })}
                      </span>
                      {selectedCount > 0 && !isReplaceMode && (
                        <span className="text-xs text-[color:var(--text-success)] ml-auto">
                          {t("signalPicker.selectedCount", { count: selectedCount })}
                        </span>
                      )}
                    </button>

                    {/* Signal list */}
                    {isExpanded && (
                      <div className="pl-8">
                        {numericSignals.map((signal) => {
                          const selected = isSignalSelected(frameId, signal.name!);
                          const isCurrentReplacement = isReplaceMode && replacementTarget &&
                            replacementTarget.frameId === frameId && replacementTarget.signalName === signal.name;
                          return (
                            <button
                              key={signal.name}
                              onClick={() => handleSignalClick(frameId, signal.name!, signal.unit)}
                              className={`w-full flex items-center gap-2 px-4 py-1.5 text-left ${hoverLight} transition-colors`}
                            >
                              {isReplaceMode ? (
                                // In replace mode, show a radio-style indicator
                                <div
                                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                    isCurrentReplacement
                                      ? "border-purple-500"
                                      : "border-[var(--border-default)]"
                                  }`}
                                >
                                  {isCurrentReplacement && (
                                    <div className="w-2 h-2 rounded-full bg-purple-500" />
                                  )}
                                </div>
                              ) : (
                                // Normal mode: checkbox
                                <div
                                  className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                    selected
                                      ? "bg-blue-500 border-blue-500"
                                      : "border-[var(--border-default)]"
                                  }`}
                                >
                                  {selected && <Check className="w-3 h-3 text-white" />}
                                </div>
                              )}
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

        {/* Footer — OK / Cancel */}
        <div className={`p-4 border-t border-[var(--border-default)] flex justify-end gap-2`}>
          <button
            onClick={onClose}
            className={`px-4 py-2 rounded text-sm font-medium text-[color:var(--text-secondary)] ${hoverLight} transition-colors`}
          >
            {t("signalPicker.cancel")}
          </button>
          <button
            onClick={handleOk}
            className={`${primaryButtonBase} px-4`}
          >
            {t("signalPicker.ok")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
