// ui/src/dialogs/io-reader-picker/BufferList.tsx
//
// Shows buffers available for replay (from completed sessions or CSV imports).

import { Check, FileText, Trash2, Archive } from "lucide-react";
import { iconMd, iconSm, iconXs } from "../../styles/spacing";
import { sectionHeader, caption, captionMuted, textMedium } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { BufferMetadata } from "../../api/buffer";

type Props = {
  buffers: BufferMetadata[];
  selectedBufferId: string | null;
  checkedReaderId: string | null;
  /** Reader IDs selected in multi-bus mode */
  checkedReaderIds?: string[];
  onSelectBuffer: (bufferId: string) => void;
  onDeleteBuffer: (bufferId: string) => void;
  onClearAllBuffers: () => void;
};

export default function BufferList({
  buffers,
  selectedBufferId,
  checkedReaderId,
  checkedReaderIds = [],
  onSelectBuffer,
  onDeleteBuffer,
  onClearAllBuffers,
}: Props) {
  if (buffers.length === 0) {
    return null;
  }

  return (
    <div className={borderDivider}>
      <div className="px-4 py-2 bg-[var(--bg-surface)] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Archive className={`${iconXs} text-[color:var(--text-muted)]`} />
          <span className={sectionHeader}>
            Buffers
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
          const isThisBufferSelected = selectedBufferId === buffer.id && !checkedReaderId && checkedReaderIds.length === 0;
          return (
            <div
              key={buffer.id}
              onClick={() => onSelectBuffer(buffer.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && onSelectBuffer(buffer.id)}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors cursor-pointer ${
                isThisBufferSelected
                  ? "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
                  : `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--status-info-text)]`
              }`}
            >
              <FileText
                className={`${iconMd} flex-shrink-0 ${
                  buffer.buffer_type === "bytes"
                    ? "text-[color:var(--text-purple)]"
                    : "text-[color:var(--status-info-text)]"
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className={`${textMedium} truncate`}>
                  {buffer.buffer_type === "bytes" ? "Bytes" : "Frames"}: {buffer.name}
                </div>
                <div className={`${caption} flex items-center gap-2`}>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {buffer.id}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {buffer.count.toLocaleString()} {buffer.buffer_type}
                  </span>
                </div>
              </div>
              {isThisBufferSelected && (
                <Check className={`${iconMd} text-[color:var(--status-info-text)] flex-shrink-0`} />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteBuffer(buffer.id);
                }}
                className="p-1 rounded transition-colors hover:bg-[var(--status-danger-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--status-danger-text)]"
                title="Delete buffer"
              >
                <Trash2 className={iconSm} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
