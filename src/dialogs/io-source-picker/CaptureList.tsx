// ui/src/dialogs/io-source-picker/CaptureList.tsx
//
// Shows captures available for replay (from completed sessions or CSV imports).

import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, Trash2, Archive, Pencil, Database, Pin, PinOff } from "lucide-react";
import { iconMd, iconSm, iconXs } from "../../styles/spacing";
import { badgeSmallInfo } from "../../styles/badgeStyles";
import { sectionHeader, caption, captionMuted, textMedium } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { CaptureMetadata } from "../../api/capture";
import { useSessionStore } from "../../stores/sessionStore";
import DeviceBusConfig from "./DeviceBusConfig";
import type { BusMapping } from "../../api/io";

type Props = {
  captures: CaptureMetadata[];
  selectedCaptureId: string | null;
  checkedSourceId: string | null;
  /** Source IDs selected in multi-bus mode */
  checkedSourceIds?: string[];
  onSelectCapture: (captureId: string) => void;
  onDeleteCapture: (captureId: string) => void;
  onClearAllCaptures: () => void;
  /** Called after a buffer is renamed so the parent can refresh */
  onCaptureRenamed?: () => void;
  /** Called after a buffer's persistent flag is toggled so the parent can refresh */
  onCapturePersistenceChanged?: () => void;
  /** Map of buffer ID to session ID for captures owned by active sessions */
  activeSessionCaptureMap?: Map<string, string>;
  /** Bus mappings for the selected buffer (from shared probe maps) */
  busConfig?: BusMapping[];
  /** Called when buffer bus config changes */
  onBusConfigChange?: (config: BusMapping[]) => void;
  /** Whether the buffer is being probed */
  isProbing?: boolean;
  /** Probe error message */
  probeError?: string | null;
};

export default function CaptureList({
  captures,
  selectedCaptureId,
  checkedSourceId,
  checkedSourceIds = [],
  onSelectCapture,
  onDeleteCapture,
  onClearAllCaptures,
  onCaptureRenamed,
  onCapturePersistenceChanged,
  activeSessionCaptureMap = new Map(),
  busConfig,
  onBusConfigChange,
  isProbing = false,
  probeError = null,
}: Props) {
  const { t } = useTranslation("dialogs");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Focus input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const startRename = (capture: CaptureMetadata) => {
    setRenamingId(capture.id);
    setRenameValue(capture.name);
  };

  const commitRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await useSessionStore.getState().renameSessionCapture(renamingId, renameValue.trim());
      onCaptureRenamed?.();
    } catch (e) {
      console.error("[CaptureList] Failed to rename buffer:", e);
    }
    setRenamingId(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
  };

  const togglePersistent = async (capture: CaptureMetadata, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await useSessionStore.getState().setSessionCapturePersistent(capture.id, !capture.persistent);
      onCapturePersistenceChanged?.();
    } catch (err) {
      console.error("[CaptureList] Failed to toggle persistence:", err);
    }
  };

  if (captures.length === 0) {
    return null;
  }

  return (
    <div className={borderDivider}>
      <div className="px-4 py-2 bg-[var(--bg-surface)] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Archive className={`${iconXs} text-[color:var(--text-muted)]`} />
          <span className={sectionHeader}>
            {t("ioSourcePicker.captures.title")}
          </span>
          <span className={captionMuted}>({captures.length})</span>
        </div>
        {captures.length > 1 && (
          <button
            onClick={onClearAllCaptures}
            className="text-xs text-[color:var(--status-danger-text)] hover:brightness-110"
          >
            {t("ioSourcePicker.captures.clearAll")}
          </button>
        )}
      </div>
      <div className="p-3 space-y-2">
        {captures.map((capture) => {
          const isThisCaptureSelected = selectedCaptureId === capture.id && !checkedSourceId && checkedSourceIds.length === 0;
          const isRenaming = renamingId === capture.id;
          const sessionId = activeSessionCaptureMap.get(capture.id);
          const isInSession = sessionId !== undefined;
          return (
            <React.Fragment key={capture.id}>
            <div
              onClick={() => !isRenaming && onSelectCapture(capture.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => !isRenaming && e.key === "Enter" && onSelectCapture(capture.id)}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors cursor-pointer ${
                isThisCaptureSelected
                  ? "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
                  : `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--status-info-text)]`
              }`}
            >
              {isInSession ? (
                <Database className={`${iconMd} flex-shrink-0 text-[color:var(--text-cyan)]`} />
              ) : (
                <FileText
                  className={`${iconMd} flex-shrink-0 ${
                    capture.kind === "bytes"
                      ? "text-[color:var(--text-purple)]"
                      : "text-[color:var(--status-info-text)]"
                  }`}
                />
              )}
              <div className="flex-1 min-w-0">
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className={`${textMedium} w-full bg-transparent border-b border-[color:var(--status-info-text)] outline-none`}
                  />
                ) : (
                  <div className={`${textMedium} truncate`}>
                    {capture.name}
                  </div>
                )}
                <div className={`${caption} flex items-center gap-2`}>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {capture.id}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {t("ioSourcePicker.captures.kindCount", { count: capture.count.toLocaleString(), kind: capture.kind })}
                  </span>
                  {isInSession && (
                    <span className={badgeSmallInfo}>{sessionId}</span>
                  )}
                  {capture.persistent && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--status-warning-bg)] text-[color:var(--status-warning-text)]">
                      {t("ioSourcePicker.captures.pinned")}
                    </span>
                  )}
                </div>
              </div>
              {isThisCaptureSelected && (
                <Check className={`${iconMd} text-[color:var(--status-info-text)] flex-shrink-0`} />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(capture);
                }}
                className="p-1 rounded transition-colors hover:bg-[var(--hover-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                title={t("ioSourcePicker.captures.rename")}
              >
                <Pencil className={iconSm} />
              </button>
              <button
                onClick={(e) => togglePersistent(capture, e)}
                className={`p-1 rounded transition-colors hover:bg-[var(--hover-bg)] ${
                  capture.persistent
                    ? "text-[color:var(--status-warning-text)]"
                    : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                }`}
                title={capture.persistent ? t("ioSourcePicker.captures.unpinTooltip") : t("ioSourcePicker.captures.pinTooltip")}
              >
                {capture.persistent ? <Pin className={iconSm} /> : <PinOff className={iconSm} />}
              </button>
              {!capture.persistent && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCapture(capture.id);
                  }}
                  className="p-1 rounded transition-colors hover:bg-[var(--status-danger-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--status-danger-text)]"
                  title={t("ioSourcePicker.captures.delete")}
                >
                  <Trash2 className={iconSm} />
                </button>
              )}
            </div>
            {/* Show bus mapping UI when this buffer is selected and has buses */}
            {isThisCaptureSelected && busConfig && busConfig.length > 0 && onBusConfigChange ? (
              <DeviceBusConfig
                deviceInfo={{ bus_count: busConfig.length }}
                isLoading={isProbing}
                error={probeError}
                busConfig={busConfig}
                onBusConfigChange={onBusConfigChange}
                compact
                showOutputBus
              />
            ) : null}
          </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
