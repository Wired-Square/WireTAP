// ui/src/dialogs/io-reader-picker/BufferList.tsx

import { Check, FileText, Trash2, Radio, Plug } from "lucide-react";
import { iconMd, iconSm } from "../../styles/spacing";
import { sectionHeader, caption, textMedium } from "../../styles/typography";
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
  /** Called when user wants to join a streaming session (passes buffer ID) */
  onJoinStreamingBuffer?: (bufferId: string) => void;
};

export default function BufferList({
  buffers,
  selectedBufferId,
  checkedReaderId,
  checkedReaderIds = [],
  onSelectBuffer,
  onDeleteBuffer,
  onClearAllBuffers,
  onJoinStreamingBuffer,
}: Props) {
  if (buffers.length === 0) {
    return null;
  }

  // Check if any buffer can be deleted (not streaming)
  const hasNonStreamingBuffers = buffers.some(b => !b.is_streaming);

  return (
    <div className={borderDivider}>
      <div className="px-4 py-2 bg-[var(--bg-surface)] flex items-center justify-between">
        <span className={sectionHeader}>
          Buffers ({buffers.length})
        </span>
        {buffers.length > 1 && hasNonStreamingBuffers && (
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
          const isStreaming = buffer.is_streaming;
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
                  : isStreaming
                  ? "bg-[var(--status-success-bg)] border border-[color:var(--status-success-border)]"
                  : `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--status-info-text)]`
              }`}
            >
              {isStreaming ? (
                <Radio className={`${iconMd} flex-shrink-0 text-[color:var(--text-green)] animate-pulse`} />
              ) : (
                <FileText
                  className={`${iconMd} flex-shrink-0 ${
                    buffer.buffer_type === "bytes"
                      ? "text-[color:var(--text-purple)]"
                      : "text-[color:var(--status-info-text)]"
                  }`}
                />
              )}
              <div className="flex-1 min-w-0">
                <div className={`${textMedium} truncate`}>
                  {buffer.buffer_type === "bytes" ? "Bytes" : "Frames"}: {buffer.name}
                </div>
                <div className={`${caption} flex items-center gap-2`}>
                  {isStreaming && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--status-success-bg)] text-[color:var(--status-success-text)] font-medium">
                      Live
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--hover-bg)]">
                    {buffer.id}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    isStreaming
                      ? "bg-[var(--status-success-bg)] text-[color:var(--status-success-text)]"
                      : "bg-[var(--hover-bg)]"
                  }`}>
                    {buffer.count.toLocaleString()} {buffer.buffer_type}
                  </span>
                </div>
              </div>
              {isThisBufferSelected && (
                <Check className={`${iconMd} text-[color:var(--status-info-text)] flex-shrink-0`} />
              )}
              {isStreaming && onJoinStreamingBuffer ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onJoinStreamingBuffer(buffer.id);
                  }}
                  className="p-1 rounded transition-colors hover:bg-[var(--status-success-bg)] text-[color:var(--text-green)] hover:text-[color:var(--status-success-text)]"
                  title="Join streaming session"
                >
                  <Plug className={iconSm} />
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isStreaming) {
                      onDeleteBuffer(buffer.id);
                    }
                  }}
                  disabled={isStreaming}
                  className={`p-1 rounded transition-colors ${
                    isStreaming
                      ? "text-[color:var(--text-muted)] cursor-not-allowed"
                      : "hover:bg-[var(--status-danger-bg)] text-[color:var(--text-muted)] hover:text-[color:var(--status-danger-text)]"
                  }`}
                  title={isStreaming ? "Cannot delete streaming buffer" : "Delete buffer"}
                >
                  <Trash2 className={iconSm} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
