// ui/src/dialogs/io-source-picker/CaptureList.tsx
//
// Shows captures available for replay (from completed sessions or CSV imports).

import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, Trash2, Archive, Pencil, Database, Pin, PinOff, UploadCloud } from "lucide-react";
import { iconMd, iconSm, iconXs } from "../../styles/spacing";
import { sectionHeader, caption, captionMuted, textMedium } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { CaptureMetadata } from "../../api/capture";
import { useSessionStore } from "../../stores/sessionStore";
import DeviceBusConfig from "./DeviceBusConfig";
import type { BusMapping } from "../../api/io";
import SendCaptureToBackendDialog from "../SendCaptureToBackendDialog";
import { Button, IconButton } from "../../components/Button";
import { Badge } from "../../components/Badge";

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
  const [uploadCapture, setUploadCapture] = useState<CaptureMetadata | null>(null);
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
          <Button
            onClick={onClearAllCaptures}
            variant="link"
            tone="danger"
            className="text-xs"
          >
            {t("ioSourcePicker.captures.clearAll")}
          </Button>
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
                  <Badge size="sm">{capture.id}</Badge>
                  <Badge size="sm">
                    {t("ioSourcePicker.captures.kindCount", { count: capture.count.toLocaleString(), kind: capture.kind })}
                  </Badge>
                  {isInSession && (
                    <Badge tone="primary" size="sm">{sessionId}</Badge>
                  )}
                  {capture.persistent && (
                    <Badge tone="warning" size="sm">{t("ioSourcePicker.captures.pinned")}</Badge>
                  )}
                </div>
              </div>
              {isThisCaptureSelected && (
                <Check className={`${iconMd} text-[color:var(--status-info-text)] flex-shrink-0`} />
              )}
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  setUploadCapture(capture);
                }}
                size="sm"
                title={t("ioSourcePicker.captures.sendToBackend")}
              >
                <UploadCloud className={iconSm} />
              </IconButton>
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(capture);
                }}
                size="sm"
                title={t("ioSourcePicker.captures.rename")}
              >
                <Pencil className={iconSm} />
              </IconButton>
              <IconButton
                onClick={(e) => togglePersistent(capture, e)}
                tone="warning"
                size="sm"
                pressed={capture.persistent}
                title={capture.persistent ? t("ioSourcePicker.captures.unpinTooltip") : t("ioSourcePicker.captures.pinTooltip")}
              >
                {capture.persistent ? <Pin className={iconSm} /> : <PinOff className={iconSm} />}
              </IconButton>
              {!capture.persistent && (
                <IconButton
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCapture(capture.id);
                  }}
                  tone="danger"
                  size="sm"
                  title={t("ioSourcePicker.captures.delete")}
                >
                  <Trash2 className={iconSm} />
                </IconButton>
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
      {uploadCapture && (
        <SendCaptureToBackendDialog
          isOpen={true}
          onClose={() => setUploadCapture(null)}
          captureId={uploadCapture.id}
          captureName={uploadCapture.name}
        />
      )}
    </div>
  );
}
