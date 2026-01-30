// ui/src/dialogs/DecoderInfoDialog.tsx

import { X, FileText, Shuffle, Zap, GitBranch, Clock, Layers } from "lucide-react";
import { iconMd, iconXs, iconLg, flexRowGap2, paddingCardSm } from "../styles/spacing";
import { cardDefault } from "../styles/cardStyles";
import { caption, captionMuted, sectionHeaderText } from "../styles/typography";
import { borderDivider, hoverLight, bgSurface } from "../styles";
import Dialog from "../components/Dialog";
import { useDiscoveryStore } from "../stores/discoveryStore";
import type { DecoderKnowledge, FrameKnowledge, MuxKnowledge } from "../utils/decoderKnowledge";
import { createDefaultSignalsForFrame } from "../utils/decoderKnowledge";
import { formatFrameId } from "../utils/frameIds";
import { formatMs } from "../utils/reportExport";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function DecoderInfoDialog({ isOpen, onClose }: Props) {
  const knowledge = useDiscoveryStore((s) => s.knowledge);

  const frameCount = knowledge.frames.size;
  const muxCount = knowledge.multiplexedFrames.length;
  const burstCount = knowledge.burstFrames.length;
  const multiBusCount = knowledge.multiBusFrames.length;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden max-h-[80vh] flex flex-col`}>
        {/* Header */}
        <div className={`flex items-center gap-3 px-4 py-3 ${borderDivider} flex-shrink-0`}>
          <FileText className={`${iconLg} text-[color:var(--status-info-text)]`} />
          <div className="flex-1">
            <h2 className={sectionHeaderText}>
              Decoder Knowledge
            </h2>
            <p className={caption}>
              Accumulated information about discovered frames
            </p>
          </div>
          <button
            onClick={onClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 overflow-auto space-y-6">
          {/* Meta Section */}
          <MetaSection knowledge={knowledge} />

          {/* Stats Summary */}
          <div className="flex flex-wrap gap-4 text-xs p-3 bg-[var(--bg-surface)] rounded-lg">
            <span className="text-[color:var(--text-muted)]">
              <span className="font-medium text-[color:var(--text-primary)]">{frameCount}</span> frames
            </span>
            {muxCount > 0 && (
              <span className="text-[color:var(--text-orange)]">
                <span className="font-medium">{muxCount}</span> mux
              </span>
            )}
            {burstCount > 0 && (
              <span className="text-[color:var(--text-cyan)]">
                <span className="font-medium">{burstCount}</span> burst
              </span>
            )}
            {multiBusCount > 0 && (
              <span className="text-[color:var(--status-danger-text)]">
                <span className="font-medium">{multiBusCount}</span> multi-bus
              </span>
            )}
            {knowledge.analysisRun && (
              <span className="text-[color:var(--text-green)] ml-auto">
                ✓ Analysis run
              </span>
            )}
            {!knowledge.analysisRun && (
              <span className="text-[color:var(--text-amber)] ml-auto">
                Run analysis for more info
              </span>
            )}
          </div>

          {/* Frames Section */}
          <FramesSection knowledge={knowledge} />
        </div>
      </div>
    </Dialog>
  );
}

// ============================================================================
// Meta Section
// ============================================================================

type MetaSectionProps = {
  knowledge: DecoderKnowledge;
};

function MetaSection({ knowledge }: MetaSectionProps) {
  const { meta } = knowledge;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Layers className={`${iconMd} text-[color:var(--text-purple)]`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          Meta (for [meta] section)
        </h3>
      </div>
      <div className={`${cardDefault} ${paddingCardSm} space-y-2`}>
        <div className="flex items-center justify-between text-xs">
          <span className="text-[color:var(--text-muted)]">default_frame</span>
          <span className="font-mono text-[color:var(--text-primary)]">"{meta.defaultFrame}"</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-[color:var(--text-muted)]">default_endianness</span>
          <span className="font-mono text-[color:var(--text-primary)]">"{meta.defaultEndianness}"</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-[color:var(--text-muted)]">default_interval</span>
          {meta.defaultInterval !== null ? (
            <span className="font-mono text-[color:var(--text-green)]">{meta.defaultInterval}</span>
          ) : (
            <span className="text-[color:var(--text-muted)] italic">not determined</span>
          )}
        </div>
        {meta.defaultInterval !== null && (
          <div className="text-[10px] text-[color:var(--text-muted)] pt-1">
            Based on largest repetition period group ({knowledge.intervalGroups.find(g => g.intervalMs === meta.defaultInterval)?.frameIds.length ?? 0} frames)
          </div>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Frames Section
// ============================================================================

type FramesSectionProps = {
  knowledge: DecoderKnowledge;
};

function FramesSection({ knowledge }: FramesSectionProps) {
  const frames = Array.from(knowledge.frames.values()).sort((a, b) => a.frameId - b.frameId);

  if (frames.length === 0) {
    return (
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Clock className={`${iconMd} text-[color:var(--text-muted)]`} />
          <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
            Frames
          </h3>
        </div>
        <p className={captionMuted}>
          No frames discovered yet.
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Clock className={`${iconMd} text-[color:var(--text-green)]`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          Frames ({frames.length})
        </h3>
      </div>
      <div className="space-y-2">
        {frames.map((frame) => (
          <FrameCard key={frame.frameId} frame={frame} />
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// Frame Card
// ============================================================================

type FrameCardProps = {
  frame: FrameKnowledge;
};

function FrameCard({ frame }: FrameCardProps) {
  const defaultSignals = createDefaultSignalsForFrame(frame.length, frame.mux, frame.signals);
  const allSignals = [...frame.signals, ...defaultSignals];

  return (
    <div className={`${paddingCardSm} ${cardDefault}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className={flexRowGap2}>
          <span className="font-mono font-semibold text-sm text-[color:var(--text-primary)]">
            {formatFrameId(frame.frameId)}
          </span>
          <span className={captionMuted}>
            {frame.length} bytes
          </span>
          {frame.isExtended && (
            <span className="px-1 py-0.5 text-[10px] bg-[var(--status-warning-bg)] text-[color:var(--status-warning-text)] rounded">
              EXT
            </span>
          )}
        </div>
        <div className={flexRowGap2}>
          {frame.intervalMs !== undefined && (
            <span className="text-xs text-[color:var(--text-green)]">
              {formatMs(frame.intervalMs)}
            </span>
          )}
          {frame.bus !== undefined && (
            <span className={captionMuted}>
              Bus {frame.bus}
            </span>
          )}
        </div>
      </div>

      {/* Flags */}
      <div className="flex flex-wrap gap-1 mb-2">
        {frame.mux && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[var(--status-warning-bg)] text-[color:var(--text-orange)] rounded">
            <Shuffle className={iconXs} />
            {frame.mux.isTwoByte ? "2D Mux" : "Mux"}
          </span>
        )}
        {frame.isBurst && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[var(--status-info-bg)] text-[color:var(--text-cyan)] rounded">
            <Zap className={iconXs} />
            Burst
          </span>
        )}
        {frame.isMultiBus && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-[var(--status-danger-bg)] text-[color:var(--status-danger-text)] rounded">
            <GitBranch className={iconXs} />
            Multi-bus
          </span>
        )}
      </div>

      {/* Mux Details */}
      {frame.mux && <MuxDetails mux={frame.mux} />}

      {/* Burst Details */}
      {frame.burstInfo && (
        <div className="text-[10px] text-[color:var(--text-muted)] mb-2">
          Burst: ~{frame.burstInfo.burstCount} frames, {formatMs(frame.burstInfo.burstPeriodMs)} cycle
          {frame.burstInfo.flags.length > 0 && (
            <span className="ml-1 text-[color:var(--text-cyan)]">
              ({frame.burstInfo.flags.join(", ")})
            </span>
          )}
        </div>
      )}

      {/* Multi-bus Details */}
      {frame.multiBusInfo && (
        <div className="text-[10px] text-[color:var(--text-muted)] mb-2">
          Seen on buses: {frame.multiBusInfo.buses.map(b => (
            <span key={b} className="ml-1">
              {b} ({frame.multiBusInfo!.countPerBus[b]}×)
            </span>
          ))}
        </div>
      )}

      {/* Signals */}
      {allSignals.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[color:var(--border-default)]">
          <div className="text-[10px] font-medium text-[color:var(--text-muted)] mb-1">
            Signals
          </div>
          <div className="space-y-1">
            {allSignals.map((signal, idx) => (
              <div
                key={idx}
                className={`flex items-center justify-between text-[10px] ${
                  signal.source === 'default'
                    ? 'text-[color:var(--text-muted)] italic'
                    : 'text-[color:var(--text-secondary)]'
                }`}
              >
                <span className="font-mono">{signal.name}</span>
                <span>
                  bit[{signal.startBit}:{signal.startBit + signal.bitLength - 1}]
                  {signal.source === 'default' && ' (hex)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {frame.notes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[color:var(--border-default)]">
          <div className="text-[10px] font-medium text-[color:var(--text-muted)] mb-1">
            Notes
          </div>
          <ul className="space-y-0.5">
            {frame.notes.map((note, idx) => (
              <li key={idx} className="text-[10px] text-[color:var(--text-secondary)]">
                • {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Mux Details
// ============================================================================

type MuxDetailsProps = {
  mux: MuxKnowledge;
};

function MuxDetails({ mux }: MuxDetailsProps) {
  return (
    <div className="text-[10px] text-[color:var(--text-muted)] mb-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-[color:var(--text-orange)]">
          {mux.isTwoByte ? "Two-byte mux" : "Mux"} selector:
        </span>
        <span className="font-mono">
          {mux.isTwoByte ? "byte[0:1]" : `byte[${mux.selectorByte}]`}
        </span>
        <span>
          (bit[{mux.selectorStartBit}:{mux.selectorStartBit + mux.selectorBitLength - 1}])
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        <span className="text-[color:var(--text-muted)]">Cases:</span>
        {mux.cases.slice(0, 16).map((c) => (
          <span
            key={c}
            className="px-1 py-0.5 bg-[var(--status-warning-bg)] text-[color:var(--text-orange)] rounded font-mono"
          >
            {mux.isTwoByte ? `${Math.floor(c / 256)}.${c % 256}` : c}
          </span>
        ))}
        {mux.cases.length > 16 && (
          <span className="text-[color:var(--text-muted)]">+{mux.cases.length - 16} more</span>
        )}
      </div>
    </div>
  );
}
