// ui/src/dialogs/io-source-picker/CaptureList.tsx
//
// Shows buffers available for replay (from completed sessions or CSV imports).

import React, { useState, useRef, useEffect } from "react";
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
  buffers: CaptureMetadata[];
  selectedCaptureId: string | null;
  checkedSourceId: string | null;
  /** Source IDs selected in multi-bus mode */
  checkedSourceIds?: string[];
  onSelectBuffer: (captureId: string) => void;
  onDeleteBuffer: (captureId: string) => void;
  onClearAllBuffers: () => void;
  /** Called after a buffer is renamed so the parent can refresh */
  onBufferRenamed?: () => void;
  /** Called after a buffer's persistent flag is toggled so the parent can refresh */
  onBufferPersistenceChanged?: () => void;
  /** Map of buffer ID to session ID for buffers owned by active sessions */
  activeSessionBufferMap?: Map<string, string>;
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
  buffers,
  selectedCaptureId,
  checkedSourceId,
  checkedSourceIds = [],
  onSelectBuffer,
  onDeleteBuffer,
  onClearAllBuffers,
  onBufferRenamed,
  onBufferPersistenceChanged,
  activeSessionBufferMap = new Map(),
  busConfig,
  onBusConfigChange,
  isProbing = false,
  probeError = null,
}: Props) {
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

  const startRename = (buffer: CaptureMetadata) => {
    setRenamingId(buffer.id);
    setRenameValue(buffer.name);
  };

  const commitRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await useSessionStore.getState().renameSessionCapture(renamingId, renameValue.trim());
      onBufferRenamed?.();
    } catch (e) {
      console.error("[CaptureList] Failed to rename buffer:", e);
    }
    setRenamingId(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
  };

  const togglePersistent = async (buffer: CaptureMetadata, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await useSessionStore.getState().setSessionCapturePersistent(buffer.id, !buffer.persistent);
      onBufferPersistenceChanged?.();
    } catch (err) {
      console.error("[CaptureList] Failed to toggle persistence:", err);
    }
  };

  if (buffers.length === 0) {
    return null;
  }

  return (
    <div className={borderDivider}>
      <div className="px-4 py-2 bg-[var(--bg-surface)] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Archive className={`${iconXs} text-[color:var(--text-muted)]`} />
          <span className={sectionHeader}>
            Captures
          </span>
          <span className={captionMuted}>({buffers.length})</span>
        </div>
        {buffers.length > 1 && (
          <button
            onClick={onClearAllBuffers}
            className="text-xs text-[color:var(--status-danger-text)] hover:brightness-110"
          >
            Clear All
          </button>
        )}
      </div>
      <div className="p-3 space-y-2">
        {buffers.map((buffer) => {
          const isThisBufferSelected = selectedCaptureId === buffer.id && !checkedSourceId && checkedSourceIds.length === 0;
          const isRenaming = renamingId === buffer.id;
          const sessionId = activeSessionBufferMap.get(buffer.id);
          const isInSession = sessionId !== undefined;
          return (
            <React.Fragment key={buffer.id}>
            <div
              onClick={() => !isRenaming && onSelectBuffer(buffer.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => !isRenaming && e.key === "Enter" && onSelectBuffer(buffer.id)}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors cursor-pointer ${
                isThisBufferSelected
                  ? "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
                  : `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--status-info-text)]`
              }`}
            >
              {isInSession ? (
                <Database className={`${iconMd} flex-shrink-0 text-[color:var(--text-cyan)]`} />
              ) : (
                <FileText
                  className={`${iconMd} flex-shrink-0 ${
                    buffer.kind === "bytes"
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
                    {buffer.name}
                  </div>
                )}
                <div className={`${caption} flex items-center gap-2`}>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {buffer.id}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {buffer.count.toLocaleString()} {buffer.kind}
                  </span>
                  {isInSession && (
                    <span className={badgeSmallInfo}>{sessionId}</span>
                  )}
                  {buffer.persistent && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--status-warning-bg)] text-[color:var(--status-warning-text)]">
                      pinned
                    </span>
                  )}
                </div>
              </div>
              {isThisBufferSelected && (
                <Check className={`${iconMd} text-[color:var(--status-info-text)] flex-shrink-0`} />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(buffer);
                }}
                className="p-1 rounded transition-colors hover:bg-[var(--hover-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                title="Rename buffer"
              >
                <Pencil className={iconSm} />
              </button>
              <button
                onClick={(e) => togglePersistent(buffer, e)}
                className={`p-1 rounded transition-colors hover:bg-[var(--hover-bg)] ${
                  buffer.persistent
                    ? "text-[color:var(--status-warning-text)]"
                    : "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                }`}
                title={buffer.persistent ? "Unpin capture (will be cleared on restart)" : "Pin capture (survives restart)"}
              >
                {buffer.persistent ? <Pin className={iconSm} /> : <PinOff className={iconSm} />}
              </button>
              {!buffer.persistent && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteBuffer(buffer.id);
                  }}
                  className="p-1 rounded transition-colors hover:bg-[var(--status-danger-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--status-danger-text)]"
                  title="Delete capture"
                >
                  <Trash2 className={iconSm} />
                </button>
              )}
            </div>
            {/* Show bus mapping UI when this buffer is selected and has buses */}
            {isThisBufferSelected && busConfig && busConfig.length > 0 && onBusConfigChange ? (
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
